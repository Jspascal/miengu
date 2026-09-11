import { describe, expect, it } from 'vitest';

import { ensureBrownfieldEvidence, isIntentQuestion } from '../../src/brownfield/bootstrap.js';
import { ArchitecturePlanSchema } from '../../src/contracts/index.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';
import type { AppendInput } from '../../src/core/log.js';

describe('brownfield bootstrap', () => {
  it('does nothing while disabled', async () => {
    const result = await ensureBrownfieldEvidence({
      enabled: false,
      stage: 'analysis',
      itemId: WorkItemIdSchema.parse('wi-bootstrap-aaaaaa'),
      events: [], targetRoot: '/target', storeDir: null, workspaceMetadataDirs: [], targetCommit: 'base', targetRepoSha256: '0'.repeat(64), evidenceDir: '/tmp/evidence', collectorVersion: 1,
      limits: { maxTreeEntries: 1, maxFileBytes: 1, maxTestExcerptBytes: 1, maxGitCommits: 1, maxFilesPerCommit: 1, maxFilesPerScope: 1, maxDependencyDepth: 0 },
      configuredTestCommand: null, dependencyEdges: [], architecturePlan: null, taskGraph: null, activeTaskId: null,
      collector: { collectSkeleton: async () => { throw new Error('must not collect'); }, collectGit: async () => { throw new Error('must not collect'); }, collectTests: async () => { throw new Error('must not collect'); } },
      predicateRunner: { evaluate: async () => { throw new Error('must not evaluate'); } },
      predicatePolicy: { maxPredicatesPerScope: 1, maxWallSeconds: 1, maxOutputBytes: 1, commands: {}, sandbox: null }, signal: null,
      append: async () => { throw new Error('must not append'); }, readStore: async () => ({ items: [], corrupt: [] }),
    });
    expect(result).toMatchObject({ evidence: [], evaluations: [], drift: [], touchedDrift: [] });
  });

  it('keeps mechanically answerable questions out of the intent gate', () => {
    expect(isIntentQuestion('Should the product support exports?')).toBe(true);
    expect(isIntentQuestion('Does src/app.ts exist?')).toBe(false);
    expect(isIntentQuestion('Which framework does this repository use?')).toBe(false);
  });

  it('re-exposes a drift first recorded while untouched once a later task neighborhood selects it', async () => {
    const OBS_ITEM = WorkItemIdSchema.parse('wi-obs-aaaaaa');
    const OTHER_ITEM = WorkItemIdSchema.parse('wi-hot-bbbbbb');
    const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';
    const HEX64 = '0'.repeat(64);
    const REPO_SHA = 'a'.repeat(64);

    function hexId(prefix: string, n: number): string {
      const hex = n.toString(16).padStart(32, '0');
      return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    function tsAt(n: number): string {
      return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
    }
    function mkEvent(itemId: string, seq: number, type: EventType, data: unknown): MienguEvent {
      return MienguEventSchema.parse({
        schema_version: 4,
        event_id: hexId('evt', seq),
        seq,
        item_id: itemId,
        run_id: RUN_ID,
        ts: tsAt(seq),
        tier: DEFAULT_TIER[type],
        actor: { kind: 'system', id: null },
        causation_id: null,
        type,
        data,
      });
    }

    const source = { kind: 'prd-file' as const, path: 'prd.md', sha256: REPO_SHA, bytes: 1 };
    const planBody = {
      decisions: [],
      components: [{ component_id: 'component-hot-1', responsibility: 'owns the hot module', paths: ['src/hot.ts'], depends_on: [] }],
      interfaces: [],
      falsifications: [],
    };

    // The claim under observation is minted by a sibling item; the observer only ever sees it
    // through the qualified drift key.
    const otherEvents: MienguEvent[] = [
      mkEvent(OTHER_ITEM, 21, 'WorkItemCreated', { title: 'Hotfix', slug: 'hot', source, config_hash: 'x' }),
      mkEvent(OTHER_ITEM, 22, 'StageCompleted', { stage: 'architecture', attempt: 1, artifact: { kind: 'architecture-plan', sha256: REPO_SHA, body: planBody } }),
    ];

    const obsEvents: MienguEvent[] = [
      mkEvent(OBS_ITEM, 1, 'WorkItemCreated', { title: 'Observer', slug: 'obs', source, config_hash: 'x' }),
      mkEvent(OBS_ITEM, 2, 'BrownfieldEvidenceRecorded', {
        ladder_tier: 'mechanical-skeleton', collector_version: 1, target_repo_sha256: REPO_SHA,
        scope: { target_commit: 'base', roots: [], paths: ['src/hot.ts'], dependency_depth: 0, max_files: 200, truncated: false, sha256: HEX64 },
        coverage: 'complete',
        facts: [{ kind: 'file', path: 'src/hot.ts', sha256: HEX64, bytes: 1 }],
        omissions: [], evidence: { sha256: HEX64, path: 'skeleton.json', bytes: 1 },
      }),
      mkEvent(OBS_ITEM, 3, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: HEX64, subject: { claim_item: OTHER_ITEM, claim: 'claim-hot-1' },
        assertion: 'hot module still present', area: null, predicate: { kind: 'path-exists', path: 'src/hot.ts', expected: true },
      }),
      mkEvent(OBS_ITEM, 4, 'BrownfieldPredicateEvaluated', {
        proposal_event_id: hexId('evt', 3), target_commit: 'base', outcome: 'refuted', reason: 'predicate-false',
        expected: 'present', observed: 'absent', duration_ms: 0, evidence: { sha256: HEX64, path: 'eval.json', bytes: 1 },
      }),
    ];

    const appended: MienguEvent[] = [];
    const append = async (input: AppendInput): Promise<MienguEvent> => {
      const event = mkEvent(OBS_ITEM, 10 + appended.length, input.type, input.data);
      appended.push(event);
      obsEvents.push(event);
      return event;
    };

    const base = {
      enabled: true,
      itemId: OBS_ITEM,
      targetRoot: '/target', storeDir: null, workspaceMetadataDirs: [],
      targetCommit: 'base', targetRepoSha256: REPO_SHA, evidenceDir: '/tmp/evidence', collectorVersion: 1,
      limits: { maxTreeEntries: 100, maxFileBytes: 100, maxTestExcerptBytes: 100, maxGitCommits: 10, maxFilesPerCommit: 10, maxFilesPerScope: 200, maxDependencyDepth: 2 },
      configuredTestCommand: null, dependencyEdges: [], taskGraph: null, activeTaskId: null,
      collector: {
        collectSkeleton: async () => { throw new Error('must not collect'); },
        collectGit: async () => { throw new Error('must not collect'); },
        collectTests: async () => { throw new Error('must not collect'); },
      },
      predicateRunner: { evaluate: async () => { throw new Error('must not evaluate'); } },
      predicatePolicy: { maxPredicatesPerScope: 8, maxWallSeconds: 1, maxOutputBytes: 1024, commands: {}, sandbox: null },
      signal: null,
      append,
      readStore: async () => ({ items: [{ itemId: OTHER_ITEM, events: otherEvents }, { itemId: OBS_ITEM, events: obsEvents }], corrupt: [] }),
    };

    // First pass: no architecture seeds and no task, so the drift's neighbourhood is empty.
    const first = await ensureBrownfieldEvidence({ ...base, stage: 'analysis', events: obsEvents, architecturePlan: null });
    expect(first.drift).toHaveLength(1);
    expect(first.touchedDrift).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe('DriftDetected');
    expect(appended[0]?.data).toMatchObject({
      claim_item: OTHER_ITEM, claim: 'claim-hot-1', expected: '"present"', observed: '"absent"', area: 'component-hot-1',
    });

    // Second pass: an architecture component now puts src/hot.ts in the selected scope. The
    // tuple is already in history, so nothing new is appended, but the drift must now be
    // exposed as touched so it can enter the role pack.
    const plan = ArchitecturePlanSchema.parse({
      decisions: [],
      components: [{ component_id: 'component-obs-1', responsibility: 'observer feature', paths: ['src/hot.ts'], depends_on: [] }],
      interfaces: [],
      falsifications: [],
    });
    const second = await ensureBrownfieldEvidence({ ...base, stage: 'analysis', events: obsEvents, architecturePlan: plan });
    expect(appended).toHaveLength(1);
    expect(obsEvents.filter((event) => event.type === 'DriftDetected')).toHaveLength(1);
    expect(second.drift).toHaveLength(1);
    expect(second.touchedDrift).toHaveLength(1);
    expect(second.touchedDrift[0]).toMatchObject({ claim: 'claim-hot-1', claimItem: OTHER_ITEM });
  });

  it('causally references the exact evaluation that produced each drift, not the first in the batch', async () => {
    const OBS_ITEM = WorkItemIdSchema.parse('wi-multi-aaaaaa');
    const OTHER_ITEM = WorkItemIdSchema.parse('wi-multi-bbbbbb');
    const RUN_ID = 'run-00000000-0000-4000-8000-000000000003';
    const HEX64 = '0'.repeat(64);
    const REPO_SHA = 'd'.repeat(64);

    function hexId(prefix: string, n: number): string {
      const hex = n.toString(16).padStart(32, '0');
      return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    function mkEvent(itemId: string, seq: number, type: EventType, data: unknown): MienguEvent {
      return MienguEventSchema.parse({
        schema_version: 4, event_id: hexId('evt', seq), seq, item_id: itemId, run_id: RUN_ID,
        ts: `2024-01-01T00:00:00.${String(seq).padStart(3, '0')}Z`, tier: DEFAULT_TIER[type],
        actor: { kind: 'system', id: null }, causation_id: null, type, data,
      });
    }

    const source = { kind: 'prd-file' as const, path: 'prd.md', sha256: REPO_SHA, bytes: 1 };
    const obsEvents: MienguEvent[] = [
      mkEvent(OBS_ITEM, 1, 'WorkItemCreated', { title: 'Observer', slug: 'obs', source, config_hash: 'x' }),
      mkEvent(OBS_ITEM, 2, 'BrownfieldEvidenceRecorded', {
        ladder_tier: 'mechanical-skeleton', collector_version: 1, target_repo_sha256: REPO_SHA,
        scope: { target_commit: 'base', roots: [], paths: ['src/cold.ts', 'src/hot.ts'], dependency_depth: 0, max_files: 200, truncated: false, sha256: HEX64 },
        coverage: 'complete',
        facts: [
          { kind: 'file', path: 'src/cold.ts', sha256: HEX64, bytes: 1 },
          { kind: 'file', path: 'src/hot.ts', sha256: HEX64, bytes: 1 },
        ],
        omissions: [], evidence: { sha256: HEX64, path: 'skeleton.json', bytes: 1 },
      }),
      mkEvent(OBS_ITEM, 3, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: HEX64, subject: { claim_item: OTHER_ITEM, claim: 'claim-hot-1' },
        assertion: 'hot module still present', area: 'src/hot.ts', predicate: { kind: 'path-exists', path: 'src/hot.ts', expected: true },
      }),
      mkEvent(OBS_ITEM, 4, 'BrownfieldPredicateEvaluated', {
        proposal_event_id: hexId('evt', 3), target_commit: 'base', outcome: 'refuted', reason: 'predicate-false',
        expected: 'present', observed: 'absent', duration_ms: 0, evidence: { sha256: HEX64, path: 'eval-hot.json', bytes: 1 },
      }),
      mkEvent(OBS_ITEM, 5, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: HEX64, subject: { claim_item: OTHER_ITEM, claim: 'claim-cold-1' },
        assertion: 'cold module still present', area: 'src/cold.ts', predicate: { kind: 'path-exists', path: 'src/cold.ts', expected: true },
      }),
      mkEvent(OBS_ITEM, 6, 'BrownfieldPredicateEvaluated', {
        proposal_event_id: hexId('evt', 5), target_commit: 'base', outcome: 'refuted', reason: 'predicate-false',
        expected: 'warm', observed: 'frozen', duration_ms: 0, evidence: { sha256: HEX64, path: 'eval-cold.json', bytes: 1 },
      }),
    ];

    const appended: MienguEvent[] = [];
    const append = async (input: AppendInput): Promise<MienguEvent> => {
      const event = MienguEventSchema.parse({
        schema_version: 4, event_id: hexId('evt', 30 + appended.length), seq: 30 + appended.length,
        item_id: OBS_ITEM, run_id: RUN_ID, ts: `2024-01-01T00:00:01.${String(appended.length).padStart(3, '0')}Z`,
        tier: DEFAULT_TIER[input.type], actor: { kind: 'system', id: null },
        causation_id: input.causationId ?? null, type: input.type, data: input.data,
      });
      appended.push(event); obsEvents.push(event);
      return event;
    };

    const result = await ensureBrownfieldEvidence({
      enabled: true, stage: 'analysis', itemId: OBS_ITEM, events: obsEvents,
      targetRoot: '/target', storeDir: null, workspaceMetadataDirs: [],
      targetCommit: 'base', targetRepoSha256: REPO_SHA, evidenceDir: '/tmp/evidence', collectorVersion: 1,
      limits: { maxTreeEntries: 100, maxFileBytes: 100, maxTestExcerptBytes: 100, maxGitCommits: 10, maxFilesPerCommit: 10, maxFilesPerScope: 200, maxDependencyDepth: 2 },
      configuredTestCommand: null, dependencyEdges: [], architecturePlan: null, taskGraph: null, activeTaskId: null,
      collector: {
        collectSkeleton: async () => { throw new Error('must not collect'); },
        collectGit: async () => { throw new Error('must not collect'); },
        collectTests: async () => { throw new Error('must not collect'); },
      },
      predicateRunner: { evaluate: async () => { throw new Error('must not evaluate'); } },
      predicatePolicy: { maxPredicatesPerScope: 8, maxWallSeconds: 1, maxOutputBytes: 1024, commands: {}, sandbox: null },
      signal: null, append,
      readStore: async () => ({ items: [{ itemId: OBS_ITEM, events: obsEvents }], corrupt: [] }),
    });

    expect(result.drift).toHaveLength(2);
    expect(appended).toHaveLength(2);
    expect(appended.map((event) => event.type)).toEqual(['DriftDetected', 'DriftDetected']);
    expect(appended[0]?.data).toMatchObject({ claim: 'claim-hot-1', expected: '"present"', observed: '"absent"' });
    expect(appended[1]?.data).toMatchObject({ claim: 'claim-cold-1', expected: '"warm"', observed: '"frozen"' });
    // Each DriftDetected points at its own producing evaluation, not the first one in the log.
    expect(appended[0]?.causation_id).toBe(hexId('evt', 4));
    expect(appended[1]?.causation_id).toBe(hexId('evt', 6));
    expect(appended[0]?.causation_id).not.toBe(appended[1]?.causation_id);
  });

  it('evaluates a pending proposal from planning only against its reconstructable scope identity, at most once', async () => {
    const ITEM = WorkItemIdSchema.parse('wi-pending-aaaaaa');
    const RUN_ID = 'run-00000000-0000-4000-8000-000000000002';
    const HEX64 = '0'.repeat(64);
    const REPO_SHA = 'c'.repeat(64);
    const REAL_SCOPE = 'a'.repeat(64);
    const GHOST_SCOPE = 'b'.repeat(64);

    function hexId(prefix: string, n: number): string {
      const hex = n.toString(16).padStart(32, '0');
      return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    }
    function mkEvent(seq: number, type: EventType, data: unknown, causationId: string | null = null): MienguEvent {
      return MienguEventSchema.parse({
        schema_version: 4, event_id: hexId('evt', seq), seq, item_id: ITEM, run_id: RUN_ID,
        ts: `2024-01-01T00:00:00.${String(seq).padStart(3, '0')}Z`, tier: DEFAULT_TIER[type],
        actor: { kind: 'system', id: null }, causation_id: causationId, type, data,
      });
    }

    const source = { kind: 'prd-file' as const, path: 'prd.md', sha256: REPO_SHA, bytes: 1 };
    const seeded: MienguEvent[] = [
      mkEvent(1, 'WorkItemCreated', { title: 'Pending', slug: 'pending', source, config_hash: 'x' }),
      mkEvent(2, 'BrownfieldEvidenceRecorded', {
        ladder_tier: 'mechanical-skeleton', collector_version: 1, target_repo_sha256: REPO_SHA,
        scope: { target_commit: 'base', roots: [], paths: ['src/hot.ts'], dependency_depth: 0, max_files: 200, truncated: false, sha256: REAL_SCOPE },
        coverage: 'complete', facts: [{ kind: 'file', path: 'src/hot.ts', sha256: HEX64, bytes: 1 }],
        omissions: [], evidence: { sha256: HEX64, path: 'skeleton.json', bytes: 1 },
      }),
      mkEvent(3, 'StageCompleted', { stage: 'architecture', attempt: 1, artifact: { kind: 'architecture-plan', sha256: REPO_SHA, body: { decisions: [], components: [], interfaces: [], falsifications: [] } } }),
      mkEvent(4, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: REAL_SCOPE, subject: null,
        assertion: 'hot module present', area: 'src/hot.ts', predicate: { kind: 'path-exists', path: 'src/hot.ts', expected: true },
      }, hexId('evt', 3)),
      mkEvent(5, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: GHOST_SCOPE, subject: null,
        assertion: 'never reconstructable', area: null, predicate: { kind: 'path-exists', path: 'src/ghost.ts', expected: true },
      }, hexId('evt', 3)),
      mkEvent(6, 'BrownfieldPredicateProposed', {
        target_commit: 'base', scope_sha256: REAL_SCOPE, subject: null,
        assertion: 'over the durable per-scope cap', area: 'src/hot.ts', predicate: { kind: 'path-exists', path: 'src/hot.ts', expected: true },
      }, hexId('evt', 3)),
    ];

    const appended: MienguEvent[] = [];
    const events = [...seeded];
    let evalCalls = 0;
    const base = {
      enabled: true, itemId: ITEM, targetRoot: '/target', storeDir: null, workspaceMetadataDirs: [],
      targetCommit: 'base', targetRepoSha256: REPO_SHA, evidenceDir: '/tmp/evidence', collectorVersion: 1,
      limits: { maxTreeEntries: 100, maxFileBytes: 100, maxTestExcerptBytes: 100, maxGitCommits: 10, maxFilesPerCommit: 10, maxFilesPerScope: 200, maxDependencyDepth: 2 },
      configuredTestCommand: null, dependencyEdges: [], architecturePlan: null, taskGraph: null, activeTaskId: null,
      collector: {
        collectSkeleton: async () => { throw new Error('skeleton already present'); },
        collectGit: async () => ({ facts: [], omissions: [], coverage: 'complete' as const, treePaths: ['src/hot.ts'], raw: {} }),
        collectTests: async () => ({ facts: [], omissions: [], coverage: 'complete' as const, treePaths: ['src/hot.ts'], raw: {} }),
      },
      predicateRunner: {
        evaluate: async (input: { proposalEventId: string; targetCommit: string }) => {
          evalCalls += 1;
          return { data: { proposal_event_id: input.proposalEventId, target_commit: input.targetCommit, outcome: 'confirmed' as const, reason: 'predicate-true' as const, expected: 'true', observed: 'true', duration_ms: 0, evidence: { sha256: HEX64, path: 'e.json', bytes: 1 } } };
        },
      },
      predicatePolicy: { maxPredicatesPerScope: 1, maxWallSeconds: 1, maxOutputBytes: 1024, commands: {}, sandbox: null },
      signal: null,
      append: async (input: AppendInput): Promise<MienguEvent> => {
        const event = mkEvent(20 + appended.length, input.type, input.data, input.causationId ?? null);
        appended.push(event); events.push(event);
        return event;
      },
      readStore: async () => ({ items: [{ itemId: ITEM, events }], corrupt: [] }),
    };

    const first = await ensureBrownfieldEvidence({ ...base, stage: 'planning', events });
    expect(first.evaluations).toHaveLength(1);
    const evaluations = events.filter((event) => event.type === 'BrownfieldPredicateEvaluated');
    expect(evaluations).toHaveLength(1);
    // The evaluation is causally paired to the real-scope proposal, never the ghost one.
    expect(evaluations[0]?.causation_id).toBe(hexId('evt', 4));
    expect(evalCalls).toBe(1);

    // A second planning pass evaluates nothing new: the first proposal remains evaluated
    // exactly once, the ghost identity is ignored, and the second real-scope proposal remains
    // over the durable per-scope cap rather than receiving a fresh allowance on every loop.
    const second = await ensureBrownfieldEvidence({ ...base, stage: 'planning', events });
    expect(second.evaluations).toHaveLength(0);
    expect(events.filter((event) => event.type === 'BrownfieldPredicateEvaluated')).toHaveLength(1);
    expect(evalCalls).toBe(1);
  });
});
