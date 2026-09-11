import { describe, it, expect } from 'vitest';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { deriveClaims } from '../../src/wiki/records.js';
import type { HumanViewItem, HumanViewInput, WikiFile } from '../../src/wiki/humanview.js';
import { isRenderedWikiPath, renderHumanView, WIKI_DIR } from '../../src/wiki/humanview.js';

const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function tsAt(n: number): string {
  return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
}

function mkEvent(
  itemId: string,
  seq: number,
  type: EventType,
  data: unknown,
  ts?: string,
): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 4,
    event_id: hexId('evt', seq),
    seq,
    item_id: itemId,
    run_id: RUN_ID,
    ts: ts ?? tsAt(seq),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

function created(itemId: string, slug: string, title: string, ts?: string): MienguEvent {
  return mkEvent(itemId, 1, 'WorkItemCreated', {
    title,
    slug,
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  }, ts);
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

function runStarted(itemId: string, seq: number, config: unknown): MienguEvent {
  return mkEvent(itemId, seq, 'RunStarted', {
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
  falsifications?: unknown[];
}): unknown {
  return {
    decisions: overrides?.decisions ?? [],
    components: overrides?.components ?? [],
    interfaces: overrides?.interfaces ?? [],
    falsifications: overrides?.falsifications ?? [],
  };
}

function stageCompleted(
  itemId: string,
  seq: number,
  stage: 'analysis' | 'architecture' | 'planning' | 'test-authoring' | 'implementation' | 'review',
  artifact: { kind: string; body: unknown } | null,
): MienguEvent {
  return mkEvent(itemId, seq, 'StageCompleted', {
    stage,
    attempt: 1,
    artifact: artifact === null ? null : { kind: artifact.kind, sha256: 'b'.repeat(64), body: artifact.body },
  });
}

function architectureEvent(
  itemId: string,
  seq: number,
  overrides: { decisions?: unknown[]; components?: unknown[]; interfaces?: unknown[] },
): MienguEvent {
  return stageCompleted(itemId, seq, 'architecture', {
    kind: 'architecture-plan',
    body: architecturePlanBody(overrides),
  });
}

function component(id: string, responsibility: string, paths: string[] = []): unknown {
  return { component_id: id, responsibility, paths, depends_on: [] };
}

function agentOriginatedDecision(id: string): unknown {
  return {
    decision_id: id,
    title: 't',
    choice: 'c',
    alternatives: ['a1', 'a2'],
    rationale: 'r',
    req_ids: [],
    supersedes: null,
    blast_radius: 'reversible',
  };
}

function diffCaptured(itemId: string, seq: number, filesTouched: string[]): MienguEvent {
  return mkEvent(itemId, seq, 'DiffCaptured', {
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

function driftDetected(itemId: string, seq: number, claim: string): MienguEvent {
  return mkEvent(itemId, seq, 'DriftDetected', {
    claim_item: itemId,
    claim,
    expected: 'expected value',
    observed: 'observed value',
    area: null,
  });
}

function artifactsInvalidated(itemId: string, seq: number, artifactEventIds: string[]): MienguEvent {
  return mkEvent(itemId, seq, 'ArtifactsInvalidated', {
    cause_id: hexId('evt', 500),
    target: 'coder',
    affected_ids: { req_ids: [], component_ids: [], task_ids: [] },
    artifact_event_ids: artifactEventIds,
    reason: 'invalidated for test',
  });
}

function findFile(files: readonly WikiFile[], path: string): WikiFile | undefined {
  return files.find((f) => f.path === path);
}

const ITEM_A = 'wi-alpha-aaaaaa';

describe('renderHumanView: determinism', () => {
  it('renders byte-identical output across two calls', () => {
    const events = [
      created(ITEM_A, 'alpha', 'Alpha item'),
      architectureEvent(ITEM_A, 2, { components: [component('component-alpha-1', 'does x')] }),
    ];
    const input: HumanViewInput = { language: 'en', items: [{ itemId: ITEM_A, events }] };
    expect(renderHumanView(input)).toEqual(renderHumanView(input));
  });

  it('is insensitive to the order items are supplied in', () => {
    const eventsA = [
      created(ITEM_A, 'alpha', 'Alpha item', tsAt(1)),
      architectureEvent(ITEM_A, 2, { components: [component('component-shared-1', 'from alpha')] }),
    ];
    const ITEM_B = 'wi-beta-bbbbbb';
    const eventsB = [
      created(ITEM_B, 'beta', 'Beta item', '2024-02-01T00:00:00.001Z'),
      architectureEvent(ITEM_B, 2, { components: [component('component-shared-1', 'from beta')] }),
    ];
    const itemA: HumanViewItem = { itemId: ITEM_A, events: eventsA };
    const itemB: HumanViewItem = { itemId: ITEM_B, events: eventsB };

    const forward = renderHumanView({ language: 'en', items: [itemA, itemB] });
    const backward = renderHumanView({ language: 'en', items: [itemB, itemA] });
    expect(forward).toEqual(backward);
  });
});

describe('renderHumanView: split by component, never by stage', () => {
  it('no emitted path names a pipeline stage', () => {
    const events = [
      created(ITEM_A, 'alpha', 'Alpha item'),
      runStarted(ITEM_A, 2, VALID_CONFIG),
      architectureEvent(ITEM_A, 3, { components: [component('component-alpha-1', 'r')] }),
      stageCompleted(ITEM_A, 4, 'planning', {
        kind: 'task-graph',
        body: {
          tasks: [
            {
              task_id: 'task-alpha-1',
              title: 't',
              req_ids: [],
              component_ids: ['component-alpha-1'],
              expected_paths: ['src/x.ts'],
              depends_on: [],
              definition_of_done: ['d'],
              estimated_turns: 1,
            },
          ],
        },
      }),
      diffCaptured(ITEM_A, 5, ['src/observed.ts']),
    ];
    const files = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events }] });
    const stageNames = [
      'analysis',
      'architecture',
      'planning',
      'test-authoring',
      'implementation',
      'review',
      'integration',
    ];
    for (const file of files) {
      const segments = file.path.split('/');
      for (const stage of stageNames) {
        expect(segments).not.toContain(stage);
      }
    }
  });
});

describe('renderHumanView: fr/en differ only in lexicon', () => {
  it('same file set, same anchors, same claim ordering', () => {
    const events = [
      created(ITEM_A, 'alpha', 'Alpha item'),
      architectureEvent(ITEM_A, 2, { components: [component('component-alpha-1', 'r')] }),
      diffCaptured(ITEM_A, 3, ['src/observed.ts']),
    ];
    const en = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events }] });
    const fr = renderHumanView({ language: 'fr', items: [{ itemId: ITEM_A, events }] });

    expect(en.map((f) => f.path)).toEqual(fr.map((f) => f.path));

    const anchorRe = /<a id="([^"]+)"><\/a>/g;
    for (let i = 0; i < en.length; i += 1) {
      const enAnchors = [...(en[i] as WikiFile).content.matchAll(anchorRe)].map((m) => m[1]);
      const frAnchors = [...(fr[i] as WikiFile).content.matchAll(anchorRe)].map((m) => m[1]);
      expect(frAnchors).toEqual(enAnchors);
    }
  });
});

describe('renderHumanView: visual weight (decision 16)', () => {
  const events = [
    created(ITEM_A, 'alpha', 'Alpha item'),
    runStarted(ITEM_A, 2, VALID_CONFIG),
    // T2, not demoted.
    architectureEvent(ITEM_A, 3, { components: [component('component-t2-1', 'a plain component')] }),
    // T3: demoted because minted by the same event as an active agent-originated decision.
    architectureEvent(ITEM_A, 4, {
      decisions: [agentOriginatedDecision('decision-alpha-1')],
      components: [component('component-t3-1', 'a demoted component')],
    }),
    // Superseded: two mints of the same (kind, subject).
    architectureEvent(ITEM_A, 5, { components: [component('component-superseded-1', 'v1')] }),
    architectureEvent(ITEM_A, 6, { components: [component('component-superseded-1', 'v2')] }),
    // Quarantined target, minted before the drift event below.
    architectureEvent(ITEM_A, 7, { components: [component('component-quarantined-1', 'q')] }),
    // Invalidated target.
    architectureEvent(ITEM_A, 8, { components: [component('component-invalidated-1', 'i')] }),
  ];

  const preliminarySet = deriveClaims(events);
  const quarantinedTargetId = preliminarySet.claims.find(
    (c) => c.subject === 'component-quarantined-1',
  )?.id as string;
  const invalidatedOriginEventId = hexId('evt', 8);

  const fullEvents = [
    ...events,
    driftDetected(ITEM_A, 9, quarantinedTargetId),
    artifactsInvalidated(ITEM_A, 10, [invalidatedOriginEventId]),
  ];

  const files = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events: fullEvents }] });

  it('T0: bold statement with a [T0] badge', () => {
    const unassigned = findFile(files, `${WIKI_DIR}/components/_unassigned.md`);
    expect(unassigned?.content).toMatch(/\*\*.*\*\* \[T0\]/);
  });

  it('T1: plain paragraph with a [T1] badge', () => {
    const events2 = [...events, diffCaptured(ITEM_A, 9, ['src/observed.ts'])];
    const withFile = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events: events2 }] });
    const unassigned = findFile(withFile, `${WIKI_DIR}/components/_unassigned.md`);
    expect(unassigned?.content).toMatch(/(?<!\*\*|> )src\/observed\.ts \[T1\]/);
  });

  it('T2: blockquote with a [T2] badge', () => {
    const file = findFile(files, `${WIKI_DIR}/components/component-t2-1.md`);
    expect(file?.content).toMatch(/> a plain component \[T2\]/);
  });

  it('T3: blockquote + italic with a [T3] badge and the provisional label', () => {
    const file = findFile(files, `${WIKI_DIR}/components/component-t3-1.md`);
    expect(file?.content).toMatch(/> \*a demoted component\* \[T3\] \(provisional\)/);
  });

  it('superseded: struck, under "### Superseded", with a link to the successor claim', () => {
    const file = findFile(files, `${WIKI_DIR}/components/component-superseded-1.md`);
    expect(file?.content).toContain('### Superseded');
    expect(file?.content).toMatch(/~~v1~~ \(superseded by \[claim-alpha-\d+\]\(#.*\)\)/);
    expect(file?.content).toContain('v2');
  });

  it('quarantined: struck, under "### Quarantined", with the contradicting observation quoted', () => {
    const file = findFile(files, `${WIKI_DIR}/components/component-quarantined-1.md`);
    expect(file?.content).toContain('### Quarantined');
    expect(file?.content).toMatch(/~~q~~ — expected: expected value \/ observed: observed value/);
  });

  it("a quarantined claim's pre-quarantine statement is byte-identical to its active rendering", () => {
    const preFiles = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events }] });
    const preFile = findFile(preFiles, `${WIKI_DIR}/components/component-quarantined-1.md`);
    expect(preFile?.content).toContain('> q [T2]');
    const postFile = findFile(files, `${WIKI_DIR}/components/component-quarantined-1.md`);
    expect(postFile?.content).toContain('~~q~~');
  });

  it('invalidated: struck, under "### Invalidated", with the invalidating cause id', () => {
    const file = findFile(files, `${WIKI_DIR}/components/component-invalidated-1.md`);
    expect(file?.content).toContain('### Invalidated');
    expect(file?.content).toMatch(new RegExp(`~~i~~ — invalidated by ${hexId('evt', 10)}`));
  });
});

describe('renderHumanView: multi-item component files', () => {
  const ITEM_1 = 'wi-first-111111';
  const ITEM_2 = 'wi-second-222222';

  const events1 = [
    created(ITEM_1, 'first', 'First item', '2024-01-01T00:00:00.001Z'),
    architectureEvent(ITEM_1, 2, { components: [component('component-shared-1', 'from item one')] }),
  ];
  const events2 = [
    created(ITEM_2, 'second', 'Second item', '2024-02-01T00:00:00.001Z'),
    architectureEvent(ITEM_2, 2, { components: [component('component-shared-1', 'from item two')] }),
  ];

  const files = renderHumanView({
    language: 'en',
    items: [
      { itemId: ITEM_2, events: events2 },
      { itemId: ITEM_1, events: events1 },
    ],
  });
  const file = findFile(files, `${WIKI_DIR}/components/component-shared-1.md`);

  it('carries one section per item, in (createdAt, itemId) order', () => {
    const content = file?.content ?? '';
    const firstIdx = content.indexOf(`(${ITEM_1})`);
    const secondIdx = content.indexOf(`(${ITEM_2})`);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('never merges two items claims into one supersession chain', () => {
    const content = file?.content ?? '';
    expect(content).toContain(`<a id="${ITEM_1}/`);
    expect(content).toContain(`<a id="${ITEM_2}/`);
    expect(content).not.toContain('### Superseded');
  });
});

describe('renderHumanView: empty input', () => {
  it('yields exactly wiki/index.md', () => {
    const files = renderHumanView({ language: 'en', items: [] });
    expect(files).toEqual([{ path: `${WIKI_DIR}/index.md`, content: expect.any(String) }]);
  });
});

describe('isRenderedWikiPath', () => {
  it('accepts exactly the emitted paths', () => {
    const events = [
      created(ITEM_A, 'alpha', 'Alpha item'),
      architectureEvent(ITEM_A, 2, { components: [component('component-alpha-1', 'r')] }),
    ];
    const files = renderHumanView({ language: 'en', items: [{ itemId: ITEM_A, events }] });
    for (const file of files) {
      expect(isRenderedWikiPath(file.path)).toBe(true);
    }
  });

  it('rejects an unowned file under wiki/', () => {
    expect(isRenderedWikiPath('wiki/notes.md')).toBe(false);
  });
});
