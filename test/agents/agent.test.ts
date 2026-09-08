import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractJson, renderEscalationContext, runAgentStage } from '../../src/agents/agent.js';
import type { AppendFn, PackBuildInput, RoleModule } from '../../src/agents/agent.js';
import { checkRequirementSet } from '../../src/agents/checks.js';
import type { CheckContext } from '../../src/agents/checks.js';
import type { RequirementSet } from '../../src/contracts/index.js';
import { toJsonSchema } from '../../src/contracts/toJsonSchema.js';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript, StubScriptStep } from '../../src/executors/stub.js';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorInput,
  ExecutorResult,
  ExecutorStatus,
  RawRunRecord,
  RawRunSource,
} from '../../src/executors/executor.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import {
  AccountIdSchema,
  ExecutorInstanceIdSchema,
  SlugSchema,
  WorkItemIdSchema,
} from '../../src/core/ids.js';
import type { MienguEvent } from '../../src/core/events.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');
const account = AccountIdSchema.parse('test-account');
const executorId = ExecutorInstanceIdSchema.parse('test-exec');
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

const CHECK_CONTEXT: CheckContext = {
  requirementSet: null,
  architecturePlan: null,
  taskGraph: null,
  maxPathsPerTask: 8,
  testDirs: ['test/'],
};

const VALID: RequirementSet = RequirementSetSchema.parse({
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: 'the system does X',
      rationale: 'because Y',
      acceptance: ['X is observable'],
      priority: 'must',
      source_span: null,
    },
  ],
  ambiguities: [],
  out_of_scope: [],
});

describe('renderEscalationContext', () => {
  const context = {
    category: 'task-design',
    affectedRequirementIds: ['REQ-example-1' as never],
    summary: 'task boundary is wrong',
    componentIds: ['component-example-1'],
    t1OracleSummaries: ['typecheck failed'],
    taskIds: ['task-example-1'],
    currentTaskReviewerFindings: 'missing validation',
  };

  it('discloses only the recipient-specific escalation fields', () => {
    expect(renderEscalationContext('analyst', context)).not.toContain('component_ids');
    expect(renderEscalationContext('architect', context)).toContain('t1_oracle_summaries');
    expect(renderEscalationContext('architect', context)).not.toContain('task_ids');
    expect(renderEscalationContext('planner', context)).toContain('current_task_reviewer_findings');
    expect(renderEscalationContext('planner', context)).not.toContain('t1_oracle_summaries');
  });
});

// Fails checkRequirementSet's duplicate-req_id check.
const INVALID = {
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: 'a',
      rationale: 'b',
      acceptance: ['c'],
      priority: 'must',
      source_span: null,
    },
    {
      req_id: 'REQ-example-1',
      statement: 'd',
      rationale: 'e',
      acceptance: ['f'],
      priority: 'must',
      source_span: null,
    },
  ],
  ambiguities: [],
  out_of_scope: [],
};

const FIXTURE_MODULE: RoleModule = {
  role: 'analyst',
  stage: 'analysis',
  artifactKind: 'requirement-set',
  buildCandidates: () => [],
  buildTaskSection: () => 'Produce a RequirementSet from the fixture input.',
  validate: (artifact, c) => checkRequirementSet(artifact as RequirementSet, c),
  postStep: async (i) => ({ kind: 'ok', body: i.artifact, derived: [] }),
};

const PACK: PackBuildInput = {
  itemId,
  checkContext: CHECK_CONTEXT,
  task: null,
  activeT1OracleFailure: false,
  activeCauseLevel: null,
  raw: {
    prd: null,
    wikiIndex: null,
    existingReqIds: [],
    priorOutOfScope: [],
    stackFacts: null,
    systemSkeleton: null,
    fileMap: null,
    testConventions: null,
    sourceFiles: [],
    diff: null,
    oracleResults: null,
    currentTaskReviewerFindings: null,
    escalationContext: null,
    assumptions: [],
  },
};

let promptsDir: string;
let schemasDir: string;
let messagesDir: string;
let workdir: string;
let recorded: MienguEvent['type'][];
let recordedData: unknown[];

function makeAppend(clock = fixedClock(START)): AppendFn {
  return async (input) => {
    recorded.push(input.type);
    recordedData.push(input.data);
    return { ts: clock.now() };
  };
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'miengu-agent-'));
  promptsDir = join(root, 'prompts');
  schemasDir = join(root, 'schemas');
  messagesDir = join(root, 'messages');
  workdir = join(root, 'workdir');
  recorded = [];
  recordedData = [];
});

afterEach(async () => {
  await rm(join(promptsDir, '..'), { recursive: true, force: true });
});

function baseInput(o: { executor: Executor & Partial<RawRunSource>; append?: AppendFn }) {
  return {
    module: FIXTURE_MODULE,
    executor: o.executor,
    executorType: 'stub' as const,
    account,
    itemId,
    slug,
    stage: 'analysis' as const,
    attempt: 1,
    workdir,
    sandboxIntent: 'read-only' as const,
    resolved: { model: null, effort: null, maxTurns: 8, contextBudgetTokens: 40000 },
    budget: { maxTurns: 8, maxWallSeconds: 60 },
    signal: new AbortController().signal,
    pack: PACK,
    checkContext: CHECK_CONTEXT,
    ids: createIdMinter(fixedRng('agent-test')),
    frozenTestsDir: join(workdir, 'frozen-tests'),
    frozenTests: null,
    promptsDir,
    schemasDir,
    messagesDir,
    append: o.append ?? makeAppend(),
  };
}

function telemetry() {
  return {
    turns: 1,
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    wallSeconds: 1,
  };
}

function stub(steps: readonly StubScriptStep[]): StubExecutor {
  const script: StubScript = { steps };
  return new StubExecutor({
    id: executorId,
    account,
    script,
    clock: fixedClock(START),
    ids: createIdMinter(fixedRng('agent-test-exec')),
  });
}

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses a ```json fenced block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parses JSON wrapped in prose', () => {
    expect(extractJson('Sure, here you go:\n{"a":1}\nThat is all.')).toEqual({ a: 1 });
  });

  it('handles a brace inside a string literal', () => {
    expect(extractJson('{"a":"contains } a brace","b":2}')).toEqual({
      a: 'contains } a brace',
      b: 2,
    });
  });

  it('throws on prose alone', () => {
    expect(() => extractJson('no json here at all')).toThrow();
  });
});

describe('runAgentStage — parse-and-retry path (nativeStructuredOutput: false)', () => {
  it('a first-pass-valid artifact produces one ExecutorInvoked and no ArtifactValidationFailed', async () => {
    const executor = stub([{ status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(VALID) }]);
    const outcome = await runAgentStage(baseInput({ executor }));

    expect(outcome.kind).toBe('completed');
    expect(recorded.filter((t) => t === 'ExecutorInvoked')).toHaveLength(1);
    expect(recorded.filter((t) => t === 'ArtifactValidationFailed')).toHaveLength(0);
  });

  it('an invalid-then-valid script produces exactly two ExecutorInvoked, one ArtifactValidationFailed, and completes', async () => {
    const executor = stub([
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(INVALID) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(VALID) },
    ]);
    const outcome = await runAgentStage(baseInput({ executor }));

    expect(outcome.kind).toBe('completed');
    expect(recorded.filter((t) => t === 'ExecutorInvoked')).toHaveLength(2);
    expect(recorded.filter((t) => t === 'ArtifactValidationFailed')).toHaveLength(1);

    const invokedPayloads = recordedData.filter(
      (_, idx) => recorded[idx] === 'ExecutorInvoked',
    ) as { validation_attempt: number }[];
    expect(invokedPayloads.map((p) => p.validation_attempt)).toEqual([1, 2]);
  });

  it('an always-invalid script produces exactly two ExecutorInvoked, two ArtifactValidationFailed, and fails validation-failed — never a third invocation', async () => {
    const executor = stub([
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(INVALID) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(INVALID) },
    ]);
    const outcome = await runAgentStage(baseInput({ executor }));

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.reason).toBe('validation-failed');
    }
    expect(recorded.filter((t) => t === 'ExecutorInvoked')).toHaveLength(2);
    expect(recorded.filter((t) => t === 'ArtifactValidationFailed')).toHaveLength(2);
  });

  it('a quota_exhausted script returns {kind:"quota"} with zero ArtifactValidationFailed and no parse attempt', async () => {
    const executor = stub([{ status: 'quota_exhausted', telemetry: telemetry() }]);
    const outcome = await runAgentStage(baseInput({ executor }));

    expect(outcome.kind).toBe('quota');
    expect(recorded.filter((t) => t === 'ArtifactValidationFailed')).toHaveLength(0);
    expect(recorded.filter((t) => t === 'ExecutorInvoked')).toHaveLength(1);
  });

  it("the second prompt's RETRY contains the first attempt's error strings verbatim", async () => {
    const executor = stub([
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(INVALID) },
      { status: 'completed', telemetry: telemetry(), finalMessage: JSON.stringify(VALID) },
    ]);

    let secondPrompt: string | null = null;
    const originalRun = executor.run.bind(executor);
    let calls = 0;
    executor.run = async (input: ExecutorInput): Promise<ExecutorResult> => {
      calls += 1;
      if (calls === 2) {
        secondPrompt = input.prompt;
      }
      return originalRun(input);
    };

    await runAgentStage(baseInput({ executor }));

    const failurePayload = recordedData.find(
      (_, idx) => recorded[idx] === 'ArtifactValidationFailed',
    ) as { errors: string[] } | undefined;
    expect(failurePayload).toBeDefined();
    for (const errorLine of failurePayload?.errors ?? []) {
      expect(secondPrompt).toContain(errorLine);
    }
  });
});

class FakeNativeExecutor implements Executor, RawRunSource {
  readonly id = executorId;
  readonly type = 'codex' as const;
  readonly account = account;
  readonly capabilities: ExecutorCapabilities = {
    nativeStructuredOutput: true,
    resumableSessions: false,
    sandboxModes: ['read-only', 'workspace-write'],
  };
  lastRun: RawRunRecord | null = null;
  receivedSchemaPath: string | null = null;

  private readonly steps: readonly { status: ExecutorStatus; finalMessage?: string }[];
  private index = 0;

  constructor(steps: readonly { status: ExecutorStatus; finalMessage?: string }[]) {
    this.steps = steps;
  }

  async run(i: ExecutorInput): Promise<ExecutorResult> {
    this.receivedSchemaPath = i.outputSchemaPath;
    const step = this.steps[Math.min(this.index, this.steps.length - 1)];
    this.index += 1;
    if (step === undefined) {
      throw new Error('no steps');
    }
    this.lastRun = {
      commandLine: [],
      exitCode: 0,
      signal: null,
      killed: 'none',
      startedAt: START,
      finishedAt: START,
      observedTurns: 1,
      failureKind: null,
      stderrTail: '',
      sessionId: null,
      transcriptPath: null,
      rawResult: null,
      finalMessage: step.finalMessage ?? null,
      quota: null,
    };
    return { status: step.status, telemetry: telemetry() };
  }
}

describe('runAgentStage — native path (nativeStructuredOutput: true)', () => {
  it('writes the schema file and passes outputSchemaPath, and still validates with zod on receipt', async () => {
    const executor = new FakeNativeExecutor([{ status: 'completed', finalMessage: JSON.stringify(VALID) }]);
    const outcome = await runAgentStage(
      baseInput({ executor: executor as unknown as Executor & Partial<RawRunSource> }),
    );

    expect(outcome.kind).toBe('completed');
    expect(executor.receivedSchemaPath).not.toBeNull();
    const invokedPayloads = recordedData.filter(
      (_, idx) => recorded[idx] === 'ExecutorInvoked',
    ) as { native_structured_output: boolean; output_schema_sha256: string | null }[];
    expect(invokedPayloads[0]?.native_structured_output).toBe(true);
    expect(invokedPayloads[0]?.output_schema_sha256).not.toBeNull();
  });

  it('still rejects a schema-invalid artifact on the native path and retries once', async () => {
    const executor = new FakeNativeExecutor([
      { status: 'completed', finalMessage: JSON.stringify(INVALID) },
      { status: 'completed', finalMessage: JSON.stringify(VALID) },
    ]);
    const outcome = await runAgentStage(
      baseInput({ executor: executor as unknown as Executor & Partial<RawRunSource> }),
    );

    expect(outcome.kind).toBe('completed');
    expect(recorded.filter((t) => t === 'ArtifactValidationFailed')).toHaveLength(1);
  });
});

describe('toJsonSchema smoke — sanity check that the fixture module resolves a real schema', () => {
  it('produces a schema with the expected title', () => {
    const schema = toJsonSchema(RequirementSetSchema, 'RequirementSet');
    expect(schema['title']).toBe('RequirementSet');
  });
});
