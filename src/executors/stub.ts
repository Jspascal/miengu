import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.js';
import type { SandboxIntent } from '../core/events.js';
import type { IdMinter } from '../core/idgen.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorInput,
  ExecutorResult,
  ExecutorStatus,
  ExecutorTelemetry,
  QuotaObservation,
  RawRunRecord,
  RawRunSource,
} from './executor.js';

export const STUB_CAPABILITIES: ExecutorCapabilities = {
  nativeStructuredOutput: false,
  resumableSessions: false,
  sandboxModes: ['read-only', 'workspace-write'],
};

export interface StubScriptStep {
  readonly status: ExecutorStatus;
  readonly telemetry: ExecutorTelemetry;
  readonly writeFiles?: Record<string, string>;
  readonly delayMs?: number;
  readonly finalMessage?: string;
  readonly quota?: QuotaObservation;
}

export interface StubScript {
  readonly steps: readonly StubScriptStep[];
}

const DEFAULT_SCRIPT: StubScript = {
  steps: [
    {
      status: 'completed',
      telemetry: {
        turns: 1,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        wallSeconds: 0,
      },
    },
  ],
};

/**
 * Minimal, mutually-consistent artifacts the default script returns as `finalMessage`, one
 * per role stage.
 *
 * Phase 1's stub needed none of this: its stages had no contracts, so returning nothing was
 * a complete answer. Phase 2 gives every role stage a §4 contract that `runAgentStage`
 * validates on receipt, so a stub that returns `null` cannot advance past `analysis` — and
 * BUILD_PROMPT §11's Phase 1 criterion ("a work item advances through stub stages") would be
 * silently downgraded by Phase 2, which `Phase2 delta.md` forbids.
 *
 * These satisfy both the zod schemas and the mechanical checks in `src/agents/checks.ts`:
 * the ids cross-resolve (`REQ-example-1` is covered by `task-example-1`, which names
 * `component-example-1`), and the suite carries both a `negative: true` and an
 * `asserts_output: true` case. They are deliberately the smallest set that passes, not a
 * realistic plan — a stub asserts that the PIPELINE works, never that the CONTENT is good.
 */
const DEFAULT_ARTIFACTS: Readonly<Record<string, unknown>> = {
  analysis: {
    requirements: [
      {
        req_id: 'REQ-example-1',
        statement: 'the system does X',
        rationale: 'because Y',
        acceptance: ['X is observable'],
        priority: 'must',
        source_span: 'prd:1',
      },
    ],
    ambiguities: [],
    out_of_scope: [],
  },
  architecture: {
    decisions: [
      {
        decision_id: 'decision-example-1',
        title: 'pick an approach',
        choice: 'do it directly',
        alternatives: ['do it indirectly'],
        rationale: 'simplest thing that works',
        req_ids: ['REQ-example-1'],
        supersedes: null,
        blast_radius: 'reversible',
      },
    ],
    components: [
      {
        component_id: 'component-example-1',
        responsibility: 'does X',
        paths: ['src/x.ts'],
        depends_on: [],
      },
    ],
    interfaces: [
      {
        interface_id: 'interface-example-1',
        component_id: 'component-example-1',
        signature: 'doX(): void',
        behaviour: 'performs X',
        req_ids: ['REQ-example-1'],
      },
    ],
  },
  planning: {
    tasks: [
      {
        task_id: 'task-example-1',
        title: 'implement X',
        req_ids: ['REQ-example-1'],
        component_ids: ['component-example-1'],
        expected_paths: ['src/x.ts'],
        depends_on: [],
        definition_of_done: ['X works'],
        estimated_turns: 1,
      },
    ],
  },
  'test-authoring': {
    suite_id: 'suite-example-1',
    cases: [
      {
        test_id: 'test-example-1',
        req_ids: ['REQ-example-1'],
        path: 'test/a.test.ts',
        intent: 'asserts X works',
        negative: false,
        asserts_output: true,
      },
      {
        test_id: 'test-example-2',
        req_ids: ['REQ-example-1'],
        path: 'test/b.test.ts',
        intent: 'asserts X rejects bad input',
        negative: true,
        asserts_output: false,
      },
    ],
  },
  implementation: {
    task_id: 'task-example-1',
    diff_ref: 'diffref',
    files_touched: ['src/x.ts'],
    assumption_ids: [],
    deviations: [],
  },
  review: {
    task_id: 'task-example-1',
    verdict: 'accept',
    findings: [],
    escalate_to: null,
  },
};

/**
 * Files the default script must write for a stage to be coherent. The Test Author's suite
 * names two paths, and `freeze.ts` hashes the bytes actually on disk — so the stub has to
 * put them there or the freeze step has nothing to hash.
 */
const DEFAULT_STAGE_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'test-authoring': {
    'test/a.test.ts': 'test body A\n',
    'test/b.test.ts': 'test body B\n',
  },
};

export class StubExecutor implements Executor, RawRunSource {
  readonly id: ExecutorInstanceId;
  readonly type = 'stub';
  readonly account: AccountId;
  readonly capabilities: ExecutorCapabilities = STUB_CAPABILITIES;
  lastRun: RawRunRecord | null = null;

  private readonly script: StubScript;
  private readonly isDefaultScript: boolean;
  private readonly sandboxIntent: SandboxIntent;
  private readonly clock: Clock;
  private readonly ids: IdMinter;
  private stepIndex = 0;

  constructor(o: {
    id: ExecutorInstanceId;
    account: AccountId;
    script?: StubScript;
    /** Defaults to `workspace-write`: a stub constructed directly by a unit test is not
     *  being asked to model the sandbox, and must keep writing its marker file. The registry
     *  always passes the role's real intent, so a read-only role's stub writes nothing. */
    sandboxIntent?: SandboxIntent;
    clock: Clock;
    ids: IdMinter;
  }) {
    this.id = o.id;
    this.account = o.account;
    this.sandboxIntent = o.sandboxIntent ?? 'workspace-write';
    this.script = o.script ?? DEFAULT_SCRIPT;
    this.isDefaultScript = o.script === undefined;
    this.clock = o.clock;
    this.ids = o.ids;
  }

  /**
   * An explicit script's `finalMessage` always wins — tests that script a stub are asserting
   * something specific and must never be overridden. Only the DEFAULT script falls back to
   * the canned per-stage artifact.
   */
  private defaultFinalMessage(i: ExecutorInput, step: StubScriptStep): string | null {
    if (step.finalMessage !== undefined) {
      return step.finalMessage;
    }
    if (!this.isDefaultScript) {
      return null;
    }
    const artifact = DEFAULT_ARTIFACTS[i.contextPack.stage];
    return artifact === undefined ? null : JSON.stringify(artifact);
  }

  async run(i: ExecutorInput): Promise<ExecutorResult> {
    const startedAt = this.clock.now();
    const sessionId = this.ids.sessionUuid();

    if (i.signal.aborted) {
      const finishedAt = this.clock.now();
      const telemetry: ExecutorTelemetry = {
        turns: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        wallSeconds: 0,
      };
      this.lastRun = {
        commandLine: [],
        exitCode: null,
        signal: null,
        killed: 'none',
        startedAt,
        finishedAt,
        observedTurns: null,
        failureKind: null,
        stderrTail: '',
        sessionId,
        transcriptPath: null,
        rawResult: null,
        finalMessage: null,
        quota: null,
      };
      return { status: 'crashed', telemetry };
    }

    const step = this.script.steps[Math.min(this.stepIndex, this.script.steps.length - 1)];
    this.stepIndex += 1;
    if (step === undefined) {
      throw new Error('StubExecutor: script has no steps');
    }

    let status: ExecutorStatus = step.status;
    if (step.delayMs !== undefined && step.delayMs / 1000 > i.budget.maxWallSeconds) {
      status = 'budget_wall';
    }

    if (step.writeFiles !== undefined) {
      for (const [relativePath, content] of Object.entries(step.writeFiles)) {
        const target = join(i.workdir, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
    }
    // §17.5: a read-only role may not touch the workspace, and the loop's sandbox check
    // enforces it. The Phase 1 marker file predates that check; writing it on an artifact-only
    // stage is a real violation, not a test artefact.
    if (this.isDefaultScript && this.sandboxIntent === 'workspace-write') {
      const target = join(i.workdir, '.miengu-stub', `${i.contextPack.stage}.txt`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `stub stage: ${i.contextPack.stage}\n`, 'utf8');

      const stageFiles = DEFAULT_STAGE_FILES[i.contextPack.stage];
      if (stageFiles !== undefined) {
        for (const [relativePath, content] of Object.entries(stageFiles)) {
          const path = join(i.workdir, relativePath);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, content, 'utf8');
        }
      }
    }

    const finishedAt = this.clock.now();
    this.lastRun = {
      commandLine: [],
      exitCode: 0,
      signal: null,
      killed: 'none',
      startedAt,
      finishedAt,
      observedTurns: step.telemetry.turns,
      failureKind: null,
      stderrTail: '',
      sessionId,
      transcriptPath: null,
      rawResult: null,
      finalMessage: this.defaultFinalMessage(i, step),
      quota: step.quota ?? null,
    };

    return { status, telemetry: step.telemetry };
  }
}
