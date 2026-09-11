import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureBrownfieldEvidence } from '../../src/brownfield/bootstrap.js';
import { collectGit } from '../../src/brownfield/git.js';
import { collectSkeleton } from '../../src/brownfield/skeleton.js';
import { collectTests } from '../../src/brownfield/tests.js';
import type { PredicateRunner } from '../../src/brownfield/types.js';
import { compareClaims, dedupeDrift, isTouched } from '../../src/integrator/drift.js';
import { EVENT_SCHEMA_VERSION, ROLES } from '../../src/core/events.js';
import type { AppendInput, EventLog, OpenLogOptions } from '../../src/core/log.js';
import { EventLog as EventLogClass, itemPaths } from '../../src/core/log.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { ClaimIdSchema, EventIdSchema, RunIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import type { Claim } from '../../src/wiki/records.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { silentLogger } from '../../src/logging.js';
import { projectFromSeq1, projectAccelerated } from '../../src/cli/commands/replay.js';
import { createSnapshotStore } from '../../src/core/snapshot.js';
import { PROJECTION_VERSION, WorkItemStateSchema } from '../../src/state/workitem.js';
import { stateHash } from '../../src/state/stateHash.js';

const execFileAsync = promisify(execFile);
const FIXTURE = fileURLToPath(new URL('../fixtures/brownfield', import.meta.url));
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const ITEM = WorkItemIdSchema.parse('wi-phase6-accept');
const OTHER_ITEM = WorkItemIdSchema.parse('wi-phase6-hotfix');
const RUN = RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef');
const SHA = 'a'.repeat(64);

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

async function target(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'miengu-phase6-target-'));
  dirs.push(root);
  await cp(FIXTURE, root, { recursive: true });
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'bootstrap hot module']);
  return root;
}

function options(storeDir: string, itemId = ITEM): OpenLogOptions {
  return { storeDir, itemId, runId: RUN, clock: fixedClock(START, 1000), ids: createIdMinter(fixedRng(`phase6-${itemId}`)), logger: silentLogger };
}

const CREATED: AppendInput = {
  type: 'WorkItemCreated',
  data: { title: 'Phase 6 fixture', slug: 'phase6-fixture', source: { kind: 'prd-file', path: 'prd.md', sha256: SHA, bytes: 1 }, config_hash: 'fixture' },
  actor: { kind: 'system', id: null }, causationId: null,
};

async function createLog(storeDir: string, itemId = ITEM): Promise<EventLog> {
  const { log } = await EventLogClass.create(options(storeDir, itemId));
  await log.append(CREATED);
  return log;
}

function collector() {
  return { collectSkeleton, collectGit, collectTests };
}

const predicateRunner: PredicateRunner = {
  async evaluate(input) {
    return { data: {
      proposal_event_id: input.proposalEventId, target_commit: input.targetCommit,
      outcome: 'confirmed', reason: 'predicate-true', expected: 'true', observed: 'true', duration_ms: 0,
      evidence: { sha256: SHA, path: 'predicate.json', bytes: 1 },
    } };
  },
};

async function ensure(log: EventLog, targetRoot: string, stage: 'analysis' | 'planning' | 'implementation', enabled = true) {
  const events = await log.readAll();
  const evidenceDir = itemPaths(join(targetRoot, '.miengu'), ITEM).brownfieldDir;
  await mkdir(evidenceDir, { recursive: true });
  return ensureBrownfieldEvidence({
    enabled, stage, itemId: ITEM, events, targetRoot, storeDir: join(targetRoot, '.miengu'), workspaceMetadataDirs: [],
    targetCommit: 'base-fixture', targetRepoSha256: SHA, evidenceDir, collectorVersion: 1,
    limits: { maxTreeEntries: 100, maxFileBytes: 100_000, maxTestExcerptBytes: 1_000, maxGitCommits: 20, maxFilesPerCommit: 20, maxFilesPerScope: 20, maxDependencyDepth: 1 },
    configuredTestCommand: 'test', dependencyEdges: [], architecturePlan: null, taskGraph: null, activeTaskId: null,
    collector: collector(), predicateRunner, predicatePolicy: { maxPredicatesPerScope: 8, maxWallSeconds: 1, maxOutputBytes: 1024, commands: {}, sandbox: null }, signal: null,
    append: (input) => log.append(input), readStore: async () => ({ items: [{ itemId: ITEM, events: await log.readAll() }], corrupt: [] }),
  });
}

function claim(itemId = OTHER_ITEM): Claim {
  return {
    id: ClaimIdSchema.parse('claim-hotfix-1'), itemId, kind: 'component', subject: 'hotfix', statement: 'expected', tier: 'T2', agentOriginated: false, status: 'active',
    trace: { reqIds: [], componentIds: [], taskIds: [], decisionIds: [], paths: ['src/hot.ts'] }, originEventId: EventIdSchema.parse('evt-00000000-0000-0000-0000-000000000001'), originSeq: 1,
    at: START, supersededByClaimId: null, supersedesClaimId: null, quarantine: null,
  };
}

describe('Phase 6 brownfield acceptance', () => {
  it('collects the five-tier ladder lazily, excludes unrelated subtrees, and reuses evidence at a pinned base', async () => {
    const root = await target();
    const store = await mkdtemp(join(tmpdir(), 'miengu-phase6-store-'));
    dirs.push(store);
    const log = await createLog(store);
    try {
      const analysis = await ensure(log, root, 'analysis');
      expect(analysis.evidence.map((event) => event.data.ladder_tier)).toEqual(['mechanical-skeleton']);

      const planning = await ensure(log, root, 'planning');
      expect(planning.evidence.map((event) => event.data.ladder_tier).sort()).toEqual(['git-archaeology', 'tests-as-spec']);
      const evidence = (await log.readAll()).filter((event) => event.type === 'BrownfieldEvidenceRecorded');
      expect(evidence).toHaveLength(3);
      const deepEvidence = evidence.filter((event) => event.data.ladder_tier !== 'mechanical-skeleton');
      expect(deepEvidence.flatMap((event) => event.data.scope.paths)).toContain('src/hot.ts');
      // Tier 0 is deliberately a whole-tree mechanical skeleton.  The lazy deep tiers must
      // not turn that bounded inventory into an unrelated-code comprehension pass.
      expect(deepEvidence.flatMap((event) => event.data.scope.paths)).not.toContain('unrelated/ignored.ts');
      const testsAsSpec = await collectTests({
        targetRoot: root, targetCommit: 'base-fixture', storeDir: null, workspaceMetadataDirs: [],
        limits: { maxTreeEntries: 100, maxFileBytes: 100_000, maxTestExcerptBytes: 1_000, maxGitCommits: 20, maxFilesPerCommit: 20 },
        scope: { roots: ['test/hot.spec.ts'], paths: ['test/hot.spec.ts'], rejectedFrontier: [], dependencyDepth: 0, truncated: false, sha256: SHA },
        configuredTestCommand: null, dependencyEdges: [],
      });
      expect(testsAsSpec.facts).toContainEqual(expect.objectContaining({ kind: 'test-spec', path: 'test/hot.spec.ts', test_id: 'hot' }));

      const scope = evidence.find((event) => event.data.ladder_tier === 'git-archaeology')?.data.scope.sha256;
      expect(scope).toBeDefined();
      await log.append({ type: 'BrownfieldPredicateProposed', actor: { kind: 'system', id: null }, causationId: null, data: {
        target_commit: 'base-fixture', scope_sha256: scope ?? '', subject: null, assertion: 'hot module exists', area: 'src', predicate: { kind: 'path-exists', path: 'src/hot.ts', expected: true },
      } });
      const implementation = await ensure(log, root, 'implementation');
      expect(implementation.evaluations).toHaveLength(1);
      expect((await log.readAll()).some((event) => event.type === 'BrownfieldPredicateEvaluated')).toBe(true);
      expect((await ensure(log, root, 'implementation')).evidence).toHaveLength(0);
      expect((await ensure(log, root, 'implementation')).evaluations).toHaveLength(0);
    } finally { await log.close(); }
  });

  it('keeps role visibility exact and makes disabled and partial collection honest', async () => {
    for (const role of ROLES) {
      const policy = ROLE_PACK_POLICY[role];
      const seesBrownfield = policy.includes.filter((kind) => kind.startsWith('brownfield-'));
      expect(seesBrownfield).toEqual(['architect', 'planner', 'coder', 'reviewer'].includes(role)
        ? ['brownfield-history', 'brownfield-falsification', 'brownfield-drift'] : []);
    }
    const root = await target();
    const store = await mkdtemp(join(tmpdir(), 'miengu-phase6-disabled-'));
    dirs.push(store);
    const log = await createLog(store);
    try {
      expect((await ensure(log, root, 'analysis', false)).evidence).toEqual([]);
      expect((await log.readAll())).toHaveLength(1);
      const partial = await collectGit({ targetRoot: join(root, 'not-a-repository'), targetCommit: 'missing', storeDir: null, workspaceMetadataDirs: [], limits: { maxTreeEntries: 10, maxFileBytes: 100, maxTestExcerptBytes: 100, maxGitCommits: 1, maxFilesPerCommit: 1 }, scope: { roots: ['src/hot.ts'], paths: ['src/hot.ts'], rejectedFrontier: [], dependencyDepth: 0, truncated: false, sha256: SHA }, configuredTestCommand: null, dependencyEdges: [] });
      expect(partial.coverage).toBe('partial');
      expect(partial.omissions.length).toBeGreaterThan(0);
    } finally { await log.close(); }
  });

  it('records qualified cross-item hotfix drift once, exposes only touched drift, and preserves changed observations', () => {
    const targetClaim = claim();
    const candidates = compareClaims({ claims: [targetClaim], observations: [{ kind: 'predicate', claimItem: OTHER_ITEM, claim: targetClaim.id, outcome: 'refuted', expected: 'expected', observed: 'actual', area: 'src', paths: ['src/hot.ts'] }] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ claimItem: OTHER_ITEM, claim: targetClaim.id, area: 'src/hot.ts' });
    expect(isTouched({ candidate: candidates[0]!, relevantComponentIds: [], selectedScopePaths: ['src/hot.ts'] })).toBe(true);
    expect(isTouched({ candidate: candidates[0]!, relevantComponentIds: [], selectedScopePaths: ['unrelated/ignored.ts'] })).toBe(false);
    const prior = [{ type: 'DriftDetected', data: { claim_item: OTHER_ITEM, claim: targetClaim.id, expected: candidates[0]!.expected, observed: candidates[0]!.observed, area: candidates[0]!.area } }] as never[];
    expect(dedupeDrift(prior, candidates)).toEqual([]);
    const changed = [{ ...candidates[0]!, observed: '"changed"' }];
    expect(dedupeDrift(prior, changed)).toEqual(changed);
  });

  it('accepts a v3 prefix, appends v4, rejects a projection-4 snapshot, and replays identically', async () => {
    const store = await mkdtemp(join(tmpdir(), 'miengu-phase6-compat-'));
    dirs.push(store);
    const log = await createLog(store);
    await log.append({ type: 'BudgetConsumed', data: { scope: 'item', account: 'acct', wall_seconds: 1, turns: 1, usd: null }, actor: { kind: 'system', id: null }, causationId: null });
    await log.close();
    const paths = itemPaths(store, ITEM);
    const v3 = (await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), schema_version: 3 })).join('\n').concat('\n');
    await writeFile(paths.eventsFile, v3, 'utf8');
    const reopened = await EventLogClass.open(options(store));
    await reopened.log.append({ type: 'BudgetConsumed', data: { scope: 'item', account: 'acct', wall_seconds: 1, turns: 1, usd: null }, actor: { kind: 'system', id: null }, causationId: null });
    await reopened.log.close();
    expect((await readFile(paths.eventsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).schema_version)).toEqual([3, 3, EVENT_SCHEMA_VERSION]);
    const state = await projectFromSeq1(store, ITEM);
    const snapshots = createSnapshotStore({ dir: paths.snapshotsDir, itemId: ITEM, projectionVersion: PROJECTION_VERSION, hashState: stateHash, parseState: (value: unknown) => WorkItemStateSchema.parse(value) });
    await snapshots.write({ projection_version: 4, item_id: ITEM, seq: state.seq, event_id: state.lastEventId!, state_hash: stateHash(state), state });
    const accelerated = await projectAccelerated(store, ITEM);
    expect(accelerated.snapshotSeq).toBeNull();
    expect(stateHash(accelerated.state)).toBe(stateHash(state));
  });
});
