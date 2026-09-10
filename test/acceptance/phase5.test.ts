import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

import { runCommand } from '../../src/cli/commands/run.js';
import { decideCommand } from '../../src/cli/commands/decide.js';
import { EXIT } from '../../src/cli/exit.js';
import { itemPaths, listItemIds, EventLog } from '../../src/core/log.js';
import { EVENT_SCHEMA_VERSION, EVENT_TYPES, ROLES } from '../../src/core/events.js';
import type { MienguEvent, Role } from '../../src/core/events.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { fixedClock } from '../../src/core/clock.js';
import { silentLogger } from '../../src/logging.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { PROJECTION_VERSION } from '../../src/state/workitem.js';
import { projectAccelerated, readEventsReadOnly, replayCommand } from '../../src/cli/commands/replay.js';
import { buildBatchReport, renderBatchReport } from '../../src/report/batch.js';
import type { BatchReportInput } from '../../src/report/batch.js';

// This is the Phase 5 gate (WORK_ORDER_PHASE5.md §11 item 32 / §12 / §13). Every criterion
// runs against the real `runCommand`/`decideCommand` CLI entry points, driven by the stub
// executor and the `fake-claude.mjs`/`fake-codex.mjs` fixtures used since Phase 2 — never a
// real vendor binary.
//
// `runCommand`/`decideCommand` hardcode `systemClock` (no injectable clock at the CLI
// boundary), so the "advance the clock past `resets_at`"/"SLA expiry" criteria are satisfied
// by faking only the global `Date` (`vi.useFakeTimers({ toFake: ['Date'] })`), never a real
// `setTimeout`/sleep: this is a controlled, injected instant exactly like `fixedClock` is at
// the unit level, not a dependency on how long the test happens to take to run.
//
// Each criterion below uses its OWN store (its own `.miengu` dir under its own `workDir`),
// rather than one giant shared store: the config that drives one scenario's blast-radius
// patterns, account map or checkpoint defaults must stay constant for the lifetime of every
// item it touches (decision 1: the config in force at raise time is what a checkpoint's owner
// and triggers resolve against), and a shared store's backlog scan touches every item on every
// invocation regardless of which scenario "owns" it. Criterion 1 (the one criterion that is
// inherently about cross-item interaction on one account) still exercises exactly that inside
// its own store, with two items coexisting in it.

const execFileAsync = promisify(execFile);

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

async function initTargetRepo(repo: string): Promise<void> {
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
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

/** Diffs the id set before/after rather than trusting `listItemIds`' sort order — item ids end
 *  in a random suffix, so "the last one" is not reliably "the newest one" (the exact defect
 *  `test/cli/decide.test.ts`'s `createItem` helper had before it was fixed). */
async function newItemIds(storeDir: string, before: readonly WorkItemId[]): Promise<WorkItemId[]> {
  const after = await listItemIds(storeDir);
  const beforeSet = new Set(before);
  return after.filter((id) => !beforeSet.has(id));
}

async function newItemId(storeDir: string, before: readonly WorkItemId[]): Promise<WorkItemId> {
  const found = await newItemIds(storeDir, before);
  expect(found).toHaveLength(1);
  const id = found[0];
  if (id === undefined) {
    throw new Error('newItemId: no new item was minted');
  }
  return id;
}

function useFakeNow(iso: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(iso));
}

function restoreRealTime(): void {
  vi.useRealTimers();
}

async function captureJsonOutput<T>(fn: () => Promise<number>): Promise<{ exitCode: number; output: T }> {
  let raw = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    raw += String(chunk);
    return true;
  });
  let exitCode: number;
  try {
    exitCode = await fn();
  } finally {
    write.mockRestore();
  }
  return { exitCode, output: JSON.parse(raw.trim().split('\n')[0] ?? '{}') as T };
}

// ---------------------------------------------------------------------------------------
// Shared, contract-valid artifact bodies (the exact shapes `test/acceptance/phase2.test.ts`
// already proved valid), one per role, reused across scenarios and lightly mutated (an
// ambiguity here, an irreversible decision there) per criterion.
// ---------------------------------------------------------------------------------------

const REQUIREMENT_SET_BASE = {
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
  ambiguities: [] as unknown[],
  out_of_scope: [] as string[],
};

const ARCHITECTURE_PLAN_BASE = {
  decisions: [
    {
      decision_id: 'decision-example-1',
      title: 'pick an approach',
      choice: 'do it directly',
      alternatives: ['do it indirectly'],
      rationale: 'simplest thing that works',
      req_ids: ['REQ-example-1'],
      supersedes: null as string | null,
      blast_radius: 'reversible' as 'reversible' | 'irreversible',
    },
  ],
  components: [
    {
      component_id: 'component-example-1',
      responsibility: 'does X',
      paths: ['src/x.ts'],
      depends_on: [] as string[],
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

type RoleExecutorType = 'stub' | 'codex' | 'claude-code';

/** Every role gets its own executor instance. A `stub` role is the built-in deterministic
 *  executor (its content is the fixed `DEFAULT_ARTIFACTS`/`DEFAULT_STAGE_FILES` from
 *  `src/executors/stub.ts` — never customisable through config); a `codex`/`claude-code` role
 *  is the corresponding fixture binary, driven by `FAKE_{CODEX,CLAUDE}_MODE` and, in
 *  `artifact-by-model` mode, an artifact table keyed by `--model`. */
function buildConfigYaml(o: {
  readonly targetRepo: string;
  readonly accounts: Readonly<Record<string, Record<string, unknown>>>;
  readonly roleTypes: Readonly<Record<Role, RoleExecutorType>>;
  readonly roleAccounts: Readonly<Record<Role, string>>;
  readonly checkpoints?: Record<string, unknown> | undefined;
  readonly assumptions?: Record<string, unknown> | undefined;
}): string {
  const executors: Record<string, unknown> = {};
  const tiers: Record<string, number> = {};
  const roles: Record<string, unknown> = {};
  for (const role of ROLES) {
    const type = o.roleTypes[role];
    const instanceId = `${type}-${role.toLowerCase()}`;
    executors[instanceId] =
      type === 'stub'
        ? { type, account: o.roleAccounts[role] }
        : {
            type,
            account: o.roleAccounts[role],
            bin: type === 'codex' ? FAKE_CODEX : FAKE_CLAUDE,
            model: MODEL_NAMES[role],
          };
    tiers[instanceId] = 1;
    roles[role] = { executor: instanceId, maxTurns: ROLE_MAX_TURNS[role], contextBudgetTokens: 40_000 };
  }
  return stringify({
    target: { repo: o.targetRepo },
    accounts: o.accounts,
    executors,
    tiers,
    roles,
    ...(o.checkpoints !== undefined ? { checkpoints: o.checkpoints } : {}),
    ...(o.assumptions !== undefined ? { assumptions: o.assumptions } : {}),
    store: { dir: '.miengu', snapshotEvery: 200 },
  });
}

async function writeArtifactTable(dir: string, name: string, table: Record<string, unknown>): Promise<string> {
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify(table), 'utf8');
  return path;
}

async function writePrd(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.md`);
  await writeFile(path, `Build ${name}.\n`, 'utf8');
  return path;
}

interface Env {
  readonly workDir: string;
  readonly targetRepo: string;
  readonly storeDir: string;
  readonly configPath: string;
}

/** Creates the target repo and work dir, then writes `miengu.config.yaml` from `buildConfig`
 *  — a callback because every config in this file names `target.repo`, which is only known
 *  once `mkdtemp` has run. */
async function makeEnv(prefix: string, buildConfig: (targetRepo: string) => string): Promise<Env> {
  const targetRepo = await mkdtemp(join(tmpdir(), `miengu-p5-${prefix}-target-`));
  const workDir = await mkdtemp(join(tmpdir(), `miengu-p5-${prefix}-work-`));
  await initTargetRepo(targetRepo);
  const configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(configPath, buildConfig(targetRepo), 'utf8');
  return { workDir, targetRepo, storeDir: join(workDir, '.miengu'), configPath };
}

async function rmEnv(env: Env): Promise<void> {
  await rm(env.targetRepo, { recursive: true, force: true });
  await rm(env.workDir, { recursive: true, force: true });
}

// =========================================================================================
// Criterion 1 — a multi-item run parks correctly on quota, and drains and completes once
// the account's window has passed.
// =========================================================================================
describe('Phase 5 acceptance: criterion 1 — quota park across two items, one account', () => {
  let env: Env;
  let itemFirstQuota: WorkItemId; // parked first, by its own dedicated `run`
  let itemSecondQuota: WorkItemId; // the invocation's "new item", parks in the same run
  let itemAfterClear: WorkItemId;

  const CODEX_ACCOUNT = 'codex-quota';
  const CLAUDE_ACCOUNT = 'claude-quota';
  const BEFORE_RESET = '2026-01-01T00:00:00.000Z';
  // fake-claude.mjs's `rate_limit_event` fixture always reports this fixed reset instant
  // (unix seconds 1788545400), regardless of the real wall clock.
  const RESET_ISO = '2026-09-04T18:10:00.000Z';
  const AFTER_RESET = '2026-09-05T00:00:00.000Z';

  let tablePath: string;

  beforeAll(async () => {
    // testAuthor must be `stub`, not `codex`: neither fake fixture ever writes a file to the
    // workspace (only the stub does, via `DEFAULT_STAGE_FILES`), and the frozen-test step
    // needs `test/a.test.ts`/`test/b.test.ts` to actually be on disk to hash.
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'codex', architect: 'codex', planner: 'codex', testAuthor: 'stub', coder: 'claude-code', reviewer: 'codex',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: CODEX_ACCOUNT, architect: CODEX_ACCOUNT, planner: CODEX_ACCOUNT, testAuthor: CODEX_ACCOUNT,
      coder: CLAUDE_ACCOUNT, reviewer: CODEX_ACCOUNT,
    };
    env = await makeEnv('quota', (targetRepo) =>
      buildConfigYaml({ targetRepo, accounts: { [CODEX_ACCOUNT]: {}, [CLAUDE_ACCOUNT]: {} }, roleTypes, roleAccounts }),
    );

    tablePath = await writeArtifactTable(env.workDir, 'quota-table', {
      [MODEL_NAMES.analyst]: REQUIREMENT_SET_BASE,
      [MODEL_NAMES.architect]: ARCHITECTURE_PLAN_BASE,
      [MODEL_NAMES.planner]: { tasks: [{ task_id: 'task-example-1', title: 'implement X', req_ids: ['REQ-example-1'], component_ids: ['component-example-1'], expected_paths: ['src/x.ts'], depends_on: [], definition_of_done: ['X works'], estimated_turns: 1 }] },
      [MODEL_NAMES.testAuthor]: { suite_id: 'suite-example-1', cases: [
        { test_id: 'test-example-1', req_ids: ['REQ-example-1'], path: 'test/a.test.ts', intent: 'asserts X works', negative: false, asserts_output: true },
        { test_id: 'test-example-2', req_ids: ['REQ-example-1'], path: 'test/b.test.ts', intent: 'asserts X rejects bad input', negative: true, asserts_output: false },
      ] },
      [MODEL_NAMES.coder]: { task_id: 'task-example-1', diff_ref: 'diffref', files_touched: ['src/x.ts'], assumption_ids: [], deviations: [] },
      [MODEL_NAMES.reviewer]: { task_id: 'task-example-1', verdict: 'accept', findings: [], escalate_to: null },
    });

    process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
    process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
    process.env['FAKE_CLAUDE_ARTIFACT_TABLE'] = tablePath;

    try {
      // Step 1: itemFirstQuota parks on its own dedicated run, before any other item exists.
      useFakeNow(BEFORE_RESET);
      process.env['FAKE_CLAUDE_MODE'] = 'rate-limited';
      const before1 = await listItemIds(env.storeDir);
      const prd1 = await writePrd(env.workDir, 'first-quota');
      const exit1 = await runCommand({ prdFile: prd1, configPath: env.configPath });
      expect(exit1).toBe(EXIT.PARKED);
      itemFirstQuota = await newItemId(env.storeDir, before1);

      const eventsAfterOwnPark = await readRawEvents(env.storeDir, itemFirstQuota);
      const invokedCountAfterOwnPark = eventsAfterOwnPark.filter((e) => e.type === 'ExecutorInvoked').length;

      // Step 2: a SECOND item, on the SAME run, also hits quota (same account, still
      // rate-limited) — this is the invocation's "new item". `itemFirstQuota` must not be
      // touched at all: no new ExecutorInvoked, no WorkItemResumed.
      const before2 = await listItemIds(env.storeDir);
      const prd2 = await writePrd(env.workDir, 'second-quota');
      const { exitCode: exit2, output } = await captureJsonOutput<{
        item: string;
        backlog: { item: string; ready: boolean; blocker: string | null }[];
      }>(() => runCommand({ prdFile: prd2, configPath: env.configPath, json: true }));
      expect(exit2).toBe(EXIT.PARKED);
      itemSecondQuota = await newItemId(env.storeDir, before2);
      expect(output.item).toBe(itemSecondQuota);

      const row = output.backlog.find((r) => r.item === itemFirstQuota);
      expect(row?.ready).toBe(false);

      const eventsAfterSecondRun = await readRawEvents(env.storeDir, itemFirstQuota);
      expect(eventsAfterSecondRun).toHaveLength(eventsAfterOwnPark.length);
      expect(eventsAfterSecondRun.filter((e) => e.type === 'ExecutorInvoked')).toHaveLength(invokedCountAfterOwnPark);
      expect(eventsAfterSecondRun.some((e) => e.type === 'WorkItemResumed')).toBe(false);
      restoreRealTime();

      // Step 3: advance the fake clock past resets_at, switch the account back to healthy,
      // and run again — both previously-parked items must drain and complete, alongside the
      // brand new third item.
      useFakeNow(AFTER_RESET);
      process.env['FAKE_CLAUDE_MODE'] = 'artifact-by-model';
      const before3 = await listItemIds(env.storeDir);
      const prd3 = await writePrd(env.workDir, 'third-after-reset');
      const { exitCode: exit3, output: output3 } = await captureJsonOutput<{
        item: string;
        outcome: string;
        backlog: { item: string; ready: boolean; blocker: string | null; outcome: string | null }[];
      }>(() => runCommand({ prdFile: prd3, configPath: env.configPath, json: true }));
      expect(exit3).toBe(EXIT.OK);
      expect(output3.outcome).toBe('completed');
      itemAfterClear = await newItemId(env.storeDir, before3);
      expect(output3.item).toBe(itemAfterClear);

      const rowFirst = output3.backlog.find((r) => r.item === itemFirstQuota);
      const rowSecond = output3.backlog.find((r) => r.item === itemSecondQuota);
      expect(rowFirst?.ready).toBe(true);
      expect(rowFirst?.outcome).toBe('completed');
      expect(rowSecond?.ready).toBe(true);
      expect(rowSecond?.outcome).toBe('completed');
    } finally {
      restoreRealTime();
      delete process.env['FAKE_CODEX_MODE'];
      delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      delete process.env['FAKE_CLAUDE_MODE'];
      delete process.env['FAKE_CLAUDE_ARTIFACT_TABLE'];
    }
  }, 60_000);

  afterAll(async () => {
    await rmEnv(env);
  });

  it('the parked item names its account and its window', async () => {
    const events = await readRawEvents(env.storeDir, itemFirstQuota);
    const parked = events.find((e) => e.type === 'WorkItemParked');
    expect(parked?.data.reason).toBe('provider-quota');
    expect(parked?.data.account).toBe(CLAUDE_ACCOUNT);
    expect(parked?.data.resets_at).toBe(RESET_ISO);
  });

  it('every drained item completed and every item now replays MATCH', async () => {
    for (const itemId of [itemFirstQuota, itemSecondQuota, itemAfterClear]) {
      const { state } = await projectAccelerated(env.storeDir, itemId);
      expect(state.status).toBe('completed');
      const replayExit = await replayCommand({ itemId, configPath: env.configPath, json: true });
      expect(replayExit).toBe(EXIT.OK);
    }
  });
});

// =========================================================================================
// Criterion 2 — a multi-item run parks correctly on blocked checkpoints: one irreversible
// architecture decision plus an unresolved assumption raise one irreversible and one
// assumption-gate checkpoint; a later `run` does not resume it; `decide` on both, then `run`
// resumes and completes. Also covers criterion 3 (WorkItemResumed + replay MATCH) and the
// checkpoint/assumption id-collision-across-a-rerun guarantee.
// =========================================================================================
describe('Phase 5 acceptance: criterion 2 — blocked checkpoints, decide, resume', () => {
  let env: Env;
  let itemId: WorkItemId;
  let irreversibleCheckpoint: string;
  let assumptionGateCheckpoint: string;

  const CODEX_ACCOUNT = 'codex-checkpoints';
  const STUB_ACCOUNT = 'stub-checkpoints';

  beforeAll(async () => {
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'codex', architect: 'codex', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'stub',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: CODEX_ACCOUNT, architect: CODEX_ACCOUNT, planner: STUB_ACCOUNT, testAuthor: STUB_ACCOUNT,
      coder: STUB_ACCOUNT, reviewer: STUB_ACCOUNT,
    };
    env = await makeEnv('checkpoints', (targetRepo) =>
      buildConfigYaml({
        targetRepo,
        accounts: { [CODEX_ACCOUNT]: {}, [STUB_ACCOUNT]: {} },
        roleTypes,
        roleAccounts,
        checkpoints: { defaultOwner: 'qa-owner' },
      }),
    );

    const requirementSet = {
      ...REQUIREMENT_SET_BASE,
      ambiguities: [
        { question: 'which store to use?', affects: ['REQ-example-1'], options: ['sql', 'nosql'], recommended: 'sql' },
      ],
    };
    const architecturePlan = {
      ...ARCHITECTURE_PLAN_BASE,
      decisions: [{ ...ARCHITECTURE_PLAN_BASE.decisions[0], blast_radius: 'irreversible' as const }],
    };
    const tablePath = await writeArtifactTable(env.workDir, 'checkpoints-table', {
      [MODEL_NAMES.analyst]: requirementSet,
      [MODEL_NAMES.architect]: architecturePlan,
    });

    process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
    process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
    try {
      const before = await listItemIds(env.storeDir);
      const prd = await writePrd(env.workDir, 'checkpoints');
      const exitCode = await runCommand({ prdFile: prd, configPath: env.configPath });
      expect(exitCode).toBe(EXIT.PARKED);
      itemId = await newItemId(env.storeDir, before);
    } finally {
      delete process.env['FAKE_CODEX_MODE'];
      delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
    }
  }, 60_000);

  afterAll(async () => {
    await rmEnv(env);
  });

  it('parks awaiting-human with exactly one irreversible and one assumption-gate blocking checkpoint, neither carrying an SLA or a default', async () => {
    const { state } = await projectAccelerated(env.storeDir, itemId);
    expect(state.status).toBe('parked');
    expect(state.park?.reason).toBe('awaiting-human');

    const blocking = Object.values(state.checkpoints).filter((cp) => cp.blocking && cp.status === 'open');
    expect(blocking).toHaveLength(2);
    const irreversible = blocking.find((cp) => cp.kind === 'irreversible');
    const assumptionGate = blocking.find((cp) => cp.kind === 'assumption-gate');
    expect(irreversible).toBeDefined();
    expect(assumptionGate).toBeDefined();
    if (irreversible === undefined || assumptionGate === undefined) return;
    irreversibleCheckpoint = irreversible.id;
    assumptionGateCheckpoint = assumptionGate.id;

    const events = await readRawEvents(env.storeDir, itemId);
    for (const cpId of [irreversibleCheckpoint, assumptionGateCheckpoint]) {
      const raised = events.find((e) => e.type === 'CheckpointRaised' && e.data.checkpoint === cpId);
      expect(raised?.data.sla_seconds).toBeNull();
      expect(raised?.data.default_decision).toBeNull();
    }
    expect(state.assumptions).toHaveLength(1);
  });

  it('a subsequent run does not resume the item: blocker blocking-checkpoint-open', async () => {
    const before = await listItemIds(env.storeDir);
    const prd = await writePrd(env.workDir, 'checkpoints-probe');
    const { output } = await captureJsonOutput<{ backlog: { item: string; ready: boolean; blocker: string | null }[] }>(() =>
      runCommand({ prdFile: prd, configPath: env.configPath, json: true }),
    );
    const row = output.backlog.find((r) => r.item === itemId);
    expect(row?.ready).toBe(false);
    expect(row?.blocker).toBe('blocking-checkpoint-open');
    // this probe minted its own new item; not otherwise relevant to this scenario.
    await newItemId(env.storeDir, before);
  });

  it('decide accepts both checkpoints, then a subsequent run resumes and completes the item', async () => {
    for (const cpId of [irreversibleCheckpoint, assumptionGateCheckpoint]) {
      const exitCode = await decideCommand({ checkpoint: cpId, decision: 'accept', configPath: env.configPath });
      expect(exitCode).toBe(EXIT.OK);
    }

    const before = await listItemIds(env.storeDir);
    const prd = await writePrd(env.workDir, 'checkpoints-resume');
    const { exitCode, output } = await captureJsonOutput<{
      item: string;
      backlog: { item: string; ready: boolean; outcome: string | null }[];
    }>(() => runCommand({ prdFile: prd, configPath: env.configPath, json: true }));
    expect(exitCode).toBe(EXIT.OK);
    await newItemId(env.storeDir, before);

    const row = output.backlog.find((r) => r.item === itemId);
    expect(row?.ready).toBe(true);
    expect(row?.outcome).toBe('completed');

    const events = await readRawEvents(env.storeDir, itemId);
    const resumedIndex = events.findIndex((e) => e.type === 'WorkItemResumed');
    expect(resumedIndex).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'CheckpointDecided')).toHaveLength(2);

    const { state } = await projectAccelerated(env.storeDir, itemId);
    expect(state.status).toBe('completed');
    expect(state.park).toBeNull();

    const replayExit = await replayCommand({ itemId, configPath: env.configPath, json: true });
    expect(replayExit).toBe(EXIT.OK);
  });

  it('checkpoint ids never collide across a real re-run: two genuine architecture attempts through runItem each mint their own checkpoint, and the first stays accepted', async () => {
    // Finding 2 of item 33's adversarial review: the previous version of this bullet hand-called
    // `nextCheckpointSerial`/`checkpointDraft` against a synthetic `StageEntered`, which proves
    // only serial computation in isolation (already covered by
    // `test/supervisor/checkpointPolicy.ts`'s unit tests) — not the wiring the binding decision
    // is actually about: that `performRunAttempt` (`src/supervisor/loop.ts`) recomputes
    // `GateContext.nextCheckpointSerial` fresh from live `state.checkpoints` on EVERY attempt,
    // rather than a `GateContext` cached once per `runItem` loop. This drives two REAL
    // architecture attempts through `runCommand`/`decideCommand` — the first via the item's own
    // initial run, the second via a Reviewer escalation back to architect after the first
    // checkpoint is accepted — with the architect returning the same irreversible decision on
    // both attempts.
    const CODEX_ACCOUNT = 'codex-rerun';
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'stub', architect: 'codex', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'codex',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: CODEX_ACCOUNT, architect: CODEX_ACCOUNT, planner: CODEX_ACCOUNT, testAuthor: CODEX_ACCOUNT,
      coder: CODEX_ACCOUNT, reviewer: CODEX_ACCOUNT,
    };
    const rerunEnv = await makeEnv('rerun-checkpoints', (targetRepo) =>
      buildConfigYaml({
        targetRepo,
        accounts: { [CODEX_ACCOUNT]: {} },
        roleTypes,
        roleAccounts,
        checkpoints: { defaultOwner: 'qa-owner' },
      }),
    );
    try {
      const architecturePlan = {
        ...ARCHITECTURE_PLAN_BASE,
        decisions: [{ ...ARCHITECTURE_PLAN_BASE.decisions[0], blast_radius: 'irreversible' as const }],
      };
      const escalateVerdict = { task_id: 'task-example-1', verdict: 'escalate', findings: [], escalate_to: 'architect' };
      const tablePath = await writeArtifactTable(rerunEnv.workDir, 'rerun-table', {
        [MODEL_NAMES.architect]: architecturePlan,
        [MODEL_NAMES.reviewer]: escalateVerdict,
      });

      let rerunItemId: WorkItemId;
      process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
      process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
      try {
        const before = await listItemIds(rerunEnv.storeDir);
        const prd = await writePrd(rerunEnv.workDir, 'rerun-checkpoints');
        const exitCode = await runCommand({ prdFile: prd, configPath: rerunEnv.configPath });
        expect(exitCode).toBe(EXIT.PARKED);
        rerunItemId = await newItemId(rerunEnv.storeDir, before);
      } finally {
        delete process.env['FAKE_CODEX_MODE'];
        delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      }

      const { state: firstParkedState } = await projectAccelerated(rerunEnv.storeDir, rerunItemId);
      const firstIrreversible = Object.values(firstParkedState.checkpoints).find((cp) => cp.kind === 'irreversible');
      expect(firstIrreversible).toBeDefined();
      if (firstIrreversible === undefined) return;

      const decideExit = await decideCommand({ checkpoint: firstIrreversible.id, decision: 'accept', configPath: rerunEnv.configPath });
      expect(decideExit).toBe(EXIT.OK);

      // Resuming through the backlog drives the second, real architecture attempt: the
      // Reviewer's escalation (after planning/test-authoring/implementation all redo) opens an
      // `architecture` cause, invalidates the architect's artifact, and re-enters the
      // architecture stage as attempt 2 — which, raising the same irreversible decision again,
      // mints and parks on a brand new checkpoint before the loop ever revisits the Reviewer.
      process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
      process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
      try {
        const before = await listItemIds(rerunEnv.storeDir);
        const prd = await writePrd(rerunEnv.workDir, 'rerun-checkpoints-resume');
        const { output } = await captureJsonOutput<{
          backlog: { item: string; ready: boolean; outcome: string | null }[];
        }>(() => runCommand({ prdFile: prd, configPath: rerunEnv.configPath, json: true }));
        await newItemId(rerunEnv.storeDir, before);
        const row = output.backlog.find((r) => r.item === rerunItemId);
        expect(row?.ready).toBe(true);
        expect(row?.outcome).toBe('parked');
      } finally {
        delete process.env['FAKE_CODEX_MODE'];
        delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      }

      const events = await readRawEvents(rerunEnv.storeDir, rerunItemId);
      const architectureAttempts = events.filter((e) => e.type === 'StageEntered' && e.data.stage === 'architecture');
      expect(architectureAttempts).toHaveLength(2);
      expect(architectureAttempts[1]?.data.attempt).toBe(2);

      const { state } = await projectAccelerated(rerunEnv.storeDir, rerunItemId);
      const irreversibleCheckpoints = Object.values(state.checkpoints).filter((cp) => cp.kind === 'irreversible');
      expect(irreversibleCheckpoints).toHaveLength(2);
      const secondIrreversible = irreversibleCheckpoints.find((cp) => cp.id !== firstIrreversible.id);
      expect(secondIrreversible).toBeDefined();
      if (secondIrreversible === undefined) return;
      expect(secondIrreversible.id).not.toBe(firstIrreversible.id);
      expect(secondIrreversible.status).toBe('open');
      expect(state.checkpoints[firstIrreversible.id]?.status).toBe('accepted');
    } finally {
      await rmEnv(rerunEnv);
    }
  });
});

// =========================================================================================
// Blast-radius trigger + dedupe on a cumulative diff + reversible-checkpoint SLA
// auto-approval (no CheckpointDecided ever recorded for it).
// =========================================================================================
describe('Phase 5 acceptance: blast radius, dedupe, and SLA auto-approval', () => {
  let env: Env;
  let itemId: WorkItemId;
  let migrationCheckpoint: string;
  let diffSizeCheckpoint: string;

  const ACCOUNT = 'stub-blast';
  const START = '2026-02-01T00:00:00.000Z';
  const AFTER_SLA = '2026-02-01T00:02:00.000Z'; // +120s, past the 5s reversible SLA below

  beforeAll(async () => {
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'stub', architect: 'stub', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'stub',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: ACCOUNT, architect: ACCOUNT, planner: ACCOUNT, testAuthor: ACCOUNT, coder: ACCOUNT, reviewer: ACCOUNT,
    };
    env = await makeEnv('blast', (targetRepo) =>
      buildConfigYaml({
        targetRepo,
        accounts: { [ACCOUNT]: {} },
        roleTypes,
        roleAccounts,
        checkpoints: {
          reversible: { slaSeconds: 5, default: 'accept' },
          blastRadius: { migrationOrSchemaPaths: ['**/implementation.txt'], maxFilesTouched: 1 },
        },
      }),
    );

    try {
      useFakeNow(START);
      const before = await listItemIds(env.storeDir);
      const prd = await writePrd(env.workDir, 'blast-radius');
      const exitCode = await runCommand({ prdFile: prd, configPath: env.configPath });
      expect(exitCode).toBe(EXIT.PARKED);
      itemId = await newItemId(env.storeDir, before);
    } finally {
      restoreRealTime();
    }
  }, 60_000);

  afterAll(async () => {
    await rmEnv(env);
  });

  it('a stub coder\'s implementation.txt fires the declared migration-or-schema pattern exactly once, and never again on the later cumulative diff', async () => {
    const { state } = await projectAccelerated(env.storeDir, itemId);
    expect(state.status).toBe('parked');
    expect(state.park?.reason).toBe('awaiting-human');

    // Both the blocking migration-or-schema trigger and the advisory diff-size trigger raise
    // a checkpoint of the SAME kind, `blast-radius` — `blocking` (not `kind`) is what
    // distinguishes them (checkpointDraft chooses reversibility from the verdict's severity).
    const blastRadiusCheckpoints = Object.values(state.checkpoints).filter((cp) => cp.kind === 'blast-radius');
    expect(blastRadiusCheckpoints).toHaveLength(2);
    const migration = blastRadiusCheckpoints.find((cp) => cp.blocking);
    expect(migration).toBeDefined();
    if (migration === undefined) return;
    migrationCheckpoint = migration.id;
    expect(migration.blocking).toBe(true);
    expect(migration.status).toBe('open');

    const diffSize = blastRadiusCheckpoints.find((cp) => !cp.blocking);
    expect(diffSize).toBeDefined();
    if (diffSize === undefined) return;
    diffSizeCheckpoint = diffSize.id;
    expect(diffSize.status).toBe('open');

    const events = await readRawEvents(env.storeDir, itemId);
    const diffSizeRaised = events.find((e) => e.type === 'CheckpointRaised' && e.data.checkpoint === diffSizeCheckpoint);
    expect(diffSizeRaised?.data.sla_seconds).toBe(5);
    expect(diffSizeRaised?.data.default_decision).toBe('accept');

    // Every DiffCaptured after the coder's stage is cumulative and re-contains the same
    // implementation.txt path, yet the trigger fires exactly once (decision 11's dedupe).
    const migrationRaises = events.filter(
      (e) => e.type === 'CheckpointRaised' && e.data.kind === 'blast-radius' && String(e.data.summary).includes('migration-or-schema'),
    );
    expect(migrationRaises).toHaveLength(1);
  });

  it('decide accepts the blocking blast-radius checkpoint; on resume, past the SLA, the reversible diff-size checkpoint auto-approves and no CheckpointDecided is ever recorded for it', async () => {
    const decideExit = await decideCommand({ checkpoint: migrationCheckpoint, decision: 'accept', configPath: env.configPath });
    expect(decideExit).toBe(EXIT.OK);

    try {
      useFakeNow(AFTER_SLA);
      const before = await listItemIds(env.storeDir);
      const prd = await writePrd(env.workDir, 'blast-radius-resume');
      // The brand new item minted by THIS invocation touches the same declared pattern (this
      // store's stub coder always writes `.miengu-stub/implementation.txt`) and parks on its
      // own blast-radius checkpoint too, so `runCommand`'s return is the new item's own
      // outcome (§10: never the drain's) — assert on the drained item's own backlog row.
      const { output } = await captureJsonOutput<{
        backlog: { item: string; ready: boolean; outcome: string | null }[];
      }>(() => runCommand({ prdFile: prd, configPath: env.configPath, json: true }));
      await newItemId(env.storeDir, before);
      const row = output.backlog.find((r) => r.item === itemId);
      expect(row?.ready).toBe(true);
      expect(row?.outcome).toBe('completed');
    } finally {
      restoreRealTime();
    }

    const events = await readRawEvents(env.storeDir, itemId);
    const autoApproved = events.find((e) => e.type === 'AutoApproved' && e.data.checkpoint === diffSizeCheckpoint);
    expect(autoApproved).toBeDefined();
    expect(autoApproved?.data.no_human_response).toBe(true);
    expect(autoApproved?.data.after).toBe('5s');

    const decidedForDiffSize = events.filter((e) => e.type === 'CheckpointDecided' && e.data.checkpoint === diffSizeCheckpoint);
    expect(decidedForDiffSize).toHaveLength(0);

    const { state } = await projectAccelerated(env.storeDir, itemId);
    expect(state.status).toBe('completed');
    expect(state.checkpoints[diffSizeCheckpoint]?.status).toBe('auto-approved');

    const replayExit = await replayCommand({ itemId, configPath: env.configPath, json: true });
    expect(replayExit).toBe(EXIT.OK);
  });
});

// =========================================================================================
// An assumption at maxStackDepth produces a blocking escalation checkpoint, and the
// assumption is still recorded. Also feeds criterion 4's "deepest first" report ordering.
// =========================================================================================
describe('Phase 5 acceptance: assumption escalation at maxStackDepth', () => {
  let env: Env;
  let itemId: WorkItemId;

  const CODEX_ACCOUNT = 'codex-escalation';

  beforeAll(async () => {
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'codex', architect: 'stub', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'stub',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: CODEX_ACCOUNT, architect: CODEX_ACCOUNT, planner: CODEX_ACCOUNT, testAuthor: CODEX_ACCOUNT,
      coder: CODEX_ACCOUNT, reviewer: CODEX_ACCOUNT,
    };
    env = await makeEnv('escalation', (targetRepo) =>
      buildConfigYaml({ targetRepo, accounts: { [CODEX_ACCOUNT]: {} }, roleTypes, roleAccounts }),
    );

    const requirementSet = {
      ...REQUIREMENT_SET_BASE,
      ambiguities: [
        { question: 'q1: which store?', affects: ['REQ-example-1'], options: ['sql', 'nosql'], recommended: 'sql' },
        { question: 'q2: which driver?', affects: ['REQ-example-1'], options: ['a', 'b'], recommended: 'a' },
        { question: 'q3: which pool size?', affects: ['REQ-example-1'], options: ['small', 'large'], recommended: 'small' },
      ],
    };
    const tablePath = await writeArtifactTable(env.workDir, 'escalation-table', {
      [MODEL_NAMES.analyst]: requirementSet,
    });

    process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
    process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
    try {
      const before = await listItemIds(env.storeDir);
      const prd = await writePrd(env.workDir, 'escalation');
      const exitCode = await runCommand({ prdFile: prd, configPath: env.configPath });
      expect(exitCode).toBe(EXIT.PARKED);
      itemId = await newItemId(env.storeDir, before);
    } finally {
      delete process.env['FAKE_CODEX_MODE'];
      delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
    }
  }, 60_000);

  afterAll(async () => {
    await rmEnv(env);
  });

  it('three ambiguities sharing one affects[] yield depths 0, 1, 2; the third escalates, still recorded, and parks the item', async () => {
    const { state } = await projectAccelerated(env.storeDir, itemId);
    expect(state.status).toBe('parked');
    expect(state.park?.reason).toBe('awaiting-human');
    expect(state.assumptions).toHaveLength(3);

    const depths = state.assumptions.map((a) => a.depth).sort((a, b) => a - b);
    expect(depths).toEqual([0, 1, 2]);

    const escalation = Object.values(state.checkpoints).find((cp) => cp.kind === 'escalation');
    expect(escalation).toBeDefined();
    expect(escalation?.blocking).toBe(true);
    expect(escalation?.status).toBe('open');

    const deepest = state.assumptions.find((a) => a.depth === 2);
    expect(deepest).toBeDefined();
    expect(deepest?.id).toBeTruthy();
  });
});

// =========================================================================================
// Criterion 4 — the report is actionable: owners, SLA (null for irreversible), blast-radius
// triggers, gated assumption ids, unresolved assumptions deepest first, and byte-identical
// rendering from disk-read vs in-memory events. Reads the stores built by the scenarios
// above, so this describe block must run after them (vitest runs `it`/`describe` in file
// order within one file).
// =========================================================================================
describe('Phase 5 acceptance: criterion 4 — an actionable report', () => {
  it('report over the blocked-checkpoints store: owner, null SLA, gated assumption id, and disk/memory byte-identity', async () => {
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'codex', architect: 'codex', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'stub',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: 'codex-report', architect: 'codex-report', planner: 'stub-report', testAuthor: 'stub-report',
      coder: 'stub-report', reviewer: 'stub-report',
    };
    const env = await makeEnv('report', (targetRepo) =>
      buildConfigYaml({
        targetRepo,
        accounts: { 'codex-report': {}, 'stub-report': {} },
        roleTypes,
        roleAccounts,
        checkpoints: { defaultOwner: 'report-owner' },
      }),
    );
    try {
      const requirementSet = {
        ...REQUIREMENT_SET_BASE,
        ambiguities: [
          { question: 'which store to use?', affects: ['REQ-example-1'], options: ['sql', 'nosql'], recommended: 'sql' },
        ],
      };
      const architecturePlan = {
        ...ARCHITECTURE_PLAN_BASE,
        decisions: [{ ...ARCHITECTURE_PLAN_BASE.decisions[0], blast_radius: 'irreversible' as const }],
      };
      const tablePath = await writeArtifactTable(env.workDir, 'report-table', {
        [MODEL_NAMES.analyst]: requirementSet,
        [MODEL_NAMES.architect]: architecturePlan,
      });

      process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
      process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
      let itemId: WorkItemId;
      try {
        const before = await listItemIds(env.storeDir);
        const prd = await writePrd(env.workDir, 'report');
        const exitCode = await runCommand({ prdFile: prd, configPath: env.configPath });
        expect(exitCode).toBe(EXIT.PARKED);
        itemId = await newItemId(env.storeDir, before);
      } finally {
        delete process.env['FAKE_CODEX_MODE'];
        delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      }

      const paths = itemPaths(env.storeDir, itemId);
      const fromDisk = await readEventsReadOnly(paths.eventsFile, itemId);

      // "In memory": events read via a live `EventLog` open (`log.readAll()`), the same
      // accessor a real run holds its own events through, as opposed to the raw read-only
      // disk parse `readEventsReadOnly` uses for reporting — the same two code paths
      // `test/acceptance/phase4.test.ts`'s criterion 2 compares.
      const ids = createIdMinter(fixedRng('report-in-memory'));
      const { log } = await EventLog.open({
        storeDir: env.storeDir,
        itemId,
        runId: ids.runId(),
        clock: fixedClock('2024-06-01T00:00:00.000Z'),
        ids,
        logger: silentLogger,
      });
      let inMemoryEvents: readonly MienguEvent[];
      try {
        inMemoryEvents = await log.readAll();
      } finally {
        await log.close();
      }

      const inputFromDisk: BatchReportInput = { locale: 'en', since: null, items: [{ itemId, events: fromDisk }], corrupt: [] };
      const inputFromMemory: BatchReportInput = { locale: 'en', since: null, items: [{ itemId, events: inMemoryEvents }], corrupt: [] };
      const reportFromDisk = buildBatchReport(inputFromDisk);
      const reportFromMemory = buildBatchReport(inputFromMemory);
      expect(JSON.stringify(reportFromDisk)).toBe(JSON.stringify(reportFromMemory));
      expect(renderBatchReport(reportFromDisk, 'en')).toBe(renderBatchReport(reportFromMemory, 'en'));

      const report = reportFromDisk;
      const irreversible = report.blockedIrreversible.find((b) => b.kind === 'irreversible' && b.itemId === itemId);
      const assumptionGate = report.blockedIrreversible.find((b) => b.kind === 'assumption-gate' && b.itemId === itemId);
      expect(irreversible).toBeDefined();
      expect(assumptionGate).toBeDefined();
      expect(irreversible?.owner).toBe('report-owner');
      expect(irreversible?.slaSeconds).toBeNull();
      expect(irreversible?.defaultDecision).toBeNull();
      expect(assumptionGate?.gatedAssumptionIds.length).toBe(1);

      // §8 amendment: irreversible sorts first among blocking checkpoints.
      const irreversibleIndex = report.blockedIrreversible.findIndex((b) => b.kind === 'irreversible');
      const assumptionGateIndex = report.blockedIrreversible.findIndex((b) => b.kind === 'assumption-gate');
      expect(irreversibleIndex).toBeLessThan(assumptionGateIndex);

      expect(report.unresolvedAssumptions.length).toBeGreaterThan(0);
      const rendered = renderBatchReport(report, 'en');
      expect(rendered).not.toContain('generatedAt');
    } finally {
      await rmEnv(env);
    }
  }, 60_000);

  it('unresolved assumptions render deepest first, and an escalated one is flagged', async () => {
    const roleTypes: Record<Role, RoleExecutorType> = {
      analyst: 'codex', architect: 'stub', planner: 'stub', testAuthor: 'stub', coder: 'stub', reviewer: 'stub',
    };
    const roleAccounts: Record<Role, string> = {
      analyst: 'codex-depths', architect: 'codex-depths', planner: 'codex-depths', testAuthor: 'codex-depths',
      coder: 'codex-depths', reviewer: 'codex-depths',
    };
    const env = await makeEnv('report-depths', (targetRepo) =>
      buildConfigYaml({ targetRepo, accounts: { 'codex-depths': {} }, roleTypes, roleAccounts }),
    );
    try {
      const requirementSet = {
        ...REQUIREMENT_SET_BASE,
        ambiguities: [
          { question: 'q1', affects: ['REQ-example-1'], options: ['a1', 'a2'], recommended: 'a1' },
          { question: 'q2', affects: ['REQ-example-1'], options: ['b1', 'b2'], recommended: 'b1' },
          { question: 'q3', affects: ['REQ-example-1'], options: ['c1', 'c2'], recommended: 'c1' },
        ],
      };
      const tablePath = await writeArtifactTable(env.workDir, 'report-depths-table', {
        [MODEL_NAMES.analyst]: requirementSet,
      });
      process.env['FAKE_CODEX_MODE'] = 'artifact-by-model';
      process.env['FAKE_CODEX_ARTIFACT_TABLE'] = tablePath;
      let itemId: WorkItemId;
      try {
        const before = await listItemIds(env.storeDir);
        const prd = await writePrd(env.workDir, 'report-depths');
        const exitCode = await runCommand({ prdFile: prd, configPath: env.configPath });
        expect(exitCode).toBe(EXIT.PARKED);
        itemId = await newItemId(env.storeDir, before);
      } finally {
        delete process.env['FAKE_CODEX_MODE'];
        delete process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      }

      const paths = itemPaths(env.storeDir, itemId);
      const events = await readEventsReadOnly(paths.eventsFile, itemId);
      const report = buildBatchReport({ locale: 'en', since: null, items: [{ itemId, events }], corrupt: [] });
      const mine = report.unresolvedAssumptions.filter((a) => a.itemId === itemId);
      expect(mine.map((a) => a.depth)).toEqual([2, 1, 0]);
      expect(mine[0]?.escalated).toBe(true);
      expect(mine[1]?.escalated).toBe(false);
      expect(mine[2]?.escalated).toBe(false);
    } finally {
      await rmEnv(env);
    }
  }, 60_000);
});

// =========================================================================================
// Storage-format invariants (§13 criterion 7): nothing shipped moves.
// =========================================================================================
describe('Phase 5 acceptance: nothing shipped moves', () => {
  it('EVENT_SCHEMA_VERSION and PROJECTION_VERSION are unchanged, and EVENT_TYPES matches its committed snapshot', async () => {
    expect(EVENT_SCHEMA_VERSION).toBe(3);
    expect(PROJECTION_VERSION).toBe(4);

    const snapPath = fileURLToPath(new URL('../core/__snapshots__/events.test.ts.snap', import.meta.url));
    const snapText = await readFile(snapPath, 'utf8');
    const match = /EVENT_TYPES is snapshotted so adding a type is a visible, deliberate diff 1`] = `\n([\s\S]*?)\n`;/.exec(snapText);
    expect(match).not.toBeNull();
    const arrayText = match?.[1] ?? '[]';
    const committedTypes = [...arrayText.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...EVENT_TYPES]).toEqual(committedTypes);
  });
});
