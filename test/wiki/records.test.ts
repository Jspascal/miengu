import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/core/canonical.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import type { ClaimId, EventId } from '../../src/core/ids.js';
import {
  activeClaims,
  artifactSectionTier,
  claimComponents,
  CLAIM_KINDS,
  deriveClaims,
} from '../../src/wiki/records.js';
import type { Claim, ClaimKind } from '../../src/wiki/records.js';

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

function mkEvent(seq: number, type: EventType, data: unknown, ts?: string): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 3,
    event_id: hexId('evt', seq),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: ts ?? tsAt(seq),
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

function runStarted(seq: number, config: unknown): MienguEvent {
  return mkEvent(seq, 'RunStarted', {
    miengu_version: '0.1.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config,
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

function requirementSetBody(overrides?: { requirements?: unknown[] }): unknown {
  return {
    requirements: overrides?.requirements ?? [
      {
        req_id: 'REQ-example-1',
        statement: 'The system must do X.',
        rationale: 'Because.',
        acceptance: ['Given X, then Y.'],
        priority: 'must',
        source_span: 'prd.md:10-12',
      },
      {
        req_id: 'REQ-example-2',
        statement: 'The system must do Y.',
        rationale: 'Because.',
        acceptance: ['Given Y, then Z.'],
        priority: 'should',
        source_span: null,
      },
    ],
    ambiguities: [],
    out_of_scope: [],
  };
}

function architecturePlanBody(overrides?: {
  decisions?: unknown[];
  components?: unknown[];
  interfaces?: unknown[];
}): unknown {
  return {
    decisions: overrides?.decisions ?? [
      {
        decision_id: 'decision-example-1',
        title: 'Use Postgres',
        choice: 'Use Postgres 15',
        alternatives: ['MySQL'],
        rationale: 'r',
        req_ids: ['REQ-example-1'],
        supersedes: null,
        blast_radius: 'reversible',
      },
    ],
    components: overrides?.components ?? [
      {
        component_id: 'component-example-1',
        responsibility: 'Handles X',
        paths: ['src/x.ts'],
        depends_on: [],
      },
    ],
    interfaces: overrides?.interfaces ?? [
      {
        interface_id: 'interface-example-1',
        component_id: 'component-example-1',
        signature: 'function x(): void',
        behaviour: 'b',
        req_ids: ['REQ-example-1'],
      },
    ],
  };
}

function taskGraphBody(overrides?: { tasks?: unknown[] }): unknown {
  return {
    tasks: overrides?.tasks ?? [
      {
        task_id: 'task-example-1',
        title: 'Implement X',
        req_ids: ['REQ-example-1'],
        component_ids: ['component-example-1'],
        expected_paths: ['src/x.ts'],
        depends_on: [],
        definition_of_done: ['done'],
        estimated_turns: 3,
      },
    ],
  };
}

function testSuiteSpecBody(seq: number, overrides?: { cases?: unknown[] }): unknown {
  return {
    suite_id: 'suite-example-1',
    frozen_at: tsAt(seq),
    content_hash: 'c'.repeat(64),
    cases: overrides?.cases ?? [
      {
        test_id: 'test-example-1',
        req_ids: ['REQ-example-1'],
        path: 'test/x.test.ts',
        intent: 'covers x',
        negative: false,
        asserts_output: true,
      },
    ],
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

function assumptionRecorded(
  seq: number,
  overrides?: { id?: string; affects?: string[]; chosen?: string },
): MienguEvent {
  return mkEvent(seq, 'AssumptionRecorded', {
    id: overrides?.id ?? 'assumption-example-1',
    question: 'Which approach?',
    chosen: overrides?.chosen ?? 'Chosen approach',
    alternatives: ['Other approach'],
    affects: overrides?.affects ?? ['REQ-example-1', 'component-example-1'],
    depth: 0,
  });
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

function oracleResultRecorded(
  seq: number,
  overrides?: { sweepId?: string; taskId?: string | null; status?: string },
): MienguEvent {
  const taskId = overrides !== undefined && 'taskId' in overrides ? (overrides.taskId as string | null) : 'task-example-1';
  return mkEvent(seq, 'OracleResultRecorded', {
    sweep_id: overrides?.sweepId ?? hexId('evt', 900),
    scope: 'task',
    task_id: taskId,
    kind: 'test',
    command: null,
    command_sha256: null,
    status: overrides?.status ?? 'passed',
    exit_code: 0,
    signal: null,
    duration_ms: 10,
    stdout: { sha256: 'a'.repeat(64), path: 'p', bytes: 0 },
    stderr: { sha256: 'a'.repeat(64), path: 'p', bytes: 0 },
  });
}

function driftDetected(
  seq: number,
  claim: string,
  overrides?: { expected?: string; observed?: string },
): MienguEvent {
  return mkEvent(seq, 'DriftDetected', {
    claim,
    expected: overrides?.expected ?? 'expected value',
    observed: overrides?.observed ?? 'observed value',
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

function checkpointRaised(
  seq: number,
  overrides?: { stage?: string; kind?: string; ts?: string },
): MienguEvent {
  return mkEvent(
    seq,
    'CheckpointRaised',
    {
      checkpoint: 'cp-example-1',
      kind: overrides?.kind ?? 'irreversible',
      stage: overrides?.stage ?? 'architecture',
      summary: "decision 'decision-example-2' is irreversible: Introduce cache layer",
      blocking: true,
      sla_seconds: null,
      default_decision: null,
    },
    overrides?.ts,
  );
}

function checkpointDecided(seq: number, ts?: string): MienguEvent {
  return mkEvent(
    seq,
    'CheckpointDecided',
    { checkpoint: 'cp-example-1', decision: 'accept', by: 'human', reason: null },
    ts,
  );
}

function autoApproved(seq: number, ts?: string): MienguEvent {
  return mkEvent(
    seq,
    'AutoApproved',
    { checkpoint: 'cp-example-1', after: 'PT1H', no_human_response: true },
    ts,
  );
}

/** A full-map fixture: one event per §2 emission-map row, no agent-originated decision, so
 *  every T2-eligible claim stays at its base tier. Used by tests that are not about demotion. */
function fullFixture(): MienguEvent[] {
  return [
    created(),
    runStarted(2, VALID_CONFIG),
    stageCompleted(3, 'analysis', { kind: 'requirement-set', body: requirementSetBody() }),
    stageCompleted(4, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody() }),
    stageCompleted(5, 'planning', { kind: 'task-graph', body: taskGraphBody() }),
    stageCompleted(6, 'test-authoring', { kind: 'test-suite-spec', body: testSuiteSpecBody(6) }),
    assumptionRecorded(7),
    diffCaptured(8, ['src/x.ts', 'src/y.ts']),
    oracleResultRecorded(9),
  ];
}

function byKind(claims: readonly Claim[], kind: ClaimKind): Claim[] {
  return claims.filter((c) => c.kind === kind);
}

describe('deriveClaims: determinism and id stability', () => {
  it('is byte-identical under canonicalJson across two derivations of the same events', () => {
    const events = fullFixture();
    const a = deriveClaims(events);
    const b = deriveClaims(events);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('ids for the common prefix are identical when derived from every prefix boundary', () => {
    const events = fullFixture();
    const full = deriveClaims(events);
    for (let k = 1; k <= events.length; k += 1) {
      const prefix = deriveClaims(events.slice(0, k));
      for (const claim of prefix.claims) {
        const fromFull = full.byId[claim.id];
        expect(fromFull).toBeDefined();
        expect(fromFull?.subject).toBe(claim.subject);
        expect(fromFull?.kind).toBe(claim.kind);
        expect(fromFull?.statement).toBe(claim.statement);
      }
    }
  });
});

describe('deriveClaims: emission map (§2)', () => {
  it('RunStarted emits one stack-fact claim per non-null declared value', () => {
    const events = [created(), runStarted(2, VALID_CONFIG)];
    const set = deriveClaims(events);
    const facts = byKind(set.claims, 'stack-fact');
    expect(facts.map((c) => c.subject)).toEqual([
      'oracle.build',
      'oracle.lint',
      'oracle.test',
      'oracle.typecheck',
      'target.baseRef',
      'target.mode',
    ]);
    expect(facts.every((c) => c.tier === 'T0')).toBe(true);
    expect(facts.every((c) => c.trace.reqIds.length === 0 && c.trace.componentIds.length === 0)).toBe(true);
  });

  it('RunStarted omits stack-fact claims for null oracle commands', () => {
    const config = {
      target: { repo: '/repo', mode: 'worktree', baseRef: 'HEAD' },
      oracles: { build: null, test: null, lint: null, typecheck: null },
    };
    const set = deriveClaims([created(), runStarted(2, config)]);
    const facts = byKind(set.claims, 'stack-fact');
    expect(facts.map((c) => c.subject)).toEqual(['target.baseRef', 'target.mode']);
  });

  it('StageCompleted{analysis} emits one requirement claim per requirements[]', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'analysis', { kind: 'requirement-set', body: requirementSetBody() }),
    ]);
    const reqs = byKind(set.claims, 'requirement');
    expect(reqs.map((c) => c.subject)).toEqual(['REQ-example-1', 'REQ-example-2']);
    expect(reqs.map((c) => c.trace.reqIds)).toEqual([['REQ-example-1'], ['REQ-example-2']]);
    expect(reqs[0]?.statement).toBe('The system must do X.');
    expect(reqs[0]?.agentOriginated).toBe(false);
    expect(reqs[1]?.agentOriginated).toBe(true);
  });

  it('StageCompleted{architecture} emits decision, component and interface claims with their traces', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'architecture', { kind: 'architecture-plan', body: architecturePlanBody() }),
    ]);
    const decisions = byKind(set.claims, 'decision');
    const components = byKind(set.claims, 'component');
    const interfaces = byKind(set.claims, 'interface');
    expect(decisions.map((c) => c.subject)).toEqual(['decision-example-1']);
    expect(decisions[0]?.trace).toEqual({
      reqIds: ['REQ-example-1'],
      componentIds: [],
      taskIds: [],
      decisionIds: ['decision-example-1'],
      paths: [],
    });
    expect(components.map((c) => c.subject)).toEqual(['component-example-1']);
    expect(components[0]?.trace.paths).toEqual(['src/x.ts']);
    expect(interfaces.map((c) => c.subject)).toEqual(['interface-example-1']);
    expect(interfaces[0]?.trace.componentIds).toEqual(['component-example-1']);
  });

  it('StageCompleted{architecture} with empty decisions/components/interfaces emits nothing', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({ decisions: [], components: [], interfaces: [] }),
      }),
    ]);
    expect(byKind(set.claims, 'decision')).toEqual([]);
    expect(byKind(set.claims, 'component')).toEqual([]);
    expect(byKind(set.claims, 'interface')).toEqual([]);
  });

  it('StageCompleted{planning} emits one task claim per tasks[]', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'planning', { kind: 'task-graph', body: taskGraphBody() }),
    ]);
    const tasks = byKind(set.claims, 'task');
    expect(tasks.map((c) => c.subject)).toEqual(['task-example-1']);
    expect(tasks[0]?.trace).toEqual({
      reqIds: ['REQ-example-1'],
      componentIds: ['component-example-1'],
      taskIds: ['task-example-1'],
      decisionIds: [],
      paths: ['src/x.ts'],
    });
  });

  it('StageCompleted{test-authoring} emits one test-case claim per cases[]', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'test-authoring', { kind: 'test-suite-spec', body: testSuiteSpecBody(2) }),
    ]);
    const cases = byKind(set.claims, 'test-case');
    expect(cases.map((c) => c.subject)).toEqual(['test-example-1']);
    expect(cases[0]?.trace).toEqual({
      reqIds: ['REQ-example-1'],
      componentIds: [],
      taskIds: [],
      decisionIds: [],
      paths: ['test/x.test.ts'],
    });
  });

  it('StageCompleted{implementation} and {review} mint no claim', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'implementation', { kind: 'implementation', body: { task_id: 'task-example-1' } }),
      stageCompleted(3, 'review', {
        kind: 'review-verdict',
        body: { task_id: 'task-example-1', verdict: 'accept', findings: [], escalate_to: null },
      }),
    ]);
    expect(set.claims).toEqual([]);
  });

  it('AssumptionRecorded emits one assumption claim, with reqIds limited to RE_REQ_ID matches', () => {
    const set = deriveClaims([created(), assumptionRecorded(2)]);
    const assumptions = byKind(set.claims, 'assumption');
    expect(assumptions).toHaveLength(1);
    expect(assumptions[0]?.subject).toBe('assumption-example-1');
    expect(assumptions[0]?.statement).toBe('Chosen approach');
    // 'component-example-1' does not match RE_REQ_ID and is excluded.
    expect(assumptions[0]?.trace.reqIds).toEqual(['REQ-example-1']);
  });

  it('DiffCaptured emits one file claim per files_touched[]', () => {
    const set = deriveClaims([created(), diffCaptured(2, ['src/y.ts', 'src/x.ts'])]);
    const files = byKind(set.claims, 'file');
    expect(files.map((c) => c.subject)).toEqual(['src/x.ts', 'src/y.ts']);
    expect(files.every((c) => c.tier === 'T1')).toBe(true);
  });

  it('DiffCaptured with no files touched emits no file claim', () => {
    const set = deriveClaims([created(), diffCaptured(2, [])]);
    expect(byKind(set.claims, 'file')).toEqual([]);
  });

  it('OracleResultRecorded emits one oracle-result claim keyed by sweep_id:kind', () => {
    const set = deriveClaims([created(), oracleResultRecorded(2, { sweepId: hexId('evt', 900) })]);
    const results = byKind(set.claims, 'oracle-result');
    expect(results).toHaveLength(1);
    expect(results[0]?.subject).toBe(`${hexId('evt', 900)}:test`);
    expect(results[0]?.trace.taskIds).toEqual(['task-example-1']);
    expect(results[0]?.tier).toBe('T1');
  });

  it('OracleResultRecorded with a null task_id emits an empty taskIds trace', () => {
    const set = deriveClaims([created(), oracleResultRecorded(2, { taskId: null })]);
    expect(byKind(set.claims, 'oracle-result')[0]?.trace.taskIds).toEqual([]);
  });
});

describe('deriveClaims: tier derivation (decision 4)', () => {
  it('assigns the base tier by origin for every row of the table', () => {
    const set = deriveClaims(fullFixture());
    const tierOf = (kind: ClaimKind): string[] => byKind(set.claims, kind).map((c) => c.tier);
    expect(tierOf('stack-fact')).toEqual(['T0', 'T0', 'T0', 'T0', 'T0', 'T0']);
    expect(tierOf('requirement')).toEqual(['T2', 'T2']);
    expect(tierOf('decision')).toEqual(['T2']);
    expect(tierOf('component')).toEqual(['T2']);
    expect(tierOf('interface')).toEqual(['T2']);
    expect(tierOf('task')).toEqual(['T2']);
    expect(tierOf('test-case')).toEqual(['T2']);
    expect(tierOf('assumption')).toEqual(['T2']);
    expect(tierOf('file')).toEqual(['T1', 'T1']);
    expect(tierOf('oracle-result')).toEqual(['T1']);
  });

  it('a source_span:null requirement is agentOriginated but still T2 (§4)', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'analysis', { kind: 'requirement-set', body: requirementSetBody() }),
    ]);
    const reqs = byKind(set.claims, 'requirement');
    expect(reqs[1]?.tier).toBe('T2');
    expect(reqs[1]?.agentOriginated).toBe(true);
    expect(reqs[0]?.tier).toBe('T2');
    expect(reqs[0]?.agentOriginated).toBe(false);
  });

  it('rule (a): an active agent-originated decision (req_ids: []) demotes its sibling claims from the same event, but not itself', () => {
    const plan = architecturePlanBody({
      decisions: [
        {
          decision_id: 'decision-example-1',
          title: 'Use Postgres',
          choice: 'Use Postgres 15',
          alternatives: [],
          rationale: 'r',
          req_ids: ['REQ-example-1'],
          supersedes: null,
          blast_radius: 'reversible',
        },
        {
          decision_id: 'decision-example-2',
          title: 'Introduce cache layer',
          choice: 'Add Redis',
          alternatives: [],
          rationale: 'r2',
          req_ids: [],
          supersedes: null,
          blast_radius: 'irreversible',
        },
      ],
    });
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'architecture', { kind: 'architecture-plan', body: plan }),
    ]);
    const decisions = byKind(set.claims, 'decision');
    const ratified = decisions.find((c) => c.subject === 'decision-example-1');
    const agentOriginated = decisions.find((c) => c.subject === 'decision-example-2');
    const components = byKind(set.claims, 'component');
    const interfaces = byKind(set.claims, 'interface');
    expect(agentOriginated?.tier).toBe('T2');
    expect(agentOriginated?.agentOriginated).toBe(true);
    expect(ratified?.tier).toBe('T3');
    expect(components[0]?.tier).toBe('T3');
    expect(interfaces[0]?.tier).toBe('T3');
  });

  it('rule (b): task/test-case claims minted after an active agent-originated decision are demoted to T3', () => {
    const events = fullFixture().map((e) =>
      e.type === 'StageCompleted' && e.data.stage === 'architecture'
        ? stageCompleted(4, 'architecture', {
            kind: 'architecture-plan',
            body: architecturePlanBody({
              decisions: [
                {
                  decision_id: 'decision-example-2',
                  title: 'Introduce cache layer',
                  choice: 'Add Redis',
                  alternatives: [],
                  rationale: 'r2',
                  req_ids: [],
                  supersedes: null,
                  blast_radius: 'irreversible',
                },
              ],
            }),
          })
        : e,
    );
    const set = deriveClaims(events);
    expect(byKind(set.claims, 'task')[0]?.tier).toBe('T3');
    expect(byKind(set.claims, 'test-case')[0]?.tier).toBe('T3');
  });

  it('an inactive (superseded) agent-originated decision demotes nothing', () => {
    const decisionV1 = {
      decision_id: 'decision-example-2',
      title: 'Introduce cache layer',
      choice: 'Add Redis',
      alternatives: [],
      rationale: 'r2',
      req_ids: [],
      supersedes: null,
      blast_radius: 'irreversible',
    };
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [decisionV1],
          components: [
            { component_id: 'component-example-1', responsibility: 'Handles X', paths: ['src/x.ts'], depends_on: [] },
          ],
          interfaces: [],
        }),
      }),
      // A second architecture pass re-declares the same decision id: the first instance is
      // now superseded (same kind+subject, later claim), so it is no longer "active" and rule
      // (a) must not fire from it.
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [decisionV1],
          components: [
            { component_id: 'component-example-1', responsibility: 'Handles X', paths: ['src/x.ts'], depends_on: [] },
          ],
          interfaces: [],
        }),
      }),
    ];
    const set = deriveClaims(events);
    const firstPassComponent = byKind(set.claims, 'component')[0];
    expect(firstPassComponent?.status).toBe('superseded');
    expect(firstPassComponent?.tier).toBe('T2');
  });

  it('requirement claims are never demoted', () => {
    const events = [
      created(),
      stageCompleted(2, 'analysis', { kind: 'requirement-set', body: requirementSetBody() }),
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [
            {
              decision_id: 'decision-example-2',
              title: 'Introduce cache layer',
              choice: 'Add Redis',
              alternatives: [],
              rationale: 'r2',
              req_ids: [],
              supersedes: null,
              blast_radius: 'irreversible',
            },
          ],
        }),
      }),
    ];
    const set = deriveClaims(events);
    expect(byKind(set.claims, 'requirement').every((c) => c.tier === 'T2')).toBe(true);
  });

  it('T0 and T1 claims are never demoted', () => {
    const events = [
      created(),
      runStarted(2, VALID_CONFIG),
      diffCaptured(3, ['src/x.ts']),
      stageCompleted(4, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({
          decisions: [
            {
              decision_id: 'decision-example-2',
              title: 'Introduce cache layer',
              choice: 'Add Redis',
              alternatives: [],
              rationale: 'r2',
              req_ids: [],
              supersedes: null,
              blast_radius: 'irreversible',
            },
          ],
          components: [],
          interfaces: [],
        }),
      }),
    ];
    const set = deriveClaims(events);
    expect(byKind(set.claims, 'stack-fact').every((c) => c.tier === 'T0')).toBe(true);
    expect(byKind(set.claims, 'file').every((c) => c.tier === 'T1')).toBe(true);
  });
});

describe('deriveClaims: open question 1 — human acceptance promotes nothing', () => {
  it('CheckpointDecided{accept, by: human} on an irreversible checkpoint changes no claim', () => {
    const base = fullFixture();
    const withCheckpoint = [
      ...base,
      checkpointRaised(10, { stage: 'architecture', kind: 'irreversible' }),
      checkpointDecided(11, tsAt(9)),
    ];
    const before = deriveClaims(base);
    const after = deriveClaims(withCheckpoint);
    expect(canonicalJson(before.claims)).toBe(canonicalJson(after.claims));
  });

  it('AutoApproved likewise promotes nothing', () => {
    const base = fullFixture();
    const withAutoApproval = [
      ...base,
      checkpointRaised(10, { stage: 'architecture', kind: 'irreversible' }),
      autoApproved(11, tsAt(9)),
    ];
    const before = deriveClaims(base);
    const after = deriveClaims(withAutoApproval);
    expect(canonicalJson(before.claims)).toBe(canonicalJson(after.claims));
  });

  it('across a full fixture, the set of T0 claims equals exactly the set of stack-fact claims', () => {
    const set = deriveClaims([
      ...fullFixture(),
      checkpointRaised(10, { stage: 'architecture', kind: 'irreversible' }),
      checkpointDecided(11, tsAt(9)),
    ]);
    const t0Ids = new Set(set.claims.filter((c) => c.tier === 'T0').map((c) => c.id));
    const stackFactIds = new Set(byKind(set.claims, 'stack-fact').map((c) => c.id));
    expect(t0Ids).toEqual(stackFactIds);
    expect(t0Ids.size).toBeGreaterThan(0);
  });
});

describe('deriveClaims: T3 demotion is insensitive to checkpoints', () => {
  it('yields byte-identical canonicalJson with and without a CheckpointDecided{accept}', () => {
    const plan = architecturePlanBody({
      decisions: [
        {
          decision_id: 'decision-example-2',
          title: 'Introduce cache layer',
          choice: 'Add Redis',
          alternatives: [],
          rationale: 'r2',
          req_ids: [],
          supersedes: null,
          blast_radius: 'irreversible',
        },
      ],
    });
    const withoutCheckpoint = [
      created(),
      stageCompleted(2, 'architecture', { kind: 'architecture-plan', body: plan }),
    ];
    const withCheckpoint = [
      ...withoutCheckpoint,
      // Same timestamp as the last claim-minting event: the checkpoint carries no new
      // information relevant to claims, so it must not even move `updatedAt`.
      checkpointRaised(3, { stage: 'architecture', kind: 'irreversible', ts: tsAt(2) }),
      checkpointDecided(4, tsAt(2)),
    ];
    const a = deriveClaims(withoutCheckpoint);
    const b = deriveClaims(withCheckpoint);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe('deriveClaims: contradiction (decision 5)', () => {
  function architectureWithOneDecision(seq: number): MienguEvent {
    return stageCompleted(seq, 'architecture', {
      kind: 'architecture-plan',
      body: architecturePlanBody({ components: [], interfaces: [] }),
    });
  }

  it('row 1: T1 wins against a T2 claim, which is quarantined with the record retained in full', () => {
    const events = [created(), architectureWithOneDecision(2)];
    const decisionId = deriveClaims(events).claims.find((c) => c.kind === 'decision')?.id;
    expect(decisionId).toBeDefined();
    const withDrift = [...events, driftDetected(3, decisionId as string)];
    const set = deriveClaims(withDrift);
    const claim = set.byId[decisionId as ClaimId];
    expect(claim?.status).toBe('quarantined');
    expect(claim?.quarantine).toEqual({
      byEventId: hexId('evt', 3),
      winnerTier: 'T1',
      expected: 'expected value',
      observed: 'observed value',
    });
    expect(claim?.statement).toBe('Use Postgres 15');
    expect(set.contested).toEqual([]);
  });

  it('row 2: a T0 claim stays active and the observation is contested as observation-quarantined', () => {
    const events = [created(), runStarted(2, VALID_CONFIG)];
    const stackFactId = deriveClaims(events).claims.find((c) => c.kind === 'stack-fact')?.id;
    expect(stackFactId).toBeDefined();
    const set = deriveClaims([...events, driftDetected(3, stackFactId as string)]);
    const claim = set.byId[stackFactId as ClaimId];
    expect(claim?.status).toBe('active');
    expect(claim?.quarantine).toBeNull();
    expect(set.contested).toEqual([
      {
        claimId: stackFactId,
        byEventId: hexId('evt', 3),
        outcome: 'observation-quarantined',
        expected: 'expected value',
        observed: 'observed value',
        at: tsAt(3),
      },
    ]);
  });

  it('row 3: a T1 claim ties and stays active, contested as a tie', () => {
    const events = [created(), diffCaptured(2, ['src/x.ts'])];
    const fileId = deriveClaims(events).claims.find((c) => c.kind === 'file')?.id;
    expect(fileId).toBeDefined();
    const set = deriveClaims([...events, driftDetected(3, fileId as string)]);
    const claim = set.byId[fileId as ClaimId];
    expect(claim?.status).toBe('active');
    expect(set.contested[0]?.outcome).toBe('tie');
  });

  it('row 4: a claim reference that resolves to nothing is never dropped', () => {
    const events = [created(), driftDetected(2, 'claim-example-999')];
    const set = deriveClaims(events);
    expect(set.contested).toEqual([
      {
        claimId: 'claim-example-999',
        byEventId: hexId('evt', 2),
        outcome: 'unknown-claim',
        expected: 'expected value',
        observed: 'observed value',
        at: tsAt(2),
      },
    ]);
  });
});

describe('deriveClaims: status lattice (decision 6)', () => {
  it('invalidated > quarantined > superseded > active, and invalidation never revives a predecessor', () => {
    const decisionV1 = {
      decision_id: 'decision-example-1',
      title: 'Use Postgres',
      choice: 'Use Postgres 15',
      alternatives: [],
      rationale: 'r',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    };
    const decisionV2 = { ...decisionV1, title: 'Use Postgres 16', choice: 'Use Postgres 16' };
    const eventV1 = stageCompleted(2, 'architecture', {
      kind: 'architecture-plan',
      body: architecturePlanBody({ decisions: [decisionV1], components: [], interfaces: [] }),
    });
    const eventV2 = stageCompleted(3, 'architecture', {
      kind: 'architecture-plan',
      body: architecturePlanBody({ decisions: [decisionV2], components: [], interfaces: [] }),
    });
    const events = [created(), eventV1, eventV2];
    const preliminary = deriveClaims(events);
    const claimV1 = preliminary.claims[0];
    const claimV2 = preliminary.claims[1];
    expect(claimV1?.status).toBe('superseded');
    expect(claimV1?.supersededByClaimId).toBe(claimV2?.id);
    expect(claimV2?.supersedesClaimId).toBe(claimV1?.id);
    expect(claimV2?.status).toBe('active');

    // Invalidate the successor (v2). v1 must stay 'superseded', never revive to 'active'.
    const withInvalidation = [...events, artifactsInvalidated(4, [eventV2.event_id])];
    const after = deriveClaims(withInvalidation);
    const v1After = after.claims.find((c) => c.id === claimV1?.id);
    const v2After = after.claims.find((c) => c.id === claimV2?.id);
    expect(v2After?.status).toBe('invalidated');
    expect(v1After?.status).toBe('superseded');
    expect(v1After?.supersededByClaimId).toBe(claimV2?.id);
  });

  it('quarantined outranks superseded', () => {
    const decisionV1 = {
      decision_id: 'decision-example-1',
      title: 'Use Postgres',
      choice: 'Use Postgres 15',
      alternatives: [],
      rationale: 'r',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    };
    const decisionV2 = { ...decisionV1, title: 'Use Postgres 16', choice: 'Use Postgres 16' };
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({ decisions: [decisionV1], components: [], interfaces: [] }),
      }),
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({ decisions: [decisionV2], components: [], interfaces: [] }),
      }),
    ];
    const claimV1Id = deriveClaims(events).claims[0]?.id;
    expect(claimV1Id).toBeDefined();
    const set = deriveClaims([...events, driftDetected(4, claimV1Id as string)]);
    const v1 = set.byId[claimV1Id as ClaimId];
    expect(v1?.status).toBe('quarantined');
    expect(v1?.supersededByClaimId).not.toBeNull();
  });
});

describe('activeClaims', () => {
  it('excludes superseded, invalidated and quarantined claims', () => {
    const decisionV1 = {
      decision_id: 'decision-example-1',
      title: 'Use Postgres',
      choice: 'Use Postgres 15',
      alternatives: [],
      rationale: 'r',
      req_ids: ['REQ-example-1'],
      supersedes: null,
      blast_radius: 'reversible',
    };
    const decisionV2 = { ...decisionV1, title: 'Use Postgres 16', choice: 'Use Postgres 16' };
    const decisionV3 = { ...decisionV1, title: 'Use Postgres 17', choice: 'Use Postgres 17' };
    const eventV3 = stageCompleted(4, 'architecture', {
      kind: 'architecture-plan',
      body: architecturePlanBody({ decisions: [decisionV3], components: [], interfaces: [] }),
    });
    const events = [
      created(),
      stageCompleted(2, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({ decisions: [decisionV1], components: [], interfaces: [] }),
      }),
      stageCompleted(3, 'architecture', {
        kind: 'architecture-plan',
        body: architecturePlanBody({ decisions: [decisionV2], components: [], interfaces: [] }),
      }),
      eventV3,
      diffCaptured(5, ['src/x.ts']),
    ];
    const preliminary = deriveClaims(events);
    const decisionClaims = byKind(preliminary.claims, 'decision');
    const [v1, v2, v3] = decisionClaims;
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    expect(v3).toBeDefined();
    // v2 is quarantined by a T1 observation; v3 (the latest, non-invalidated) stays active;
    // v1 is superseded (by v2) and must also be excluded from activeClaims.
    const set = deriveClaims([
      ...events,
      driftDetected(6, v2?.id as string),
      artifactsInvalidated(7, [eventV3.event_id]),
    ]);
    const active = activeClaims(set);
    expect(active.some((c) => c.id === v1?.id)).toBe(false);
    expect(active.some((c) => c.id === v2?.id)).toBe(false);
    expect(active.some((c) => c.id === v3?.id)).toBe(false);
    expect(active.every((c) => c.status === 'active')).toBe(true);
    const fileId = set.claims.find((c) => c.kind === 'file')?.id;
    expect(active.some((c) => c.id === fileId)).toBe(true);
  });

  it('filters by kind when given', () => {
    const set = deriveClaims(fullFixture());
    const files = activeClaims(set, 'file');
    expect(files.every((c) => c.kind === 'file')).toBe(true);
    expect(files.length).toBe(byKind(set.claims, 'file').length);
  });
});

describe('claimComponents', () => {
  it('returns trace.componentIds; empty means _unassigned', () => {
    const set = deriveClaims(fullFixture());
    const component = byKind(set.claims, 'component')[0];
    const requirement = byKind(set.claims, 'requirement')[0];
    expect(component).toBeDefined();
    expect(requirement).toBeDefined();
    expect(claimComponents(component as Claim)).toEqual(['component-example-1']);
    expect(claimComponents(requirement as Claim)).toEqual([]);
  });
});

describe('artifactSectionTier', () => {
  it('returns the weakest tier among active claims minted by eventId, or fallback', () => {
    const set = deriveClaims(fullFixture());
    const architectureEvent = fullFixture()[3];
    expect(architectureEvent?.type).toBe('StageCompleted');
    const tier = artifactSectionTier(set, architectureEvent?.event_id as EventId, 'T2');
    expect(tier).toBe('T2');
    expect(artifactSectionTier(set, null, 'T2')).toBe('T2');
    expect(artifactSectionTier(set, hexId('evt', 999) as EventId, 'T2')).toBe('T2');
  });
});

describe('deriveClaims: malformed input never invents a claim', () => {
  it('an unparseable RunStarted.data.config yields no stack-fact claims', () => {
    const set = deriveClaims([created(), runStarted(2, { not: 'a config' })]);
    expect(byKind(set.claims, 'stack-fact')).toEqual([]);
  });

  it('an artifact body that does not match its contract shape yields no claim from that event', () => {
    const set = deriveClaims([
      created(),
      stageCompleted(2, 'analysis', { kind: 'requirement-set', body: { not: 'a requirement set' } }),
    ]);
    expect(byKind(set.claims, 'requirement')).toEqual([]);
  });

  it('a null artifact yields no claim', () => {
    const set = deriveClaims([created(), stageCompleted(2, 'analysis', null)]);
    expect(byKind(set.claims, 'requirement')).toEqual([]);
  });
});

describe('CLAIM_KINDS', () => {
  it('matches the order the ordering rule relies on', () => {
    expect(CLAIM_KINDS).toEqual([
      'stack-fact',
      'requirement',
      'decision',
      'component',
      'interface',
      'task',
      'test-case',
      'file',
      'assumption',
      'oracle-result',
    ]);
  });
});
