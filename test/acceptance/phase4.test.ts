import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

import { EXIT } from '../../src/cli/exit.js';
import { loadConfig } from '../../src/config/load.js';
import { itemPaths, listItemIds, EventLog } from '../../src/core/log.js';
import { EVENT_SCHEMA_VERSION, ROLES } from '../../src/core/events.js';
import type { MienguEvent, Role } from '../../src/core/events.js';
import { canonicalJson } from '../../src/core/canonical.js';
import { AccountIdSchema, ExecutorInstanceIdSchema, RunIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { PROJECTION_VERSION, WorkItemStateSchema } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';
import { stateHash } from '../../src/state/stateHash.js';
import { policyFromConfig } from '../../src/supervisor/nextStage.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import type { ExecutorHandle, ExecutorRegistry, ResolvedRoleSettings } from '../../src/executors/registry.js';
import { runItem } from '../../src/supervisor/loop.js';
import type { RunItemDeps } from '../../src/supervisor/loop.js';
import { projectAccelerated, projectFromSeq1, readEventsReadOnly, replayCommand } from '../../src/cli/commands/replay.js';
import { wikiRenderCommand } from '../../src/cli/commands/wikiRender.js';
import { reportCommand } from '../../src/cli/commands/report.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import type { PackSourceKind } from '../../src/wiki/contextpack.js';
import { deriveClaims } from '../../src/wiki/records.js';
import { fileMapBodies, stackFactsBodies, systemSkeletonBodies, wikiIndexBodies } from '../../src/wiki/packmaterials.js';
import { renderHumanView } from '../../src/wiki/humanview.js';
import { buildBatchReport, renderBatchReport } from '../../src/report/batch.js';
import type { BatchReportInput } from '../../src/report/batch.js';

// Binding decision (WORK_ORDER_PHASE4.md §8 item 21 / BUILD_PROMPT §11): the Phase 4 gate
// runs against a real `runItem` driven by fake executors and fake oracles only. No real
// vendor binary, no wall-clock dependency: `fixedClock`/`fixedRng`/`StubExecutor` throughout.

const execFileAsync = promisify(execFile);
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

async function initTargetRepo(repo: string): Promise<void> {
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await mkdir(join(repo, 'test'), { recursive: true });
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'README.md'), 'hello\n', 'utf8');
  await writeFile(join(repo, 'test/existing.test.ts'), "test('existing', () => {});\n", 'utf8');
  // Pre-committed and tracked, so the Coder's own rewrite of it shows up in `git diff HEAD`
  // (an untracked new file would not: it is captured separately as `untracked` bytes, never
  // folded into the `diff` pack material — see src/executors/isolation.ts's `capture`).
  await writeFile(join(repo, 'src/x.ts'), 'export const x = 0;\n', 'utf8');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'initial']);
}

function sentinel(kind: string): string {
  return `MIENGU_SENTINEL_${kind.toUpperCase().replace(/-/g, '_')}`;
}

// ---------------------------------------------------------------------------------------
// Contract-valid artifact bodies, each carrying a sentinel in the one field that ends up
// verbatim in a `PackSourceKind` section, so a real run's real prompt bytes can be checked
// for leakage without hand-writing candidate sections (unlike test/wiki/isolation.test.ts,
// which is exhaustive but synthetic).
// ---------------------------------------------------------------------------------------

const REQUIREMENT_SET_P4 = {
  requirements: [
    {
      req_id: 'REQ-example-1',
      statement: sentinel('requirement-set'),
      rationale: 'because Y',
      acceptance: ['X is observable'],
      priority: 'must',
      source_span: 'prd:1',
    },
  ],
  ambiguities: [],
  out_of_scope: [],
};

const ARCHITECTURE_PLAN_P4 = {
  decisions: [
    {
      decision_id: 'decision-example-1',
      title: 'pick an approach',
      choice: sentinel('architecture-decisions'),
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
      responsibility: sentinel('architecture-components'),
      paths: ['src/x.ts'],
      depends_on: [],
    },
  ],
  interfaces: [
    {
      interface_id: 'interface-example-1',
      component_id: 'component-example-1',
      signature: 'doX(): void',
      behaviour: sentinel('architecture-interfaces'),
      req_ids: ['REQ-example-1'],
    },
  ],
};

const TASK_GRAPH_P4 = {
  tasks: [
    {
      task_id: 'task-example-1',
      title: sentinel('task'),
      req_ids: ['REQ-example-1'],
      component_ids: ['component-example-1'],
      expected_paths: ['src/x.ts'],
      depends_on: [],
      definition_of_done: ['X works'],
      estimated_turns: 1,
    },
  ],
};

const TEST_SUITE_DRAFT_P4 = {
  suite_id: 'suite-example-1',
  cases: [
    {
      test_id: 'test-example-1',
      req_ids: ['REQ-example-1'],
      path: 'test/a.test.ts',
      intent: sentinel('frozen-test-list'),
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

const IMPLEMENTATION_P4 = {
  task_id: 'task-example-1',
  diff_ref: 'diffref',
  files_touched: ['src/x.ts'],
  assumption_ids: [],
  deviations: [],
};

const REVIEW_VERDICT_P4 = {
  task_id: 'task-example-1',
  verdict: 'accept',
  findings: [],
  escalate_to: null,
};

/** Every sentinel-carrying `PackSourceKind` a real run produces, mapped to every kind that
 *  content could legitimately be classified as (the wiki-sourced materials duplicate content
 *  across kinds — a component's responsibility is both `architecture-components` prose AND
 *  the text `wikiIndexBodies`/`systemSkeletonBodies` derive from the same claim). A role is
 *  checked for a sentinel only when EVERY kind it could arrive under is in that role's
 *  `omits` (binding decision derived from `ROLE_PACK_POLICY`, never hand-written per role). */
const SENTINEL_KIND_MAP: Readonly<Record<string, readonly PackSourceKind[]>> = {
  [sentinel('requirement-set')]: ['requirement-set'],
  [sentinel('architecture-decisions')]: ['architecture-decisions'],
  [sentinel('architecture-components')]: ['architecture-components', 'wiki-index', 'system-skeleton'],
  [sentinel('architecture-interfaces')]: ['architecture-interfaces', 'system-skeleton'],
  [sentinel('task')]: ['task'],
  [sentinel('frozen-test-list')]: ['frozen-test-list'],
  [sentinel('frozen-test-bodies')]: ['frozen-test-bodies'],
  [sentinel('diff')]: ['diff'],
};

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

function sentinelScripts(): Partial<Record<Role, StubScript>> {
  return {
    analyst: completedStep(REQUIREMENT_SET_P4),
    architect: completedStep(ARCHITECTURE_PLAN_P4),
    planner: completedStep(TASK_GRAPH_P4),
    testAuthor: completedStep(TEST_SUITE_DRAFT_P4, {
      'test/a.test.ts': `${sentinel('frozen-test-bodies')}\n`,
      'test/b.test.ts': 'test body B\n',
    }),
    coder: completedStep(IMPLEMENTATION_P4, {
      'src/x.ts': `${sentinel('diff')}\n`,
    }),
    reviewer: completedStep(REVIEW_VERDICT_P4),
  };
}

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

function configYaml(targetRepo: string): string {
  return stringify({
    target: { repo: targetRepo },
    accounts: { 'stub-account': {} },
    executors: Object.fromEntries(ROLES.map((r) => [EXECUTOR_ID_FOR_ROLE[r], { type: 'stub', account: 'stub-account' }])),
    tiers: Object.fromEntries(ROLES.map((r) => [EXECUTOR_ID_FOR_ROLE[r], 1])),
    roles: Object.fromEntries(
      ROLES.map((r) => [r, { executor: EXECUTOR_ID_FOR_ROLE[r], maxTurns: 8, contextBudgetTokens: 40_000 }]),
    ),
    store: { dir: '.miengu', snapshotEvery: 200 },
  });
}

interface Ctx {
  targetRepo: string;
  workDir: string;
  configPath: string;
  storeDir: string;
  itemId: ReturnType<typeof WorkItemIdSchema.parse>;
  log: EventLog;
  events: readonly MienguEvent[];
}

let ctx: Ctx;

describe('Phase 4 acceptance: claims, provenance, context isolation, human view, batch report', () => {
  beforeAll(async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-p4-target-'));
    const workDir = await mkdtemp(join(tmpdir(), 'miengu-p4-work-'));
    await initTargetRepo(targetRepo);

    const configPath = join(workDir, 'miengu.config.yaml');
    await writeFile(configPath, configYaml(targetRepo), 'utf8');

    const loaded = await loadConfig(configPath);
    const storeDir = loaded.storeDir;
    const itemId = WorkItemIdSchema.parse('wi-phase4-accept');
    const runId = RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef');
    const clock = fixedClock(START);
    const ids = createIdMinter(fixedRng('phase4-accept'));

    const { log } = await EventLog.create({ storeDir, itemId, runId, clock, ids, logger: silentLogger });
    await log.append({
      type: 'WorkItemCreated',
      data: {
        title: 'Phase 4 acceptance item',
        slug: 'phase4-accept',
        source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
        config_hash: loaded.configHash,
      },
      actor: { kind: 'system', id: null },
      causationId: null,
    });
    // Mirrors src/cli/commands/run.ts's own append sequence around `runItem`: `RunStarted`
    // carries the real loaded config, which is what makes `target.mode`/`target.baseRef`
    // (and, were oracle commands configured, `oracle.*`) real `stack-fact` claims — the only
    // T0-reachable claim kind (decision 4).
    await log.append({
      type: 'RunStarted',
      data: {
        miengu_version: '0.1.0',
        node_version: process.version,
        config_hash: loaded.configHash,
        config: loaded.config,
      },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });

    const paths = itemPaths(storeDir, itemId);
    const snapshots = createSnapshotStore<WorkItemState>({
      dir: paths.snapshotsDir,
      itemId,
      projectionVersion: 1,
      hashState: stateHash,
      parseState: (v) => WorkItemStateSchema.parse(v),
    });

    const deps: RunItemDeps = {
      log,
      snapshots,
      config: loaded.config,
      policy: policyFromConfig(loaded.config),
      executors: makeStubRegistry(sentinelScripts(), 'phase4-accept-exec'),
      workspace: createWorkspaceProvider('worktree'),
      targetRepo: loaded.targetRepo,
      workspacesDir: paths.workspacesDir,
      promptsDir: join(paths.itemDir, 'prompts'),
      schemasDir: join(paths.itemDir, 'schemas'),
      messagesDir: join(paths.itemDir, 'messages'),
      frozenTestsDir: join(paths.itemDir, 'frozen-tests'),
      clock,
      ids,
      logger: silentLogger,
      signal: new AbortController().signal,
      retainWorkspace: false,
    };

    const result = await runItem(deps);
    expect(result.outcome).toBe('completed');

    await log.append({
      type: 'RunFinished',
      data: { outcome: result.outcome, events_appended: log.lastSeq },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });

    const events = await log.readAll();

    ctx = { targetRepo, workDir, configPath, storeDir, itemId, log, events };
  }, 60_000);

  afterAll(async () => {
    await ctx.log.close().catch(() => undefined);
    await rm(ctx.targetRepo, { recursive: true, force: true });
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------------------
  // Acceptance criterion 1 — each agent's pack provably excludes its "never sees" column,
  // proven over the actual prompt bytes an executor received in a real run, not a re-run of
  // the exhaustive synthetic proof in test/wiki/isolation.test.ts.
  // ---------------------------------------------------------------------------------------
  describe('criterion 1: context isolation over a real run\'s prompt bytes', () => {
    it('captures every ExecutorInvoked with a recoverable prompt file', async () => {
      const invoked = ctx.events.filter((e) => e.type === 'ExecutorInvoked');
      expect(invoked.length).toBeGreaterThanOrEqual(ROLES.length);
      for (const e of invoked) {
        if (e.type !== 'ExecutorInvoked') continue;
        expect(e.data.prompt_path).not.toBeNull();
        await expect(readFile(e.data.prompt_path as string, 'utf8')).resolves.toBeTruthy();
      }
    });

    it('for each role, every ExecutorInvoked prompt excludes every sentinel whose every possible kind is in that role\'s omits (derived from ROLE_PACK_POLICY, not hand-written)', async () => {
      const invoked = ctx.events.filter((e) => e.type === 'ExecutorInvoked');
      for (const e of invoked) {
        if (e.type !== 'ExecutorInvoked' || e.data.role === null) continue;
        const role = e.data.role;
        const promptPath = e.data.prompt_path;
        expect(promptPath).not.toBeNull();
        if (promptPath === null) continue;
        const promptText = await readFile(promptPath, 'utf8');
        const omits = ROLE_PACK_POLICY[role].omits;
        for (const [sentinelText, kinds] of Object.entries(SENTINEL_KIND_MAP)) {
          const fullyOmitted = kinds.every((k) => omits.includes(k));
          if (fullyOmitted) {
            expect(promptText).not.toContain(sentinelText);
          }
        }
      }
    });

    it('the two load-bearing rows, asserted by name: the Test Author never sees the component map, wiki index, system skeleton, task graph or diff', async () => {
      const testAuthorInvoked = ctx.events.find(
        (e) => e.type === 'ExecutorInvoked' && e.data.role === 'testAuthor',
      );
      expect(testAuthorInvoked).toBeDefined();
      if (testAuthorInvoked === undefined || testAuthorInvoked.type !== 'ExecutorInvoked') return;
      const promptPath = testAuthorInvoked.data.prompt_path;
      expect(promptPath).not.toBeNull();
      if (promptPath === null) return;
      const promptText = await readFile(promptPath, 'utf8');
      for (const kind of [
        'architecture-components', 'wiki-index', 'system-skeleton', 'task', 'diff',
      ] as const) {
        expect(ROLE_PACK_POLICY.testAuthor.omits).toContain(kind);
      }
      expect(promptText).not.toContain(sentinel('architecture-components'));
      expect(promptText).not.toContain(sentinel('task'));
      expect(promptText).not.toContain(sentinel('diff'));
      // The Test Author still legitimately sees requirements and interfaces (§5 of
      // BUILD_PROMPT): a positive sanity check that the exclusions above are not merely
      // vacuous because nothing was ever rendered into this prompt at all.
      expect(promptText).toContain(sentinel('requirement-set'));
      expect(promptText).toContain(sentinel('architecture-interfaces'));
    });

    it('the Reviewer never receives a coder-transcript section: no RawPackMaterials field backs that kind, and the policy names it', () => {
      // `coder-transcript` has no producer anywhere in RawPackMaterials (Group B, decision 11:
      // Phase 4 adds no PackSourceKind and no role's includes list names it) — there is
      // structurally no content that could ever reach a prompt under that kind. Asserting on
      // the literal substring "coder-transcript" would be a false positive: the reviewer's own
      // prompt template (src/agents/prompts/reviewer.md) documents the omission in prose. The
      // honest proof is the policy assertion plus the positive evidence that the Reviewer's
      // pack is real and non-empty (so the absence is not merely because nothing rendered).
      expect(ROLE_PACK_POLICY.reviewer.omits).toContain('coder-transcript');
      const reviewerInvoked = ctx.events.find((e) => e.type === 'ExecutorInvoked' && e.data.role === 'reviewer');
      expect(reviewerInvoked).toBeDefined();
    });

    it('sanity: the Reviewer\'s prompt genuinely contains the diff and frozen-test-list sentinels, proving the exclusions above are not vacuous', async () => {
      const reviewerInvoked = ctx.events.find((e) => e.type === 'ExecutorInvoked' && e.data.role === 'reviewer');
      expect(reviewerInvoked).toBeDefined();
      if (reviewerInvoked === undefined || reviewerInvoked.type !== 'ExecutorInvoked') return;
      const promptPath = reviewerInvoked.data.prompt_path;
      expect(promptPath).not.toBeNull();
      if (promptPath === null) return;
      const promptText = await readFile(promptPath, 'utf8');
      expect(promptText).toContain(sentinel('diff'));
      expect(promptText).toContain(sentinel('frozen-test-list'));
      // But never the frozen test BODY (reviewer.omits includes 'frozen-test-bodies'): the
      // list of names/intents is allowed, the bodies are not (§15.6: "the frozen test list
      // (names and intents, not bodies)").
      expect(ROLE_PACK_POLICY.reviewer.omits).toContain('frozen-test-bodies');
      expect(promptText).not.toContain(sentinel('frozen-test-bodies'));
    });
  });

  // ---------------------------------------------------------------------------------------
  // Acceptance criterion 2 — the report renders from the log alone.
  // ---------------------------------------------------------------------------------------
  describe('criterion 2: the report renders from the log alone', () => {
    it('is byte-identical whether built from readEventsReadOnly(disk) or from the in-memory appended events', async () => {
      const paths = itemPaths(ctx.storeDir, ctx.itemId);
      const fromDisk = await readEventsReadOnly(paths.eventsFile, ctx.itemId);

      const inputFromDisk: BatchReportInput = {
        locale: 'en',
        since: null,
        items: [{ itemId: ctx.itemId, events: fromDisk }],
        corrupt: [],
      };
      const inputFromMemory: BatchReportInput = {
        locale: 'en',
        since: null,
        items: [{ itemId: ctx.itemId, events: ctx.events }],
        corrupt: [],
      };

      // No WorkItemState is ever passed in: BatchReportItemInput's own type carries only
      // `itemId` and `events` (checked structurally here, not merely asserted in prose).
      expect(Object.keys(inputFromDisk.items[0] as object).sort()).toEqual(['events', 'itemId']);

      const reportFromDisk = buildBatchReport(inputFromDisk);
      const reportFromMemory = buildBatchReport(inputFromMemory);

      expect(canonicalJson(reportFromDisk)).toBe(canonicalJson(reportFromMemory));
      expect(renderBatchReport(reportFromDisk, 'en')).toBe(renderBatchReport(reportFromMemory, 'en'));
    });

    it('buildBatchReport performs no filesystem I/O of its own (static source audit: no node: import, no fs call)', async () => {
      // `vi.spyOn` cannot redefine a live ESM namespace binding (node:fs/promises' own
      // exports are non-configurable), so the runtime proof here is the same kind
      // test/wiki/boundary.test.ts already uses for the human-view boundary: read the actual
      // shipped source and assert it names no `node:` module and calls no fs primitive.
      const source = await readFile(new URL('../../src/report/batch.ts', import.meta.url), 'utf8');
      expect(source).not.toMatch(/from ['"]node:/);
      expect(source).not.toMatch(/\breadFile\b|\bwriteFile\b|\breaddir\b|\bstat\(/);
    });
  });

  // ---------------------------------------------------------------------------------------
  // Claim ids are stable across a full replay.
  // ---------------------------------------------------------------------------------------
  it('claim ids are stable across a full replay: deriveClaims(disk) equals deriveClaims(memory)', async () => {
    const paths = itemPaths(ctx.storeDir, ctx.itemId);
    const fromDisk = await readEventsReadOnly(paths.eventsFile, ctx.itemId);
    const claimsFromDisk = deriveClaims(fromDisk);
    const claimsFromMemory = deriveClaims(ctx.events);
    expect(canonicalJson(claimsFromDisk)).toBe(canonicalJson(claimsFromMemory));
    expect(claimsFromDisk.claims.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------------------
  // A quarantined claim is absent from every future pack, present in the wiki and the
  // report.
  // ---------------------------------------------------------------------------------------
  it('a quarantined claim (injected DriftDetected) is absent from every future pack, present in the wiki and the report', async () => {
    const before = deriveClaims(ctx.events);
    const componentClaim = before.claims.find((c) => c.kind === 'component' && c.subject === 'component-example-1');
    expect(componentClaim).toBeDefined();
    if (componentClaim === undefined) return;
    expect(componentClaim.status).toBe('active');
    expect(componentClaim.statement).toBe(sentinel('architecture-components'));

    const expectedText = sentinel('quarantine-expected');
    const observedText = sentinel('quarantine-observed');
    await ctx.log.append({
      type: 'DriftDetected',
      data: { claim: componentClaim.id, expected: expectedText, observed: observedText, area: null },
      actor: { kind: 'system', id: null },
      causationId: ctx.log.lastEventId,
    });

    const updated = await ctx.log.readAll();
    ctx.events = updated;
    const after = deriveClaims(updated);
    const quarantined = after.byId[componentClaim.id];
    expect(quarantined).toBeDefined();
    expect(quarantined?.status).toBe('quarantined');
    expect(quarantined?.quarantine?.expected).toBe(expectedText);
    expect(quarantined?.quarantine?.observed).toBe(observedText);
    // Retained in full, byte-identical statement to its pre-quarantine rendering.
    expect(quarantined?.statement).toBe(sentinel('architecture-components'));

    // Absent from every future pack material: the only component claim was just quarantined,
    // so both wiki-index and system-skeleton (which read activeClaims only) become empty.
    expect(wikiIndexBodies(after)).toEqual([]);
    expect(systemSkeletonBodies(after).some((b) => b.body.includes(sentinel('architecture-components')))).toBe(false);
    // The interface claim was never quarantined (only the component claim was), so its own
    // sentinel legitimately remains — proving the exclusion above is targeted, not a blanket
    // wipe of every architecture-derived body.
    expect(systemSkeletonBodies(after).some((b) => b.body.includes(sentinel('architecture-interfaces')))).toBe(true);
    expect(fileMapBodies(after).some((b) => b.body.includes('src/x.ts'))).toBe(true); // observed file claim unaffected
    for (const body of [...wikiIndexBodies(after), ...systemSkeletonBodies(after), ...stackFactsBodies(after)]) {
      expect(body.body).not.toContain(sentinel('architecture-components'));
    }

    // Present in the wiki, struck, under "Quarantined", with its contradicting observation.
    const files = renderHumanView({ language: 'en', items: [{ itemId: ctx.itemId, events: updated }] });
    const componentFile = files.find((f) => f.path === 'wiki/components/component-example-1.md');
    expect(componentFile).toBeDefined();
    expect(componentFile?.content).toContain('Quarantined');
    expect(componentFile?.content).toContain(`~~${sentinel('architecture-components')}~~`);
    expect(componentFile?.content).toContain(expectedText);
    expect(componentFile?.content).toContain(observedText);

    // Present in the report, under drift, marked resolved by quarantine.
    const report = buildBatchReport({
      locale: 'en',
      since: null,
      items: [{ itemId: ctx.itemId, events: updated }],
      corrupt: [],
    });
    const driftEntry = report.drift.find((d) => d.claimId === componentClaim.id);
    expect(driftEntry).toBeDefined();
    expect(driftEntry?.resolution).toBe('claim-quarantined');
    expect(driftEntry?.expected).toBe(expectedText);
    expect(driftEntry?.observed).toBe(observedText);
  });

  // ---------------------------------------------------------------------------------------
  // wiki render is idempotent and never deletes a file it does not own.
  // ---------------------------------------------------------------------------------------
  it('wiki render is idempotent: running it twice over the completed store produces byte-identical files and zero removals', async () => {
    async function renderJson(): Promise<{ files: { path: string; sha256: string; bytes: number }[]; removed: string[] }> {
      let output = '';
      const originalWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: unknown) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      let exitCode: number;
      try {
        exitCode = await wikiRenderCommand({ configPath: ctx.configPath, json: true });
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(exitCode).toBe(EXIT.OK);
      return JSON.parse(output) as { files: { path: string; sha256: string; bytes: number }[]; removed: string[] };
    }

    const first = await renderJson();
    expect(first.files.length).toBeGreaterThan(0);
    const second = await renderJson();
    expect(second.removed).toEqual([]);
    expect(second.files).toEqual(first.files);
  });

  // ---------------------------------------------------------------------------------------
  // Storage-format invariants: no event type added, no projection bump, replay still MATCHes.
  // ---------------------------------------------------------------------------------------
  it('EVENT_SCHEMA_VERSION and PROJECTION_VERSION are unchanged, and miengu replay reports MATCH', async () => {
    expect(EVENT_SCHEMA_VERSION).toBe(3);
    expect(PROJECTION_VERSION).toBe(3);

    const replayResult = await replayCommand({ itemId: ctx.itemId, configPath: ctx.configPath, json: true });
    expect(replayResult).toBe(EXIT.OK);

    const scratch = await projectFromSeq1(ctx.storeDir, ctx.itemId);
    const accelerated = await projectAccelerated(ctx.storeDir, ctx.itemId);
    expect(stateHash(scratch)).toBe(stateHash(accelerated.state));
  });

  // ---------------------------------------------------------------------------------------
  // Neither a human checkpoint acceptance nor an auto-approval promotes a claim to T0.
  // ---------------------------------------------------------------------------------------
  it('neither CheckpointDecided{accept, by: human} nor AutoApproved promotes a claim to T0; the run\'s T0 claim set is exactly its stack-fact claims', async () => {
    const before = deriveClaims(ctx.events);
    const t0Before = before.claims.filter((c) => c.tier === 'T0');
    expect(t0Before.length).toBeGreaterThan(0);
    expect(t0Before.every((c) => c.kind === 'stack-fact')).toBe(true);

    const raised = await ctx.log.append({
      type: 'CheckpointRaised',
      data: {
        checkpoint: 'cp-phase4-1',
        kind: 'irreversible',
        stage: 'architecture',
        summary: "decision 'decision-example-1' is irreversible: pick an approach",
        blocking: true,
        sla_seconds: null,
        default_decision: null,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: ctx.log.lastEventId,
    });
    await ctx.log.append({
      type: 'CheckpointDecided',
      data: { checkpoint: 'cp-phase4-1', decision: 'accept', by: 'human', reason: null },
      actor: { kind: 'human', id: 'operator' },
      causationId: raised.event_id,
    });
    const raisedAuto = await ctx.log.append({
      type: 'CheckpointRaised',
      data: {
        checkpoint: 'cp-phase4-2',
        kind: 'agent-originated',
        stage: 'architecture',
        summary: 'agent-originated checkpoint',
        blocking: false,
        sla_seconds: 3600,
        default_decision: 'accept',
      },
      actor: { kind: 'supervisor', id: null },
      causationId: ctx.log.lastEventId,
    });
    await ctx.log.append({
      type: 'AutoApproved',
      data: { checkpoint: 'cp-phase4-2', after: 'PT1H', no_human_response: true },
      actor: { kind: 'system', id: null },
      causationId: raisedAuto.event_id,
    });

    const updated = await ctx.log.readAll();
    ctx.events = updated;
    const after = deriveClaims(updated);

    // Every claim minted before these checkpoint events keeps its exact prior tier and
    // status (open question 1, ruled: human acceptance promotes nothing).
    for (const claim of before.claims) {
      const stillThere = after.byId[claim.id];
      expect(stillThere).toBeDefined();
      expect(stillThere?.tier).toBe(claim.tier);
      expect(stillThere?.status).toBe(claim.status);
    }

    const t0After = after.claims.filter((c) => c.tier === 'T0');
    const stackFactIds = after.claims.filter((c) => c.kind === 'stack-fact').map((c) => c.id).sort();
    expect(t0After.map((c) => c.id).sort()).toEqual(stackFactIds);
  });

  // ---------------------------------------------------------------------------------------
  // §9's final acceptance gate line: `report` and `wiki render` are read-only and exit OK
  // over the completed store (a corrupt-item exit path is exhaustively covered by
  // test/cli/report.test.ts and test/cli/wikiRender.test.ts; this exercises the healthy path
  // against the exact store this file's own run produced).
  // ---------------------------------------------------------------------------------------
  it('report and wiki render both exit EXIT.OK over the completed store, even while this file\'s own writer lock is still held', async () => {
    const itemIds = await listItemIds(ctx.storeDir);
    expect(itemIds).toContain(ctx.itemId);

    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let exitCode: number;
    try {
      // `ctx.log` (opened in beforeAll and not yet closed) still holds this item's writer
      // lock at this point in the suite. `reportCommand` succeeding here — rather than
      // throwing `LockHeldError` — is itself the proof that it never tries to acquire that
      // lock (§7: "Both commands are read-only: no write lock").
      exitCode = await reportCommand({ configPath: ctx.configPath, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exitCode).toBe(EXIT.OK);
    const report = JSON.parse(output) as { generatedFrom: { items: number } };
    expect(report.generatedFrom.items).toBe(1);
  });
});
