import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IsoTimestamp } from '../core/clock.js';
import type { IdMinter } from '../core/idgen.js';
import { sha256Canonical } from '../core/hash.js';
import type {
  ArtifactKind,
  EscalationLevel,
  ExecutorType,
  Role,
  SandboxIntent,
  Stage,
  StageFailureReason,
} from '../core/events.js';
import type { AccountId, EventId, Slug, WorkItemId } from '../core/ids.js';
import type { AppendInput } from '../core/log.js';
import { AgentError } from '../errors.js';
import { contractFor } from '../contracts/index.js';
import { toJsonSchema, jsonSchemaSha256 } from '../contracts/toJsonSchema.js';
import type { TaskGraph } from '../contracts/index.js';
import { assemblePack, renderPack } from '../wiki/contextpack.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import type { TieredBody } from '../wiki/packmaterials.js';
import type { ProvenanceTier } from '../core/provenance.js';
import type { ReqId } from '../core/ids.js';
import { loadTemplate, renderPrompt } from './prompts/render.js';
import type { PromptVars } from './prompts/render.js';
import type { CheckContext } from './checks.js';
import type { Executor, ExecutorResult, RawRunSource } from '../executors/executor.js';
import type { CheckpointStateRecord, FrozenTestsState } from '../state/workitem.js';
import type { AssumptionFact } from '../supervisor/assumptions.js';
import type { GatePolicy } from '../supervisor/checkpointPolicy.js';
import { analystModule } from './analyst.js';
import { architectModule } from './architect.js';
import { plannerModule } from './planner.js';
import { testAuthorModule } from './testAuthor.js';
import { coderModule } from './coder.js';
import { reviewerModule } from './reviewer.js';

/**
 * A single append that has already happened, giving the caller back the real event
 * timestamp. Callers (`stages.ts` in this phase, `loop.ts` from item 39 onward) provide
 * this backed by the real `EventLog`; `agent.ts` never touches the log or a clock itself.
 */
export type AppendFn = (
  input: Omit<AppendInput, 'causationId'>,
) => Promise<{ readonly ts: IsoTimestamp; readonly eventId: EventId }>;

/**
 * Raw pack materials this phase has no fetcher for (wiki index generation, file-map
 * construction, source-file selection, PRD loading, diff rendering — all supervisor/CLI
 * plumbing that belongs to items 39/40, out of scope here). The caller supplies whatever
 * it already has; a `null`/empty value simply yields no section of that kind.
 */
export interface RawPackMaterials {
  readonly prd: string | null;
  readonly wikiIndex: readonly TieredBody[];
  readonly existingReqIds: readonly ReqId[];
  readonly priorOutOfScope: readonly string[];
  readonly stackFacts: readonly TieredBody[];
  readonly systemSkeleton: readonly TieredBody[];
  readonly fileMap: readonly TieredBody[];
  readonly testConventions: string | null;
  readonly sourceFiles: readonly { readonly path: string; readonly body: string }[];
  /** Names and intents only (§15.5/§15.6) — never bodies, for the Reviewer. */
  readonly frozenTestList: readonly { readonly testId: string; readonly intent: string }[];
  /** Full bodies, for the Coder's task-scoped subset only. */
  readonly frozenTestBodies: readonly { readonly path: string; readonly body: string }[];
  readonly diff: string | null;
  readonly oracleResults: string | null;
  /** Findings from the selected task only; no raw field exists for other-task findings. */
  readonly currentTaskReviewerFindings: string | null;
  /** Safe escalation facts, reduced further for each upstream recipient. */
  readonly escalationContext: EscalationContext | null;
  /** Scoped, normalized brownfield evidence. Raw attachments never enter packs. */
  readonly brownfieldHistory?: readonly TieredBody[];
  readonly brownfieldFalsification?: readonly TieredBody[];
  /** Phase 6 decision 23: the Architect-only scoped falsifiable claim catalogue. Rendered
   *  into the `brownfield-falsification` kind; the Test Author never receives it. */
  readonly brownfieldFalsifiableClaims?: readonly TieredBody[];
  /** Touched drift only; scope selection completes before pack construction. */
  readonly brownfieldDrift?: readonly TieredBody[];
  readonly assumptions: readonly {
    readonly question: string;
    readonly chosen: string;
    readonly affects: readonly string[];
  }[];
  /** Derived tiers for the artifact-backed sections (binding decision 13). */
  readonly artifactTiers: {
    readonly requirementSet: ProvenanceTier;
    readonly architecturePlan: ProvenanceTier;
    readonly taskGraph: ProvenanceTier;
    readonly testSuiteSpec: ProvenanceTier;
  };
}

export interface EscalationContext {
  readonly category: string;
  readonly affectedRequirementIds: readonly ReqId[];
  readonly summary: string;
  readonly componentIds: readonly string[];
  readonly t1OracleSummaries: readonly string[];
  readonly taskIds: readonly string[];
  readonly currentTaskReviewerFindings: string | null;
}

/** §7's role-specific, body-free escalation disclosure. */
export function renderEscalationContext(
  role: 'analyst' | 'architect' | 'planner',
  context: EscalationContext,
): string {
  const base = {
    category: context.category,
    affected_requirement_ids: context.affectedRequirementIds,
    summary: context.summary,
  };
  if (role === 'analyst') return JSON.stringify(base, null, 2);
  if (role === 'architect') {
    return JSON.stringify({ ...base, component_ids: context.componentIds, t1_oracle_summaries: context.t1OracleSummaries }, null, 2);
  }
  return JSON.stringify({ ...base, task_ids: context.taskIds, current_task_reviewer_findings: context.currentTaskReviewerFindings }, null, 2);
}

/**
 * The minimum a `postStep` needs to mint ids that cannot collide and to apply the declared
 * gate policy. Deliberately NOT `WorkItemState`: a role module has no business reading the
 * routing state machine, and the narrow shape is what keeps that true.
 */
export interface GateContext {
  readonly nextCheckpointSerial: number;
  readonly nextAssumptionSerial: number;
  readonly openAssumptions: readonly AssumptionFact[];
  readonly checkpoints: Readonly<Record<string, CheckpointStateRecord>>;
  readonly policy: GatePolicy;
}

export interface PackBuildInput {
  readonly itemId: WorkItemId;
  readonly checkContext: CheckContext;
  /** The dispatched task (binding decision 6), for the Coder and the Reviewer. */
  readonly task: TaskGraph['tasks'][number] | null;
  readonly activeT1OracleFailure: boolean;
  readonly activeCauseLevel: EscalationLevel | null;
  readonly raw: RawPackMaterials;
}

export interface PostStepInput {
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly artifact: unknown;
  readonly checkContext: CheckContext;
  readonly ids: IdMinter;
  readonly workdir: string;
  readonly frozenTestsDir: string;
  readonly frozenTests: FrozenTestsState | null;
  /**
   * Appends a derived event and returns its real timestamp, for the one post-step
   * (Test Author) that must complete its artifact with a timestamp it is forbidden to
   * fabricate (§15.4: "frozen_at comes from the event, never from a fresh clock read").
   * A post-step that does not need a real timestamp back returns its derived events as
   * plain, unappended drafts in `PostStepResult.derived` instead of calling this.
   */
  readonly appendDerived: AppendFn;
  readonly gate: GateContext;
}

export type PostStepResult =
  | { readonly kind: 'ok'; readonly body: unknown; readonly derived: readonly AppendInput[] }
  | {
      readonly kind: 'failed';
      readonly reason: StageFailureReason;
      readonly detail: string;
      readonly derived: readonly AppendInput[];
    };

export interface RoleModule {
  readonly role: Role;
  readonly stage: Stage;
  readonly artifactKind: ArtifactKind;
  buildCandidates(i: PackBuildInput): readonly ContextPackSection[];
  buildTaskSection(i: PackBuildInput): string;
  validate(artifact: unknown, c: CheckContext, pack: PackBuildInput): readonly string[];
  postStep(i: PostStepInput): Promise<PostStepResult>;
}

export const ROLE_MODULES = {
  analyst: analystModule,
  architect: architectModule,
  planner: plannerModule,
  testAuthor: testAuthorModule,
  coder: coderModule,
  reviewer: reviewerModule,
} satisfies Record<Role, RoleModule>;

/**
 * `AgentOutcome` amends §3.20's literal shape by one field: `derived` also appears on
 * `failed`, not only on `completed`. Without it the Coder's tamper path has nowhere to
 * carry the `TestsTampered` event it must record (binding decision 31) — the literal
 * spec's `failed` variant has no such slot. `StageOutcome` in `stages.ts` is amended in
 * lockstep for the same reason; see the comment there.
 */
export type AgentOutcome =
  | {
      readonly kind: 'completed';
      readonly artifact: { readonly kind: ArtifactKind; readonly sha256: string; readonly body: unknown };
      readonly derived: readonly AppendInput[];
      readonly executorResult: ExecutorResult;
    }
  | {
      readonly kind: 'quota';
      readonly account: AccountId;
      readonly resetsAt: IsoTimestamp | null;
      readonly executorResult: ExecutorResult;
    }
  | {
      readonly kind: 'failed';
      readonly reason: StageFailureReason;
      readonly detail: string;
      readonly derived: readonly AppendInput[];
      readonly executorResult: ExecutorResult;
    };

export interface RunAgentStageInput {
  readonly module: RoleModule;
  readonly executor: Executor & Partial<RawRunSource>;
  readonly executorType: ExecutorType;
  readonly account: AccountId;
  readonly itemId: WorkItemId;
  readonly slug: Slug;
  readonly stage: Stage;
  /** The `StageEntered` attempt this invocation belongs to (never incremented by a retry). */
  readonly attempt: number;
  readonly workdir: string;
  readonly sandboxIntent: SandboxIntent;
  readonly resolved: {
    readonly model: string | null;
    readonly effort: string | null;
    readonly maxTurns: number;
    readonly contextBudgetTokens: number;
  };
  readonly budget: { readonly maxTurns: number; readonly maxWallSeconds: number };
  readonly signal: AbortSignal;
  readonly pack: PackBuildInput;
  readonly checkContext: CheckContext;
  readonly ids: IdMinter;
  readonly frozenTestsDir: string;
  readonly frozenTests: FrozenTestsState | null;
  readonly promptsDir: string;
  readonly schemasDir: string;
  readonly messagesDir: string;
  readonly append: AppendFn;
  readonly gate: GateContext;
}

const NATIVE_CONTRACT_TEXT =
  'Your final message must be a single JSON object matching the schema enforced via ' +
  '--output-schema. Do not restate the schema.';

function appendedContractText(jsonSchemaText: string): string {
  return (
    `${jsonSchemaText}\n\n` +
    'Emit exactly one JSON object matching this schema as your final message, with no ' +
    'prose before or after and no markdown fence.'
  );
}

function buildRetryText(errors: readonly string[]): string {
  return (
    'The previous attempt failed validation. Fix exactly these problems and resubmit:\n' +
    errors.map((e) => `- ${e}`).join('\n')
  );
}

/**
 * §3.20's normative extraction, shared by both providers so §17.6's round-trip
 * equivalence is structural rather than aspirational.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to fence-stripping
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced !== null) {
    const inner = fenced[1] ?? '';
    try {
      return JSON.parse(inner.trim());
    } catch {
      // fall through to brace-scanning
    }
  }

  const start = trimmed.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let idx = start; idx < trimmed.length; idx += 1) {
      const ch = trimmed[idx];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const span = trimmed.slice(start, idx + 1);
          try {
            return JSON.parse(span);
          } catch {
            break;
          }
        }
      }
    }
  }

  throw new AgentError('could not extract a JSON object from the executor final message', {
    textLength: text.length,
  });
}

function zodIssuesToStrings(issues: readonly { path: (string | number)[]; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

async function writeContentAddressed(dir: string, sha256: string, ext: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sha256}${ext}`);
  await writeFile(path, body, 'utf8');
  return path;
}

/**
 * The §9.1b loop, normative order per §3.20. Retries at most once, inside a single
 * `StageEntered` attempt; a second validation failure ends in `{kind:'failed',
 * reason:'validation-failed'}` and never a third invocation.
 */
export async function runAgentStage(i: RunAgentStageInput): Promise<AgentOutcome> {
  const contract = contractFor(i.module.role);
  const jsonSchema = toJsonSchema(contract.schema, contract.title);
  const jsonSchemaText = JSON.stringify(jsonSchema, null, 2);
  const schemaSha256 = jsonSchemaSha256(jsonSchema);

  const candidates = i.module.buildCandidates(i.pack);
  const pack = assemblePack({
    itemId: i.itemId,
    stage: i.stage,
    role: i.module.role,
    candidates,
    budgetTokens: i.resolved.contextBudgetTokens,
    tierFloor: 'T3',
  });
  const packText = renderPack(pack);
  const taskText = i.module.buildTaskSection(i.pack);

  const template = await loadTemplate(i.module.role);

  let outputSchemaPath: string | null = null;
  if (i.executor.capabilities.nativeStructuredOutput) {
    outputSchemaPath = await writeContentAddressed(i.schemasDir, schemaSha256, '.json', jsonSchemaText);
  }
  const contractText = i.executor.capabilities.nativeStructuredOutput
    ? NATIVE_CONTRACT_TEXT
    : appendedContractText(jsonSchemaText);

  let validationAttempt: 1 | 2 = 1;
  let retryText = '';

  for (;;) {
    const vars: PromptVars = {
      PACK: packText,
      CONTRACT: contractText,
      TASK: taskText,
      RETRY: retryText,
    };
    const rendered = renderPrompt(template, vars);
    const promptPath = await writeContentAddressed(i.promptsDir, rendered.sha256, '.txt', rendered.text);

    // Per-invocation, keyed the same way `promptPath` is (§9.1b): the rendered prompt's
    // sha256 already changes between the two possible attempts (the RETRY section differs),
    // so it doubles as a unique final-message filename without a second id source. Only
    // populated for executors that write their final message to a file (nativeStructuredOutput);
    // adapters that read it off their own stream ignore this path by design.
    let finalMessagePath: string | null = null;
    if (i.executor.capabilities.nativeStructuredOutput) {
      await mkdir(i.messagesDir, { recursive: true });
      finalMessagePath = join(i.messagesDir, `${rendered.sha256}.msg.txt`);
    }

    await i.append({
      type: 'ExecutorInvoked',
      data: {
        executor_id: i.executor.id,
        executor_type: i.executorType,
        account: i.account,
        role: i.module.role,
        stage: i.stage,
        workdir: i.workdir,
        sandbox_intent: i.sandboxIntent,
        native_structured_output: i.executor.capabilities.nativeStructuredOutput,
        output_schema_sha256: i.executor.capabilities.nativeStructuredOutput ? schemaSha256 : null,
        prompt_sha256: rendered.sha256,
        prompt_bytes: rendered.bytes,
        prompt_path: promptPath,
        prompt_template_sha256: rendered.templateSha256,
        validation_attempt: validationAttempt,
        context_pack_id: pack.packId,
        context_pack_estimated_tokens: pack.estimatedTokens,
        // Not knowable yet: claude-code mints its session id inside `run()`, and codex only
        // reveals `thread_id` once the stream starts. The real handle is recorded on
        // ExecutorReturned.raw.session_id.
        session_id: null,
        resolved: {
          model: i.resolved.model,
          effort: i.resolved.effort,
          max_turns: i.resolved.maxTurns,
          context_budget_tokens: i.resolved.contextBudgetTokens,
        },
        budget: { max_turns: i.budget.maxTurns, max_wall_seconds: i.budget.maxWallSeconds },
        // Real argv is not known until the process returns (and, for claude-code, a
        // pre-computed argv would not even be truthful — it mints a fresh session id at run
        // time). Recorded on `ExecutorReturned.raw.command_line` instead, once it is known.
        command_line: [],
      },
      actor: { kind: 'supervisor', id: null },
    });

    const executorResult = await i.executor.run({
      workdir: i.workdir,
      prompt: rendered.text,
      contextPack: pack,
      budget: i.budget,
      signal: i.signal,
      outputSchemaPath,
      finalMessagePath,
    });
    const rawRun = i.executor.lastRun ?? null;

    await i.append({
      type: 'ExecutorReturned',
      data: {
        executor_id: i.executor.id,
        executor_type: i.executorType,
        account: i.account,
        stage: i.stage,
        status: executorResult.status,
        telemetry: {
          turns: executorResult.telemetry.turns,
          input_tokens: executorResult.telemetry.inputTokens,
          output_tokens: executorResult.telemetry.outputTokens,
          cache_read_tokens: executorResult.telemetry.cacheReadTokens,
          cache_creation_tokens: executorResult.telemetry.cacheCreationTokens,
          wall_seconds: executorResult.telemetry.wallSeconds,
        },
        // `QuotaObservation` is camelCase (it is an adapter-facing type); the event schema is
        // snake_case, like every other field on this envelope. Map explicitly — passing the
        // adapter object through wholesale is what made this the one unmapped boundary.
        quota:
          rawRun?.quota == null
            ? null
            : {
                account: rawRun.quota.account,
                source: rawRun.quota.source,
                status: rawRun.quota.status,
                utilization: rawRun.quota.utilization,
                window_kind: rawRun.quota.windowKind,
                resets_at: rawRun.quota.resetsAt,
              },
        raw: {
          exit_code: rawRun?.exitCode ?? null,
          signal: rawRun?.signal ?? null,
          killed: rawRun?.killed ?? 'none',
          observed_turns: rawRun?.observedTurns ?? null,
          failure_kind: rawRun?.failureKind ?? null,
          stderr_tail: rawRun?.stderrTail ?? '',
          transcript_path: rawRun?.transcriptPath ?? null,
          final_message_bytes:
            rawRun?.finalMessage !== null && rawRun?.finalMessage !== undefined
              ? Buffer.byteLength(rawRun.finalMessage, 'utf8')
              : null,
          command_line: rawRun?.commandLine ?? [],
          session_id: rawRun?.sessionId ?? null,
        },
      },
      actor: { kind: 'executor', id: i.executor.id },
    });

    if (executorResult.status === 'quota_exhausted') {
      return {
        kind: 'quota',
        account: i.executor.account,
        resetsAt: rawRun?.quota?.resetsAt ?? null,
        executorResult,
      };
    }

    if (executorResult.status !== 'completed') {
      const stderr = [providerError(rawRun?.rawResult), rawRun?.stderrTail.trim()].filter(Boolean).join('\n');
      return {
        kind: 'failed',
        reason: failureReasonForStatus(executorResult.status),
        detail: `executor reported status "${executorResult.status}" (exit ${String(rawRun?.exitCode ?? 'unknown')}, signal ${rawRun?.signal ?? 'none'})${stderr.length > 0 ? `: ${stderr}` : ''}${rawRun?.transcriptPath ? `\nTranscript: ${rawRun.transcriptPath}` : ''}`,
        derived: [],
        executorResult,
      };
    }

    const validated = await validateArtifact(i, rawRun?.finalMessage ?? '', validationAttempt);
    if (!validated.ok) {
      if (validationAttempt === 1) {
        validationAttempt = 2;
        retryText = buildRetryText(validated.errors);
        continue;
      }
      return {
        kind: 'failed',
        reason: 'validation-failed',
        detail: validated.errors.join('\n'),
        derived: [],
        executorResult,
      };
    }

    const artifact = validated.artifact;
    const postStepResult = await i.module.postStep({
      itemId: i.itemId,
      slug: i.slug,
      artifact,
      checkContext: i.checkContext,
      ids: i.ids,
      workdir: i.workdir,
      frozenTestsDir: i.frozenTestsDir,
      frozenTests: i.frozenTests,
      appendDerived: i.append,
      gate: i.gate,
    });

    if (postStepResult.kind === 'failed') {
      return {
        kind: 'failed',
        reason: postStepResult.reason,
        detail: postStepResult.detail,
        derived: postStepResult.derived,
        executorResult,
      };
    }

    return {
      kind: 'completed',
      artifact: {
        kind: i.module.artifactKind,
        sha256: sha256Canonical(postStepResult.body),
        body: postStepResult.body,
      },
      derived: postStepResult.derived,
      executorResult,
    };
  }
}

function failureReasonForStatus(
  status: Exclude<ExecutorResult['status'], 'completed' | 'quota_exhausted'>,
): StageFailureReason {
  switch (status) {
    case 'gave_up':
      return 'executor-gave-up';
    case 'budget_turns':
      return 'budget-turns';
    case 'budget_wall':
      return 'budget-wall';
    case 'crashed':
      return 'executor-crashed';
  }
}

/**
 * Runs extraction + schema parse + mechanical validation for one attempt. Returns `null`
 * on success, or the verbatim failure strings (§3.19/§9.1b: never truncated, never
 * paraphrased) on any of the three failure kinds. Appends `ArtifactValidationFailed` for
 * whichever kind failed.
 */
type ValidationOutcome =
  | { readonly ok: true; readonly artifact: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };

async function validateArtifact(
  i: RunAgentStageInput,
  finalMessage: string,
  validationAttempt: 1 | 2,
): Promise<ValidationOutcome> {
  const contract = contractFor(i.module.role);

  let parsed: unknown;
  try {
    parsed = extractJson(finalMessage);
  } catch (err) {
    const errors = [err instanceof Error ? err.message : String(err)];
    await appendValidationFailed(i, validationAttempt, 'parse', errors);
    return { ok: false, errors };
  }

  const result = contract.schema.safeParse(parsed);
  if (!result.success) {
    const errors = zodIssuesToStrings(result.error.issues);
    await appendValidationFailed(i, validationAttempt, 'schema', errors);
    return { ok: false, errors };
  }

  const mechanicalErrors = i.module.validate(result.data, i.checkContext, i.pack);
  if (mechanicalErrors.length > 0) {
    await appendValidationFailed(i, validationAttempt, 'mechanical', mechanicalErrors);
    return { ok: false, errors: mechanicalErrors };
  }

  return { ok: true, artifact: result.data };
}

async function appendValidationFailed(
  i: RunAgentStageInput,
  validationAttempt: 1 | 2,
  kind: 'parse' | 'schema' | 'mechanical',
  errors: readonly string[],
): Promise<void> {
  await i.append({
    type: 'ArtifactValidationFailed',
    data: {
      stage: i.stage,
      role: i.module.role,
      executor_id: i.executor.id,
      attempt: i.attempt,
      validation_attempt: validationAttempt,
      kind,
      artifact_kind: i.module.artifactKind,
      errors: [...errors],
    },
    actor: { kind: 'supervisor', id: null },
  });
}
import { providerError } from '../executors/output.js';
