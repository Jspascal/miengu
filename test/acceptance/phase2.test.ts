import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

import { runCommand } from '../../src/cli/commands/run.js';
import { EXIT } from '../../src/cli/exit.js';
import { loadConfig } from '../../src/config/load.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { ConfigError, ContextPackError } from '../../src/errors.js';
import { itemPaths, listItemIds, EventLog } from '../../src/core/log.js';
import { ROLES } from '../../src/core/events.js';
import type { Role } from '../../src/core/events.js';
import { sha256Hex } from '../../src/core/hash.js';
import { canonicalJson } from '../../src/core/canonical.js';
import {
  AccountIdSchema,
  ExecutorInstanceIdSchema,
  WorkItemIdSchema,
  RunIdSchema,
} from '../../src/core/ids.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { WorkItemStateSchema } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';
import { stateHash } from '../../src/state/stateHash.js';
import { policyFromConfig, effectiveAttempts } from '../../src/supervisor/nextStage.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import type { ExecutorHandle, ExecutorRegistry, ResolvedRoleSettings } from '../../src/executors/registry.js';
import { runItem } from '../../src/supervisor/loop.js';
import type { RunItemDeps } from '../../src/supervisor/loop.js';
import { projectFromSeq1 } from '../../src/cli/commands/replay.js';
import {
  RequirementSetSchema,
  ArchitecturePlanSchema,
  TaskGraphSchema,
  TestSuiteSpecSchema,
  ImplementationSchema,
  ReviewVerdictSchema,
  contractFor,
} from '../../src/contracts/index.js';
import { toJsonSchema } from '../../src/contracts/toJsonSchema.js';
import { assemblePack, renderPack, ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import type { ContextPackSection } from '../../src/wiki/contextpack.js';
import { loadTemplate, renderPrompt } from '../../src/agents/prompts/render.js';
import type { PromptVars } from '../../src/agents/prompts/render.js';
import * as analystModule from '../../src/agents/analyst.js';

// Binding decision (BUILD_PROMPT §0 / Phase2 delta.md's closing section): every acceptance
// criterion, including the dual-provider criterion 9, runs against fake binaries and the
// stub, never a real vendor call. `MIENGU_HERMETIC=1` for the whole file — asserted for real
// in `beforeAll` below, not merely declared here.
process.env['MIENGU_HERMETIC'] = '1';

const execFileAsync = promisify(execFile);

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const PRD_PATH = fileURLToPath(new URL('../fixtures/prd/phase2.md', import.meta.url));

const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function resolveOnPath(name: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [name]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/** A throwaway target repo: one commit, a `test/` directory, one sample existing test, and
 *  the two files the shared `TEST_SUITE_DRAFT` fixture declares (pre-seeded so the Test
 *  Author's freeze step has real bytes to hash without any fixture ever writing a file). */
async function initTargetRepoWithTests(repo: string): Promise<void> {
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await mkdir(join(repo, 'test'), { recursive: true });
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  await writeFile(join(repo, 'test/existing.test.ts'), "test('existing', () => {});\n", 'utf8');
  await writeFile(join(repo, 'test/a.test.ts'), 'test body A\n', 'utf8');
  await writeFile(join(repo, 'test/b.test.ts'), 'test body B\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'initial']);
}

interface RawEvent {
  readonly seq: number;
  readonly type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
}

async function readRawEvents(storeDir: string, itemId: WorkItemId): Promise<readonly RawEvent[]> {
  const raw = await readFile(itemPaths(storeDir, itemId).eventsFile, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as RawEvent);
}

// ---------------------------------------------------------------------------------------
// Shared contract-valid artifact bodies (same shapes `test/supervisor/loop.test.ts` proved
// contract-valid). One per role, keyed by a per-role `model` sentinel the fixtures look up.
// ---------------------------------------------------------------------------------------

const REQUIREMENT_SET = {
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
};

const ARCHITECTURE_PLAN = {
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
};

const TASK_GRAPH = {
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
};

const TEST_SUITE_DRAFT = {
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
};

const IMPLEMENTATION = {
  task_id: 'task-example-1',
  diff_ref: 'diffref',
  files_touched: ['src/x.ts'],
  assumption_ids: [],
  deviations: [],
};

const REVIEW_VERDICT = {
  task_id: 'task-example-1',
  verdict: 'accept',
  findings: [],
  escalate_to: null,
};

const MODEL_NAMES: Readonly<Record<Role, string>> = {
  analyst: 'analyst-model',
  architect: 'architect-model',
  planner: 'planner-model',
  testAuthor: 'testauthor-model',
  coder: 'coder-model',
  reviewer: 'reviewer-model',
};

const ROLE_MAX_TURNS: Readonly<Record<Role, number>> = {
  analyst: 6,
  architect: 7,
  planner: 8,
  testAuthor: 9,
  coder: 10,
  reviewer: 11,
};

const ROLE_CONTEXT_BUDGET_TOKENS = 40_000;

const ARTIFACT_TABLE: Record<string, unknown> = {
  [MODEL_NAMES.analyst]: REQUIREMENT_SET,
  [MODEL_NAMES.architect]: ARCHITECTURE_PLAN,
  [MODEL_NAMES.planner]: TASK_GRAPH,
  [MODEL_NAMES.testAuthor]: TEST_SUITE_DRAFT,
  [MODEL_NAMES.coder]: IMPLEMENTATION,
  [MODEL_NAMES.reviewer]: REVIEW_VERDICT,
};

async function writeArtifactTableFile(dir: string): Promise<string> {
  const path = join(dir, 'artifact-table.json');
  await writeFile(path, JSON.stringify(ARTIFACT_TABLE), 'utf8');
  return path;
}

/** Builds a two-provider config: every role gets its own instance, `bin` always a fixture,
 *  `model` always the role's fixed sentinel (looked up by the "artifact-by-model" fixture
 *  mode) so the SAME artifact table drives every role regardless of which provider it runs
 *  on. `roleTypes` is the only thing that differs between `dual.yaml` and `swapped.yaml`. */
function providerConfigYaml(o: {
  targetRepo: string;
  accounts: Readonly<Record<string, Record<string, unknown>>>;
  roleAccounts: Readonly<Record<Role, string>>;
  roleTypes: Readonly<Record<Role, 'codex' | 'claude-code'>>;
}): string {
  const executors: Record<string, unknown> = {};
  const tiers: Record<string, number> = {};
  const roles: Record<string, unknown> = {};
  for (const role of ROLES) {
    const type = o.roleTypes[role];
    const instanceId = `${type === 'codex' ? 'cx' : 'cc'}-${role.toLowerCase()}`;
    executors[instanceId] = {
      type,
      account: o.roleAccounts[role],
      bin: type === 'codex' ? FAKE_CODEX : FAKE_CLAUDE,
      model: MODEL_NAMES[role],
    };
    tiers[instanceId] = 1;
    roles[role] = {
      executor: instanceId,
      maxTurns: ROLE_MAX_TURNS[role],
      contextBudgetTokens: ROLE_CONTEXT_BUDGET_TOKENS,
    };
  }
  return stringify({
    target: { repo: o.targetRepo },
    accounts: o.accounts,
    executors,
    tiers,
    roles,
    store: { dir: '.miengu', snapshotEvery: 200 },
  });
}

const DUAL_ROLE_TYPES: Readonly<Record<Role, 'codex' | 'claude-code'>> = {
  analyst: 'codex',
  architect: 'codex',
  planner: 'codex',
  testAuthor: 'codex',
  coder: 'claude-code',
  reviewer: 'codex',
};

const SWAPPED_ROLE_TYPES: Readonly<Record<Role, 'codex' | 'claude-code'>> = {
  analyst: 'claude-code',
  architect: 'claude-code',
  planner: 'claude-code',
  testAuthor: 'claude-code',
  coder: 'codex',
  reviewer: 'claude-code',
};

const DUAL_ROLE_ACCOUNTS: Readonly<Record<Role, string>> = {
  analyst: 'codex-acct',
  architect: 'codex-acct',
  planner: 'codex-acct',
  testAuthor: 'codex-acct',
  coder: 'claude-acct',
  reviewer: 'codex-acct',
};

interface ProviderRunResult {
  readonly workDir: string;
  readonly targetRepo: string;
  readonly storeDir: string;
  readonly itemId: WorkItemId;
  readonly events: readonly RawEvent[];
  readonly exitCode: number;
}

async function runProviderPipeline(o: {
  workDir: string;
  configYaml: string;
  claudeMode: string;
  codexMode: string;
  artifactTablePath: string | null;
}): Promise<ProviderRunResult> {
  const configPath = join(o.workDir, 'miengu.config.yaml');
  await writeFile(configPath, o.configYaml, 'utf8');

  process.env['FAKE_CLAUDE_MODE'] = o.claudeMode;
  process.env['FAKE_CODEX_MODE'] = o.codexMode;
  if (o.artifactTablePath !== null) {
    process.env['FAKE_CLAUDE_ARTIFACT_TABLE'] = o.artifactTablePath;
    process.env['FAKE_CODEX_ARTIFACT_TABLE'] = o.artifactTablePath;
  }
  try {
    const exitCode = await runCommand({ prdFile: PRD_PATH, configPath });
    const storeDir = join(o.workDir, '.miengu');
    const [itemId] = await listItemIds(storeDir);
    if (itemId === undefined) {
      throw new Error('runProviderPipeline: no work item was created');
    }
    const events = await readRawEvents(storeDir, itemId);
    return { workDir: o.workDir, targetRepo: '', storeDir, itemId, events, exitCode };
  } finally {
    delete process.env['FAKE_CLAUDE_MODE'];
    delete process.env['FAKE_CODEX_MODE'];
    delete process.env['FAKE_CLAUDE_ARTIFACT_TABLE'];
    delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
  }
}

describe('Phase 2 acceptance: the ten delta criteria', () => {
  beforeAll(async () => {
    // The guard is real, not decorative: both `claude` and `codex` ARE installed on this
    // machine (docs/002-executor-findings.md), so this proves the risk exists and that our
    // configured `bin` paths are a different, fixture file, not those real binaries.
    const [realClaude, realCodex] = await Promise.all([resolveOnPath('claude'), resolveOnPath('codex')]);
    expect(realClaude).not.toBeNull();
    expect(realCodex).not.toBeNull();
    expect(FAKE_CLAUDE).not.toBe(realClaude);
    expect(FAKE_CODEX).not.toBe(realCodex);
    expect(FAKE_CLAUDE).toContain(join('test', 'fixtures'));
    expect(FAKE_CODEX).toContain(join('test', 'fixtures'));
  });

  // ---------------------------------------------------------------------------------------
  // Criterion 1 — end-to-end artifacts (stub-only run: never burns quota, never spawns a
  // real vendor binary).
  // ---------------------------------------------------------------------------------------
  it('criterion 1: the run produces every contract-valid StageCompleted artifact, TestsFrozen, and a review-verdict', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-c1-target-'));
    const workDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c1-work-'));
    try {
      await initTargetRepoWithTests(targetRepo);
      const configPath = join(workDir, 'miengu.config.yaml');
      await writeFile(
        configPath,
        stringify({
          target: { repo: targetRepo },
          accounts: { 'stub-account': {} },
          executors: Object.fromEntries(
            ROLES.map((r) => [`stub-${r.toLowerCase()}`, { type: 'stub', account: 'stub-account' }]),
          ),
          tiers: Object.fromEntries(ROLES.map((r) => [`stub-${r.toLowerCase()}`, 1])),
          roles: Object.fromEntries(
            ROLES.map((r) => [
              r,
              { executor: `stub-${r.toLowerCase()}`, maxTurns: 8, contextBudgetTokens: 40_000 },
            ]),
          ),
          store: { dir: '.miengu', snapshotEvery: 200 },
        }),
        'utf8',
      );

      const exitCode = await runCommand({ prdFile: PRD_PATH, configPath });
      expect(exitCode).toBe(EXIT.OK);

      const storeDir = join(workDir, '.miengu');
      const [itemId] = await listItemIds(storeDir);
      expect(itemId).toBeDefined();
      if (itemId === undefined) {
        return;
      }
      const events = await readRawEvents(storeDir, itemId);

      const completedArtifacts = events
        .filter((e) => e.type === 'StageCompleted' && e.data.artifact !== null)
        .map((e) => e.data.artifact as { kind: string; sha256: string; body: unknown });
      const kinds = completedArtifacts.map((a) => a.kind);

      for (const expectedKind of [
        'requirement-set',
        'architecture-plan',
        'task-graph',
        'test-suite-spec',
        'implementation',
        'review-verdict',
      ]) {
        expect(kinds).toContain(expectedKind);
      }
      expect(events.some((e) => e.type === 'TestsFrozen')).toBe(true);

      const schemaFor: Record<string, { safeParse: (v: unknown) => { success: boolean } }> = {
        'requirement-set': RequirementSetSchema,
        'architecture-plan': ArchitecturePlanSchema,
        'task-graph': TaskGraphSchema,
        'test-suite-spec': TestSuiteSpecSchema,
        implementation: ImplementationSchema,
        'review-verdict': ReviewVerdictSchema,
      };
      for (const artifact of completedArtifacts) {
        const schema = schemaFor[artifact.kind];
        expect(schema).toBeDefined();
        expect(schema?.safeParse(artifact.body).success).toBe(true);
      }
    } finally {
      await rm(targetRepo, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------------------
  // Shared stub harness for criteria 2, 3 and 5 — a hand-built registry driven directly
  // through `runItem`, exactly `test/supervisor/loop.test.ts`'s pattern, so a single role can
  // be scripted with deliberately invalid content while the rest use contract-valid defaults.
  // ---------------------------------------------------------------------------------------
  const ACCOUNT = AccountIdSchema.parse('stub-account');
  const EXECUTOR_ID_FOR_ROLE: Readonly<Record<Role, string>> = {
    analyst: 'stub-analyst',
    architect: 'stub-architect',
    planner: 'stub-planner',
    testAuthor: 'stub-testauthor',
    coder: 'stub-coder',
    reviewer: 'stub-reviewer',
  };
  const RESOLVED: ResolvedRoleSettings = { model: null, effort: null, maxTurns: 8, contextBudgetTokens: 40_000 };

  function telemetry(turns = 1) {
    return {
      turns,
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      wallSeconds: 1,
    };
  }

  function completedStep(finalMessage: unknown, writeFiles?: Record<string, string>): StubScript {
    return {
      steps: [
        {
          status: 'completed',
          telemetry: telemetry(),
          finalMessage: JSON.stringify(finalMessage),
          ...(writeFiles !== undefined ? { writeFiles } : {}),
        },
      ],
    };
  }

  function happyPathScripts(): Partial<Record<Role, StubScript>> {
    return {
      analyst: completedStep(REQUIREMENT_SET),
      architect: completedStep(ARCHITECTURE_PLAN),
      planner: completedStep(TASK_GRAPH),
      testAuthor: completedStep(TEST_SUITE_DRAFT, {
        'test/a.test.ts': 'test body A\n',
        'test/b.test.ts': 'test body B\n',
      }),
      coder: completedStep(IMPLEMENTATION),
      reviewer: completedStep(REVIEW_VERDICT),
    };
  }

  function makeStubConfig(
    targetRepo: string,
    limitsOverride: Partial<{ maxAttemptsPerStage: number; kOracle: number; kTest: number; kReview: number }> = {},
  ) {
    return MienguConfigSchema.parse({
      target: { repo: targetRepo },
      accounts: { 'stub-account': {} },
      executors: Object.fromEntries(
        ROLES.map((r) => [EXECUTOR_ID_FOR_ROLE[r], { type: 'stub', account: 'stub-account' }]),
      ),
      tiers: Object.fromEntries(ROLES.map((r) => [EXECUTOR_ID_FOR_ROLE[r], 1])),
      roles: Object.fromEntries(
        ROLES.map((r) => [r, { executor: EXECUTOR_ID_FOR_ROLE[r], maxTurns: 8, contextBudgetTokens: 40_000 }]),
      ),
      limits: { maxAttemptsPerStage: 3, kOracle: 3, kTest: 3, kReview: 2, ...limitsOverride },
    });
  }

  function makeStubRegistry(scripts: Partial<Record<Role, StubScript>>, seed: string): ExecutorRegistry {
    const handles = new Map<Role, ExecutorHandle>();
    for (const role of ROLES) {
      const script = scripts[role];
      const executor = new StubExecutor({
        id: ExecutorInstanceIdSchema.parse(EXECUTOR_ID_FOR_ROLE[role]),
        account: ACCOUNT,
        ...(script !== undefined ? { script } : {}),
        clock: fixedClock(START),
        ids: createIdMinter(fixedRng(`${seed}-${role}`)),
      });
      handles.set(role, {
        role,
        executor,
        sandboxIntent: role === 'testAuthor' || role === 'coder' ? 'workspace-write' : 'read-only',
        resolved: RESOLVED,
      });
    }
    return {
      forRole(role: Role): ExecutorHandle {
        const handle = handles.get(role);
        if (handle === undefined) {
          throw new Error(`no stub handle for role "${role}"`);
        }
        return handle;
      },
      accountForRole(): ReturnType<typeof AccountIdSchema.parse> {
        return ACCOUNT;
      },
      get handles(): readonly ExecutorHandle[] {
        return Array.from(handles.values());
      },
    };
  }

  async function makeStubDeps(o: {
    itemId: WorkItemId;
    seed: string;
    executors: ExecutorRegistry;
    config: ReturnType<typeof makeStubConfig>;
    storeDir: string;
    targetRepo: string;
    retainWorkspace?: boolean;
  }): Promise<{ deps: RunItemDeps; log: EventLog }> {
    const runId = RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef');
    const clock = fixedClock(START);
    const ids = createIdMinter(fixedRng(o.seed));
    const { log } = await EventLog.create({
      storeDir: o.storeDir,
      itemId: o.itemId,
      runId,
      clock,
      ids,
      logger: silentLogger,
    });
    await log.append({
      type: 'WorkItemCreated',
      data: {
        title: 'Example item',
        slug: 'example',
        source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
        config_hash: 'deadbeef',
      },
      actor: { kind: 'system', id: null },
      causationId: null,
    });

    const snapshots = createSnapshotStore<WorkItemState>({
      dir: itemPaths(o.storeDir, o.itemId).snapshotsDir,
      itemId: o.itemId,
      projectionVersion: 1,
      hashState: stateHash,
      parseState: (v) => WorkItemStateSchema.parse(v),
    });

    const paths = itemPaths(o.storeDir, o.itemId);
    const deps: RunItemDeps = {
      log,
      snapshots,
      config: o.config,
      policy: policyFromConfig(o.config),
      executors: o.executors,
      workspace: createWorkspaceProvider('worktree'),
      targetRepo: o.targetRepo,
      workspacesDir: paths.workspacesDir,
      promptsDir: join(paths.itemDir, 'prompts'),
      schemasDir: join(paths.itemDir, 'schemas'),
      messagesDir: join(paths.itemDir, 'messages'),
      frozenTestsDir: join(paths.itemDir, 'frozen-tests'),
      clock,
      ids,
      logger: silentLogger,
      signal: new AbortController().signal,
      retainWorkspace: o.retainWorkspace ?? false,
    };
    return { deps, log };
  }

  // ---------------------------------------------------------------------------------------
  // Criterion 2 — Planner mechanical checks.
  // ---------------------------------------------------------------------------------------
  it("criterion 2: the Planner's mechanical checks reject a cyclic plan and an uncovered-must plan", async () => {
    // Two `must`/`should` requirements so a task graph can leave the `must` one uncovered
    // without also tripping the unrelated "references unresolved req_id" check.
    const requirementSet = {
      requirements: [
        { req_id: 'REQ-example-1', statement: 'a', rationale: 'b', acceptance: ['c'], priority: 'must', source_span: null },
        { req_id: 'REQ-example-2', statement: 'd', rationale: 'e', acceptance: ['f'], priority: 'should', source_span: null },
      ],
      ambiguities: [],
      out_of_scope: [],
    };
    const architecturePlan = {
      decisions: [
        {
          decision_id: 'decision-example-1',
          title: 't',
          choice: 'c',
          alternatives: ['alt'],
          rationale: 'r',
          req_ids: ['REQ-example-1', 'REQ-example-2'],
          supersedes: null,
          blast_radius: 'reversible',
        },
      ],
      components: [{ component_id: 'component-example-1', responsibility: 'r', paths: ['src/x.ts'], depends_on: [] }],
      interfaces: [
        {
          interface_id: 'interface-example-1',
          component_id: 'component-example-1',
          signature: 'f(): void',
          behaviour: 'b',
          req_ids: ['REQ-example-1', 'REQ-example-2'],
        },
      ],
    };

    const CYCLIC_TASK_GRAPH = {
      tasks: [
        {
          task_id: 'task-example-1',
          title: 't1',
          req_ids: ['REQ-example-1'],
          component_ids: ['component-example-1'],
          expected_paths: ['src/a.ts'],
          depends_on: ['task-example-2'],
          definition_of_done: ['d'],
          estimated_turns: 1,
        },
        {
          task_id: 'task-example-2',
          title: 't2',
          req_ids: ['REQ-example-2'],
          component_ids: ['component-example-1'],
          expected_paths: ['src/b.ts'],
          depends_on: ['task-example-1'],
          definition_of_done: ['d'],
          estimated_turns: 1,
        },
      ],
    };

    const UNCOVERED_TASK_GRAPH = {
      tasks: [
        {
          task_id: 'task-example-1',
          title: 't1',
          req_ids: ['REQ-example-2'],
          component_ids: ['component-example-1'],
          expected_paths: ['src/a.ts'],
          depends_on: [],
          definition_of_done: ['d'],
          estimated_turns: 1,
        },
      ],
    };

    const scenarios: readonly { readonly id: string; readonly taskGraph: unknown; readonly expectedMessage: string }[] = [
      { id: 'wi-example-crit2a', taskGraph: CYCLIC_TASK_GRAPH, expectedMessage: 'task graph contains a cycle' },
      {
        id: 'wi-example-crit2b',
        taskGraph: UNCOVERED_TASK_GRAPH,
        expectedMessage: "must requirement 'REQ-example-1' is not covered by any task",
      },
    ];

    for (const scenario of scenarios) {
      const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-c2-target-'));
      const storeDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c2-store-'));
      try {
        await initTargetRepoWithTests(targetRepo);
        const itemId = WorkItemIdSchema.parse(scenario.id);
        const scripts: Partial<Record<Role, StubScript>> = {
          analyst: completedStep(requirementSet),
          architect: completedStep(architecturePlan),
          planner: completedStep(scenario.taskGraph),
        };
        const config = makeStubConfig(targetRepo, { maxAttemptsPerStage: 2, kOracle: 2, kTest: 2, kReview: 2 });
        const { deps, log } = await makeStubDeps({
          itemId,
          seed: scenario.id,
          executors: makeStubRegistry(scripts, `${scenario.id}-exec`),
          config,
          storeDir,
          targetRepo,
        });

        try {
          await runItem(deps);
          const events = await log.readAll();

          const mechanicalFailures = events.filter(
            (e) => e.type === 'ArtifactValidationFailed' && e.data.stage === 'planning' && e.data.kind === 'mechanical',
          );
          // maxAttemptsPerStage: 2 grants 2 real attempts at `planning`; each attempt's own
          // internal retry (§9.1b) fails mechanical validation twice, so 2 attempts * 2
          // validation rounds = 4 ArtifactValidationFailed(mechanical) events for the stage.
          expect(mechanicalFailures.length).toBe(4);
          for (const failure of mechanicalFailures) {
            if (failure.type === 'ArtifactValidationFailed') {
              expect(failure.data.errors).toContain(scenario.expectedMessage);
            }
          }

          const invokedForPlanning = events.filter((e) => e.type === 'ExecutorInvoked' && e.data.stage === 'planning');
          expect(invokedForPlanning).toHaveLength(4);

          const stageFailed = events.find((e) => e.type === 'StageFailed' && e.data.stage === 'planning');
          expect(stageFailed).toBeDefined();
          if (stageFailed?.type === 'StageFailed') {
            expect(stageFailed.data.reason).toBe('validation-failed');
          }
        } finally {
          await log.close();
        }
      } finally {
        await rm(targetRepo, { recursive: true, force: true });
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  });

  // ---------------------------------------------------------------------------------------
  // Criterion 3 — test tampering.
  // ---------------------------------------------------------------------------------------
  it("criterion 3: mutating a frozen test between the Coder's invocation and its post-step is detected and restored", async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-c3-target-'));
    const storeDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c3-store-'));
    try {
      await initTargetRepoWithTests(targetRepo);
      const itemId = WorkItemIdSchema.parse('wi-example-crit3a');

      const scripts = happyPathScripts();
      // The Coder's own invocation is the thing that tampers with the frozen test — the
      // observable side effect happens during `executor.run()`, discovered by the Coder's
      // post-step (`verifyFrozenTests`) immediately afterward.
      scripts.coder = completedStep(IMPLEMENTATION, { 'test/a.test.ts': 'TAMPERED CONTENT' });

      const config = makeStubConfig(targetRepo, { maxAttemptsPerStage: 2, kOracle: 2, kTest: 2, kReview: 2 });
      const { deps, log } = await makeStubDeps({
        itemId,
        seed: 'crit3',
        executors: makeStubRegistry(scripts, 'crit3-exec'),
        config,
        storeDir,
        targetRepo,
        retainWorkspace: true,
      });

      const result = await runItem(deps);
      const events = await log.readAll();

      const tampered = events.find((e) => e.type === 'TestsTampered');
      expect(tampered).toBeDefined();
      if (tampered?.type === 'TestsTampered') {
        expect(tampered.data.restored).toBe(true);
        expect(tampered.data.paths).toContain('test/a.test.ts');
      }

      const stageFailed = events.find((e) => e.type === 'StageFailed' && e.data.stage === 'implementation');
      expect(stageFailed).toBeDefined();
      if (stageFailed?.type === 'StageFailed') {
        expect(stageFailed.data.reason).toBe('tests-tampered');
      }

      // The limits above are 2, not 1: the run makes two Coder attempts, both tamper, both
      // are detected and restored, and the item then parks on attempts-exhausted. The
      // restored bytes are observable afterwards because the script's single step repeats
      // identically, so the second attempt restores to the same content as the first — not
      // because there is no second attempt.
      expect(result.outcome).toBe('parked');
      const workdir = join(itemPaths(storeDir, itemId).workspacesDir, 'workspace');
      const restoredContent = await readFile(join(workdir, 'test/a.test.ts'), 'utf8');
      expect(restoredContent).toBe('test body A\n');

      await log.close();
    } finally {
      await rm(targetRepo, { recursive: true, force: true });
      await rm(storeDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------------------
  // Criterion 4 — context isolation (the exhaustive per-role version lives in item 30's
  // `test/wiki/contextpack.test.ts`; this is the end-to-end confirmation named by item 43).
  // ---------------------------------------------------------------------------------------
  it('criterion 4: the assembled pack excludes every item in its role\'s omits list, and offering one throws', () => {
    const itemId = WorkItemIdSchema.parse('wi-example-crit4a');
    for (const role of ROLES) {
      const policy = ROLE_PACK_POLICY[role];
      const stage = contractFor(role).stage;

      const includedSections: ContextPackSection[] = policy.includes.map((kind) => ({
        kind,
        heading: kind,
        body: 'content',
        tier: 'T1',
        sourceEventId: null,
      }));
      const pack = assemblePack({
        itemId,
        stage,
        role,
        candidates: includedSections,
        budgetTokens: 1_000_000,
        tierFloor: 'T3',
      });
      for (const section of pack.sections) {
        expect(policy.omits).not.toContain(section.kind);
      }

      const omittedKind = policy.omits[0];
      expect(omittedKind).toBeDefined();
      if (omittedKind === undefined) {
        continue;
      }
      const offendingSection: ContextPackSection = {
        kind: omittedKind,
        heading: omittedKind,
        body: 'content',
        tier: 'T1',
        sourceEventId: null,
      };
      expect(() =>
        assemblePack({
          itemId,
          stage,
          role,
          candidates: [offendingSection],
          budgetTokens: 1_000_000,
          tierFloor: 'T3',
        }),
      ).toThrow(ContextPackError);
    }
  });

  // ---------------------------------------------------------------------------------------
  // Criterion 5 — Test Author suite-level checks.
  // ---------------------------------------------------------------------------------------
  it('criterion 5: a suite with no negative case and a suite with no asserts_output case are each rejected', async () => {
    const NO_NEGATIVE_DRAFT = {
      suite_id: 'suite-example-1',
      cases: [
        { test_id: 'test-example-1', req_ids: ['REQ-example-1'], path: 'test/a.test.ts', intent: 'i', negative: false, asserts_output: true },
      ],
    };
    const NO_ASSERTS_OUTPUT_DRAFT = {
      suite_id: 'suite-example-1',
      cases: [
        { test_id: 'test-example-1', req_ids: ['REQ-example-1'], path: 'test/a.test.ts', intent: 'i', negative: true, asserts_output: false },
      ],
    };

    const scenarios: readonly { readonly id: string; readonly draft: unknown; readonly expectedMessage: string }[] = [
      { id: 'wi-example-crit5a', draft: NO_NEGATIVE_DRAFT, expectedMessage: 'no test case has negative: true' },
      { id: 'wi-example-crit5b', draft: NO_ASSERTS_OUTPUT_DRAFT, expectedMessage: 'no test case has asserts_output: true' },
    ];

    for (const scenario of scenarios) {
      const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-c5-target-'));
      const storeDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c5-store-'));
      try {
        await initTargetRepoWithTests(targetRepo);
        const itemId = WorkItemIdSchema.parse(scenario.id);
        const scripts: Partial<Record<Role, StubScript>> = {
          analyst: completedStep(REQUIREMENT_SET),
          architect: completedStep(ARCHITECTURE_PLAN),
          planner: completedStep(TASK_GRAPH),
          testAuthor: completedStep(scenario.draft, { 'test/a.test.ts': 'test body A\n' }),
        };
        const config = makeStubConfig(targetRepo, { maxAttemptsPerStage: 2, kOracle: 2, kTest: 2, kReview: 2 });
        const { deps, log } = await makeStubDeps({
          itemId,
          seed: scenario.id,
          executors: makeStubRegistry(scripts, `${scenario.id}-exec`),
          config,
          storeDir,
          targetRepo,
        });

        await runItem(deps);
        const events = await log.readAll();

        const failures = events.filter(
          (e) => e.type === 'ArtifactValidationFailed' && e.data.stage === 'test-authoring' && e.data.kind === 'mechanical',
        );
        expect(failures.length).toBeGreaterThan(0);
        for (const failure of failures) {
          if (failure.type === 'ArtifactValidationFailed') {
            expect(failure.data.errors).toContain(scenario.expectedMessage);
          }
        }

        const stageFailed = events.find((e) => e.type === 'StageFailed' && e.data.stage === 'test-authoring');
        expect(stageFailed).toBeDefined();
        if (stageFailed?.type === 'StageFailed') {
          expect(stageFailed.data.reason).toBe('validation-failed');
        }

        await log.close();
      } finally {
        await rm(targetRepo, { recursive: true, force: true });
        await rm(storeDir, { recursive: true, force: true });
      }
    }
  });

  // ---------------------------------------------------------------------------------------
  // Criteria 6, 7, 8 (first half) and 9 — the two real-executor pipelines, run once and
  // shared, because both are expensive (real subprocess spawns) and both need the exact
  // same fixture-driven, contract-valid, dual-provider run.
  // ---------------------------------------------------------------------------------------
  describe('real dual-provider runs', () => {
    let dualTargetRepo = '';
    let dualWorkDir = '';
    let swappedTargetRepo = '';
    let swappedWorkDir = '';
    let dual: ProviderRunResult;
    let swapped: ProviderRunResult;

    beforeAll(async () => {
      dualTargetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-dual-target-'));
      dualWorkDir = await mkdtemp(join(tmpdir(), 'miengu-p2-dual-work-'));
      await initTargetRepoWithTests(dualTargetRepo);
      const dualTablePath = await writeArtifactTableFile(dualWorkDir);
      const dualYaml = providerConfigYaml({
        targetRepo: dualTargetRepo,
        accounts: { 'codex-acct': {}, 'claude-acct': {} },
        roleAccounts: DUAL_ROLE_ACCOUNTS,
        roleTypes: DUAL_ROLE_TYPES,
      });
      dual = await runProviderPipeline({
        workDir: dualWorkDir,
        configYaml: dualYaml,
        claudeMode: 'artifact-by-model',
        codexMode: 'artifact-by-model',
        artifactTablePath: dualTablePath,
      });

      swappedTargetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-swap-target-'));
      swappedWorkDir = await mkdtemp(join(tmpdir(), 'miengu-p2-swap-work-'));
      await initTargetRepoWithTests(swappedTargetRepo);
      const swappedTablePath = await writeArtifactTableFile(swappedWorkDir);
      const swappedYaml = providerConfigYaml({
        targetRepo: swappedTargetRepo,
        accounts: { 'codex-acct': {}, 'claude-acct': {} },
        roleAccounts: DUAL_ROLE_ACCOUNTS,
        roleTypes: SWAPPED_ROLE_TYPES,
      });
      swapped = await runProviderPipeline({
        workDir: swappedWorkDir,
        configYaml: swappedYaml,
        claudeMode: 'artifact-by-model',
        codexMode: 'artifact-by-model',
        artifactTablePath: swappedTablePath,
      });
    }, 120_000);

    afterAll(async () => {
      await Promise.all([
        rm(dualTargetRepo, { recursive: true, force: true }),
        rm(dualWorkDir, { recursive: true, force: true }),
        rm(swappedTargetRepo, { recursive: true, force: true }),
        rm(swappedWorkDir, { recursive: true, force: true }),
      ]);
    });

    // Criterion 6 — prompt recoverability.
    it('criterion 6: every ExecutorInvoked has a recoverable prompt, proven byte-exact for one exemplar path', async () => {
      for (const run of [dual, swapped]) {
        const invoked = run.events.filter((e) => e.type === 'ExecutorInvoked');
        expect(invoked.length).toBeGreaterThan(0);
        for (const e of invoked) {
          expect(e.data.prompt_path).not.toBeNull();
          const content = await readFile(e.data.prompt_path as string, 'utf8');
          expect(sha256Hex(content)).toBe(e.data.prompt_sha256);
        }
      }

      // Full, independent re-rendering for one exemplar: swapped.yaml's analyst runs on
      // claude-code (the parse-and-retry path), on the very first invocation of the item —
      // the one case whose raw pack materials are knowable in advance without reaching into
      // `loop.ts`'s private `buildRawPackMaterials`.
      const analystInvoked = swapped.events.find((e) => e.type === 'ExecutorInvoked' && e.data.role === 'analyst');
      expect(analystInvoked).toBeDefined();
      if (analystInvoked === undefined) {
        return;
      }
      expect(analystInvoked.data.native_structured_output).toBe(false);
      expect(analystInvoked.data.validation_attempt).toBe(1);

      const template = await loadTemplate('analyst');
      expect(template.sha256).toBe(analystInvoked.data.prompt_template_sha256);

      const contract = contractFor('analyst');
      const jsonSchema = toJsonSchema(contract.schema, contract.title);
      const jsonSchemaText = JSON.stringify(jsonSchema, null, 2);
      const appendedContractText =
        `${jsonSchemaText}\n\n` +
        'Emit exactly one JSON object matching this schema as your final message, with no ' +
        'prose before or after and no markdown fence.';

      const prdText = await readFile(PRD_PATH, 'utf8');
      const candidates = analystModule.buildCandidates({
        itemId: swapped.itemId,
        checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: ['test/'] },
        task: null,
        raw: {
          prd: prdText,
          wikiIndex: null,
          existingReqIds: [],
          priorOutOfScope: [],
          stackFacts: null,
          systemSkeleton: null,
          fileMap: null,
          testConventions: 'Tests live under: test/',
          sourceFiles: [],
          frozenTestList: [],
          frozenTestBodies: [],
          diff: null,
          oracleResults: null,
          currentTaskReviewerFindings: null,
          escalationContext: null,
          assumptions: [],
        },
      });
      const pack = assemblePack({
        itemId: swapped.itemId,
        stage: 'analysis',
        role: 'analyst',
        candidates,
        budgetTokens: ROLE_CONTEXT_BUDGET_TOKENS,
        tierFloor: 'T3',
      });
      const packText = renderPack(pack);
      const taskText = analystModule.buildTaskSection();

      const vars: PromptVars = { PACK: packText, CONTRACT: appendedContractText, TASK: taskText, RETRY: '' };
      const rendered = renderPrompt(template, vars);
      expect(rendered.sha256).toBe(analystInvoked.data.prompt_sha256);
    });

    // Criterion 7 — both enforcement paths, same contract.
    //

    it('criterion 7: the RequirementSet contract is satisfied via --output-schema (codex) and via parse-and-retry (claude), byte-identical', () => {
      const dualAnalystInvoked = dual.events.find((e) => e.type === 'ExecutorInvoked' && e.data.role === 'analyst');
      const swappedAnalystInvoked = swapped.events.find((e) => e.type === 'ExecutorInvoked' && e.data.role === 'analyst');
      expect(dualAnalystInvoked).toBeDefined();
      expect(swappedAnalystInvoked).toBeDefined();
      if (dualAnalystInvoked === undefined || swappedAnalystInvoked === undefined) {
        return;
      }

      // dual.yaml puts codex on the analyst -> native structured output.
      expect(dualAnalystInvoked.data.native_structured_output).toBe(true);
      expect(dualAnalystInvoked.data.output_schema_sha256).not.toBeNull();

      // swapped.yaml puts claude-code on the analyst -> parse-and-retry.
      expect(swappedAnalystInvoked.data.native_structured_output).toBe(false);
      expect(swappedAnalystInvoked.data.output_schema_sha256).toBeNull();

      const dualBody = dual.events.find((e) => e.type === 'StageCompleted' && e.data.stage === 'analysis')?.data
        .artifact?.body;
      const swappedBody = swapped.events.find((e) => e.type === 'StageCompleted' && e.data.stage === 'analysis')?.data
        .artifact?.body;
      expect(dualBody).toBeDefined();
      expect(swappedBody).toBeDefined();
      expect(RequirementSetSchema.safeParse(dualBody).success).toBe(true);
      expect(RequirementSetSchema.safeParse(swappedBody).success).toBe(true);
      expect(canonicalJson(dualBody)).toBe(canonicalJson(swappedBody));
    });

    // Criterion 8 — resolved settings (works despite the codex defect above: `ExecutorInvoked`
    // is appended, with `resolved` populated, at invocation time, regardless of whether the
    // stage later succeeds or fails) plus the tier-check startup rejection (independent of
    // any executor run).
    it('criterion 8: every ExecutorInvoked carries resolved settings matching config, and reviewer tier < coder tier is rejected at startup', async () => {
      for (const run of [dual, swapped]) {
        const invoked = run.events.filter((e) => e.type === 'ExecutorInvoked');
        expect(invoked.length).toBeGreaterThan(0);
        for (const e of invoked) {
          const role = e.data.role as Role;
          expect(e.data.executor_id).toBeTruthy();
          expect(['codex', 'claude-code']).toContain(e.data.executor_type);
          expect(e.data.account).toBeTruthy();
          expect(e.data.resolved.model).toBe(MODEL_NAMES[role]);
          expect(e.data.resolved.max_turns).toBe(ROLE_MAX_TURNS[role]);
          expect(e.data.resolved.context_budget_tokens).toBe(ROLE_CONTEXT_BUDGET_TOKENS);
        }
      }

      const workDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c8b-work-'));
      try {
        const configPath = join(workDir, 'miengu.config.yaml');
        await writeFile(
          configPath,
          stringify({
            target: { repo: workDir },
            accounts: { acct: {} },
            executors: {
              'cx-reviewer': { type: 'codex', account: 'acct', bin: FAKE_CODEX },
              'cx-coder': { type: 'codex', account: 'acct', bin: FAKE_CODEX },
              'cx-other': { type: 'codex', account: 'acct', bin: FAKE_CODEX },
            },
            tiers: { 'cx-reviewer': 1, 'cx-coder': 2, 'cx-other': 1 },
            roles: {
              analyst: { executor: 'cx-other', maxTurns: 8, contextBudgetTokens: 40_000 },
              architect: { executor: 'cx-other', maxTurns: 8, contextBudgetTokens: 40_000 },
              planner: { executor: 'cx-other', maxTurns: 8, contextBudgetTokens: 40_000 },
              testAuthor: { executor: 'cx-other', maxTurns: 8, contextBudgetTokens: 40_000 },
              coder: { executor: 'cx-coder', maxTurns: 8, contextBudgetTokens: 40_000 },
              reviewer: { executor: 'cx-reviewer', maxTurns: 8, contextBudgetTokens: 40_000 },
            },
          }),
          'utf8',
        );

        let caught: unknown;
        try {
          await loadConfig(configPath);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(ConfigError);
        if (caught instanceof ConfigError) {
          expect(caught.exitCode).toBe(EXIT.CONFIG);
          expect(caught.message).toContain(
            'reviewer model must be >= coder model — a weaker reviewer cannot refute a stronger coder',
          );
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    // Criterion 9 — two providers on one item.
    //

    it('criterion 9: dual.yaml and swapped.yaml validate the same artifact kinds, byte-identical bodies, both executor types present', () => {
      const dualKinds = new Set(
        dual.events.filter((e) => e.type === 'StageCompleted' && e.data.artifact !== null).map((e) => e.data.artifact.kind),
      );
      const swappedKinds = new Set(
        swapped.events.filter((e) => e.type === 'StageCompleted' && e.data.artifact !== null).map((e) => e.data.artifact.kind),
      );
      expect([...dualKinds].sort()).toEqual([...swappedKinds].sort());

      for (const stage of ['analysis', 'architecture', 'planning'] as const) {
        const dualBody = dual.events.find((e) => e.type === 'StageCompleted' && e.data.stage === stage)?.data.artifact
          ?.body;
        const swappedBody = swapped.events.find((e) => e.type === 'StageCompleted' && e.data.stage === stage)?.data
          .artifact?.body;
        expect(canonicalJson(dualBody)).toBe(canonicalJson(swappedBody));
      }

      const dualExecutorTypes = new Set(dual.events.filter((e) => e.type === 'ExecutorInvoked').map((e) => e.data.executor_type));
      expect(dualExecutorTypes.has('codex')).toBe(true);
      expect(dualExecutorTypes.has('claude-code')).toBe(true);

      // MUST NOT: a real vendor binary invoked anywhere in this file, including here.
      // Checked on `ExecutorReturned.raw.command_line`, not `ExecutorInvoked.command_line`:
      // the real argv is only knowable after the process returns (and a pre-computed argv on
      // `ExecutorInvoked` would not even be truthful — claude-code mints a fresh session id at
      // run time). `ExecutorReturned.raw.command_line`, populated from `Executor.lastRun`, is
      // stronger evidence because it proves what actually ran rather than what was intended.
      for (const run of [dual, swapped]) {
        const returned = run.events.filter((e) => e.type === 'ExecutorReturned');
        for (const e of returned) {
          expect(e.data.raw.command_line[0]).toContain(join('test', 'fixtures'));
        }
      }
    });
  });

  // ---------------------------------------------------------------------------------------
  // Criterion 10 — per-account quota.
  //

  it('criterion 10: a rate-limited coder account parks at implementation without failing the stage, other stages advance on the healthy account', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p2-c10-target-'));
    const workDir = await mkdtemp(join(tmpdir(), 'miengu-p2-c10-work-'));
    try {
      await initTargetRepoWithTests(targetRepo);
      const tablePath = await writeArtifactTableFile(workDir);
      const roleAccounts: Readonly<Record<Role, string>> = {
        analyst: 'codex-personal',
        architect: 'codex-personal',
        planner: 'codex-personal',
        testAuthor: 'codex-personal',
        coder: 'claude-personal',
        reviewer: 'codex-personal',
      };
      const configYaml = providerConfigYaml({
        targetRepo,
        accounts: { 'codex-personal': {}, 'claude-personal': {} },
        roleAccounts,
        roleTypes: DUAL_ROLE_TYPES,
      });
      const configPath = join(workDir, 'miengu.config.yaml');
      await writeFile(configPath, configYaml, 'utf8');

      process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
      process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
      process.env['FAKE_CLAUDE_MODE'] = 'rate-limited';
      try {
        const exitCode = await runCommand({ prdFile: PRD_PATH, configPath });
        expect(exitCode).toBe(EXIT.PARKED);

        const storeDir = join(workDir, '.miengu');
        const [itemId] = await listItemIds(storeDir);
        expect(itemId).toBeDefined();
        if (itemId === undefined) {
          return;
        }
        const events = await readRawEvents(storeDir, itemId);

        const completedStages = events
          .filter((e) => e.type === 'StageCompleted' && e.data.artifact !== null)
          .map((e) => e.data.stage);
        for (const stage of ['analysis', 'architecture', 'planning', 'test-authoring']) {
          expect(completedStages).toContain(stage);
        }

        const parked = events.find((e) => e.type === 'WorkItemParked');
        expect(parked).toBeDefined();
        if (parked?.type === 'WorkItemParked') {
          expect(parked.data.reason).toBe('provider-quota');
          expect(parked.data.account).toBe('claude-personal');
        }

        const budgetExhausted = events.find(
          (e) => e.type === 'BudgetExhausted' && e.data.account === 'claude-personal' && e.data.limit_kind === 'provider-quota',
        );
        expect(budgetExhausted).toBeDefined();

        const implementationFailures = events.filter((e) => e.type === 'StageFailed' && e.data.stage === 'implementation');
        expect(implementationFailures).toHaveLength(0);

        const finalState = await projectFromSeq1(storeDir, itemId);
        expect(finalState.attempts.implementation).toBe(1);
        expect(effectiveAttempts(finalState, 'implementation')).toBe(0);
      } finally {
        delete process.env['FAKE_CODEX_MODE'];
        delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
        delete process.env['FAKE_CLAUDE_MODE'];
      }
    } finally {
      await rm(targetRepo, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
