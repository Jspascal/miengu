import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/core/canonical.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { deriveClaims } from '../../src/wiki/records.js';
import {
  fileMapBodies,
  stackFactsBodies,
  systemSkeletonBodies,
  wikiIndexBodies,
} from '../../src/wiki/packmaterials.js';

const ITEM_ID = 'wi-example-abc123';
const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';
const SLUG = 'example';

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function tsAt(n: number): string {
  return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
}

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 3,
    event_id: hexId('evt', seq),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: tsAt(seq),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

function created(): MienguEvent {
  return mkEvent(1, 'WorkItemCreated', {
    title: 'Example item',
    slug: SLUG,
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  });
}

const VALID_CONFIG = {
  target: { repo: '/repo', mode: 'worktree', baseRef: 'HEAD' },
  oracles: {
    build: 'npm run build',
    test: 'npm test',
    lint: 'npm run lint',
    typecheck: 'npm run typecheck',
  },
};

function runStarted(seq: number, config: unknown): MienguEvent {
  return mkEvent(seq, 'RunStarted', {
    miengu_version: '0.1.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config,
  });
}

function architecturePlanBody(overrides?: {
  decisions?: unknown[];
  components?: unknown[];
  interfaces?: unknown[];
}): unknown {
  return {
    decisions: overrides?.decisions ?? [],
    components: overrides?.components ?? [],
    interfaces: overrides?.interfaces ?? [],
  };
}

function stageCompleted(
  seq: number,
  stage: 'analysis' | 'architecture' | 'planning' | 'test-authoring' | 'implementation' | 'review',
  artifact: { kind: string; body: unknown } | null,
): MienguEvent {
  return mkEvent(seq, 'StageCompleted', {
    stage,
    attempt: 1,
    artifact: artifact === null ? null : { kind: artifact.kind, sha256: 'b'.repeat(64), body: artifact.body },
  });
}

function taskGraphBody(tasks: unknown[]): unknown {
  return { tasks };
}

function diffCaptured(seq: number, filesTouched: string[]): MienguEvent {
  return mkEvent(seq, 'DiffCaptured', {
    workdir: '/tmp/wd',
    diff_sha256: 'b'.repeat(64),
    diff_ref: null,
    files_touched: filesTouched,
    untracked: [],
    insertions: 1,
    deletions: 0,
    committed_during_run: false,
  });
}

function driftDetected(seq: number, claim: string): MienguEvent {
  return mkEvent(seq, 'DriftDetected', {
    claim,
    expected: 'expected value',
    observed: 'observed value',
    area: null,
  });
}

function artifactsInvalidated(seq: number, artifactEventIds: string[]): MienguEvent {
  return mkEvent(seq, 'ArtifactsInvalidated', {
    cause_id: hexId('evt', 500),
    target: 'coder',
    affected_ids: { req_ids: [], component_ids: [], task_ids: [] },
    artifact_event_ids: artifactEventIds,
    reason: 'invalidated for test',
  });
}

describe('wikiIndexBodies', () => {
  it('empty claim set yields []', () => {
    expect(wikiIndexBodies(deriveClaims([created()]))).toEqual([]);
  });

  it('single-tier: one body for one component', () => {
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          components: [
            { component_id: 'component-example-1', responsibility: 'Handles X MIENGU_SENTINEL_RESPONSIBILITY', paths: ['src/x.ts'], depends_on: [] },
          ],
        }),
      }),
    ];
    const bodies = wikiIndexBodies(deriveClaims(events));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tier).toBe('T2');
    expect(bodies[0]?.body).toContain('component-example-1');
    expect(bodies[0]?.body).toContain('MIENGU_SENTINEL_RESPONSIBILITY');
  });

  it('mixed tiers: one body per tier, in T0->T3 order', () => {
    const events = [
      created(),
      // event 2: an agent-originated decision demotes component-1, minted by the same event.
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [
            {
              decision_id: 'decision-example-1', title: 't', choice: 'c', alternatives: [],
              rationale: 'r', req_ids: [], supersedes: null, blast_radius: 'reversible',
            },
          ],
          components: [
            { component_id: 'component-example-1', responsibility: 'demoted', paths: [], depends_on: [] },
          ],
        }),
      }),
      // event 3: a plain component, no agent-originated decision in this event -> stays T2.
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          components: [
            { component_id: 'component-example-2', responsibility: 'not demoted', paths: [], depends_on: [] },
          ],
        }),
      }),
    ];
    const set = deriveClaims(events);
    const bodies = wikiIndexBodies(set);
    expect(bodies.map((b) => b.tier)).toEqual(['T2', 'T3']);
    expect(bodies[0]?.body).toContain('component-example-2');
    expect(bodies[1]?.body).toContain('component-example-1');
  });

  it('contains no path, no interface signature and no decision text', () => {
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [
            {
              decision_id: 'decision-example-1', title: 'MIENGU_SENTINEL_DECISION', choice: 'MIENGU_SENTINEL_DECISION',
              alternatives: [], rationale: 'r', req_ids: ['REQ-example-1'], supersedes: null, blast_radius: 'reversible',
            },
          ],
          components: [
            { component_id: 'component-example-1', responsibility: 'r', paths: ['MIENGU_SENTINEL_PATH'], depends_on: [] },
          ],
          interfaces: [
            {
              interface_id: 'interface-example-1', component_id: 'component-example-1',
              signature: 'MIENGU_SENTINEL_SIGNATURE', behaviour: 'b', req_ids: ['REQ-example-1'],
            },
          ],
        }),
      }),
    ];
    const bodies = wikiIndexBodies(deriveClaims(events));
    const rendered = bodies.map((b) => b.body).join('\n');
    expect(rendered).not.toContain('MIENGU_SENTINEL_PATH');
    expect(rendered).not.toContain('MIENGU_SENTINEL_SIGNATURE');
    expect(rendered).not.toContain('MIENGU_SENTINEL_DECISION');
  });

  it('excludes a superseded, an invalidated and a quarantined claim', () => {
    const componentV1 = { component_id: 'component-example-1', responsibility: 'v1', paths: [], depends_on: [] };
    const componentV2 = { component_id: 'component-example-1', responsibility: 'v2', paths: [], depends_on: [] };
    const other = { component_id: 'component-example-2', responsibility: 'other MIENGU_SENTINEL_QUARANTINED', paths: [], depends_on: [] };
    const invalidatedTarget = { component_id: 'component-example-3', responsibility: 'invalidated MIENGU_SENTINEL_INVALIDATED', paths: [], depends_on: [] };

    const eventV1 = stageCompleted(2, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody({ components: [componentV1] }) });
    const eventV2 = stageCompleted(3, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody({ components: [componentV2] }) });
    const eventOther = stageCompleted(4, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody({ components: [other] }) });
    const eventInvalidated = stageCompleted(5, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody({ components: [invalidatedTarget] }) });

    const preliminary = [created(), eventV1, eventV2, eventOther, eventInvalidated];
    const otherId = deriveClaims(preliminary).claims.find((c) => c.subject === 'component-example-2')?.id;
    expect(otherId).toBeDefined();

    const events = [
      ...preliminary,
      driftDetected(6, otherId as string),
      artifactsInvalidated(7, [eventInvalidated.event_id]),
    ];
    const bodies = wikiIndexBodies(deriveClaims(events));
    const rendered = bodies.map((b) => b.body).join('\n');
    expect(rendered).toContain('component-example-1: v2'); // active successor only
    expect(rendered).not.toContain('v1');
    expect(rendered).not.toContain('MIENGU_SENTINEL_QUARANTINED');
    expect(rendered).not.toContain('MIENGU_SENTINEL_INVALIDATED');
  });

  it('byte-identical output across two calls under canonicalJson', () => {
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          components: [{ component_id: 'component-example-1', responsibility: 'r', paths: [], depends_on: [] }],
        }),
      }),
    ];
    const set = deriveClaims(events);
    expect(canonicalJson(wikiIndexBodies(set))).toBe(canonicalJson(wikiIndexBodies(set)));
  });
});

describe('systemSkeletonBodies', () => {
  it('empty claim set yields []', () => {
    expect(systemSkeletonBodies(deriveClaims([created()]))).toEqual([]);
  });

  it('combines components and interfaces into one body per tier', () => {
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          components: [{ component_id: 'component-example-1', responsibility: 'r', paths: [], depends_on: [] }],
          interfaces: [
            {
              interface_id: 'interface-example-1', component_id: 'component-example-1',
              signature: 's', behaviour: 'b', req_ids: ['REQ-example-1'],
            },
          ],
        }),
      }),
    ];
    const bodies = systemSkeletonBodies(deriveClaims(events));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tier).toBe('T2');
    expect(bodies[0]?.body).toContain('component-example-1');
    expect(bodies[0]?.body).toContain('interface-example-1');
  });
});

describe('fileMapBodies', () => {
  it('empty claim set yields []', () => {
    expect(fileMapBodies(deriveClaims([created()]))).toEqual([]);
  });

  it('separates observed (T1) file claims from declared (T2) component/task paths, with no file contents', () => {
    const events = [
      created(),
      diffCaptured(2, ['src/observed.ts']),
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          components: [
            { component_id: 'component-example-1', responsibility: 'r', paths: ['src/declared-component.ts'], depends_on: [] },
          ],
        }),
      }),
      stageCompleted(4, 'planning', {
        kind: 'task-graph',
        body: taskGraphBody([
          {
            task_id: 'task-example-1', title: 't', req_ids: ['REQ-example-1'], component_ids: [],
            expected_paths: ['src/declared-task.ts'], depends_on: [], definition_of_done: ['d'], estimated_turns: 1,
          },
        ]),
      }),
    ];
    const bodies = fileMapBodies(deriveClaims(events));
    const t1 = bodies.find((b) => b.tier === 'T1');
    const t2 = bodies.find((b) => b.tier === 'T2');
    expect(t1?.body).toBe('src/observed.ts');
    expect(t2?.body.split('\n').sort()).toEqual(['src/declared-component.ts', 'src/declared-task.ts']);
    expect(bodies.some((b) => b.body.includes('function') || b.body.includes('{'))).toBe(false);
  });

  it('a demoted declared path renders under T3, separate from the T2 entry', () => {
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [
            {
              decision_id: 'decision-example-1', title: 't', choice: 'c', alternatives: [],
              rationale: 'r', req_ids: [], supersedes: null, blast_radius: 'reversible',
            },
          ],
          components: [
            { component_id: 'component-example-1', responsibility: 'r', paths: ['src/demoted.ts'], depends_on: [] },
          ],
        }),
      }),
    ];
    const bodies = fileMapBodies(deriveClaims(events));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tier).toBe('T3');
    expect(bodies[0]?.body).toBe('src/demoted.ts');
  });
});

describe('stackFactsBodies', () => {
  it('empty when the config never parsed', () => {
    const events = [created(), runStarted(2, { not: 'a config' })];
    expect(stackFactsBodies(deriveClaims(events))).toEqual([]);
  });

  it('a single T0 entry from stack-fact claims', () => {
    const events = [created(), runStarted(2, VALID_CONFIG)];
    const bodies = stackFactsBodies(deriveClaims(events));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.tier).toBe('T0');
    expect(bodies[0]?.body).toContain('oracle.build');
    expect(bodies[0]?.body).toContain('target.mode');
  });

  it('byte-identical output across two calls under canonicalJson', () => {
    const events = [created(), runStarted(2, VALID_CONFIG)];
    const set = deriveClaims(events);
    expect(canonicalJson(stackFactsBodies(set))).toBe(canonicalJson(stackFactsBodies(set)));
  });
});
