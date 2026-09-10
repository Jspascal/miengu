import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../src/core/canonical.js';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent } from '../../src/core/events.js';
import { project } from '../../src/state/projector.js';
import { deriveClaims } from '../../src/wiki/records.js';
import { buildBatchReport, renderBatchReport } from '../../src/report/batch.js';
import type { BatchReportInput, BatchReportItemInput } from '../../src/report/batch.js';

const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';

let globalCounter = 0;

function nextTs(): string {
  globalCounter += 1;
  const seconds = Math.floor(globalCounter / 1000) % 60;
  const millis = globalCounter % 1000;
  return `2024-01-01T00:00:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}Z`;
}

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface EventBuilder {
  readonly mkEvent: (type: EventType, data: unknown, causationId?: MienguEvent['causation_id']) => MienguEvent;
}

function makeItemBuilder(itemId: string): EventBuilder {
  let seq = 0;
  return {
    mkEvent(type: EventType, data: unknown, causationId: MienguEvent['causation_id'] = null): MienguEvent {
      seq += 1;
      globalCounter += 1;
      return MienguEventSchema.parse({
        schema_version: 3,
        event_id: hexId('evt', globalCounter),
        seq,
        item_id: itemId,
        run_id: RUN_ID,
        ts: nextTs(),
        tier: DEFAULT_TIER[type],
        actor: { kind: 'system', id: null },
        causation_id: causationId,
        type,
        data,
      });
    },
  };
}

function itemInput(itemId: string, events: readonly MienguEvent[]): BatchReportItemInput {
  return { itemId: itemId as BatchReportItemInput['itemId'], events };
}

function workItemCreated(eb: EventBuilder, title: string, slug: string): MienguEvent {
  return eb.mkEvent('WorkItemCreated', {
    title,
    slug,
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    config_hash: 'deadbeef',
  });
}

function stageCompleted(
  eb: EventBuilder,
  stage: 'analysis' | 'architecture' | 'planning' | 'test-authoring' | 'implementation' | 'review',
  artifact: { kind: string; body: unknown } | null,
): MienguEvent {
  return eb.mkEvent('StageCompleted', {
    stage,
    attempt: 1,
    artifact: artifact === null ? null : { kind: artifact.kind, sha256: 'b'.repeat(64), body: artifact.body },
  });
}

function checkpointRaised(
  eb: EventBuilder,
  checkpoint: string,
  kind: 'irreversible' | 'agent-originated' | 'blast-radius' | 'assumption-gate' | 'escalation',
  stage: string,
  summary: string,
  blocking: boolean,
): MienguEvent {
  return eb.mkEvent('CheckpointRaised', {
    checkpoint,
    kind,
    stage,
    summary,
    blocking,
    sla_seconds: null,
    default_decision: null,
  });
}

function checkpointDecided(eb: EventBuilder, checkpoint: string, decision: 'accept' | 'reject'): MienguEvent {
  return eb.mkEvent('CheckpointDecided', { checkpoint, decision, by: 'human', reason: null });
}

function autoApproved(eb: EventBuilder, checkpoint: string): MienguEvent {
  return eb.mkEvent('AutoApproved', { checkpoint, after: '300s', no_human_response: true });
}

function assumptionRecorded(
  eb: EventBuilder,
  id: string,
  question: string,
  chosen: string,
  alternatives: string[],
  affects: string[],
  depth: number,
): MienguEvent {
  return eb.mkEvent('AssumptionRecorded', { id, question, chosen, alternatives, affects, depth });
}

function runStarted(eb: EventBuilder, config: unknown): MienguEvent {
  return eb.mkEvent('RunStarted', {
    miengu_version: '0.1.0',
    node_version: 'v20.0.0',
    config_hash: 'deadbeef',
    config,
  });
}

function diffCaptured(
  eb: EventBuilder,
  filesTouched: string[],
  untracked: string[],
  insertions: number,
  deletions: number,
): MienguEvent {
  return eb.mkEvent('DiffCaptured', {
    workdir: '/tmp/workdir',
    diff_sha256: 'a'.repeat(64),
    diff_ref: null,
    files_touched: filesTouched,
    untracked,
    insertions,
    deletions,
    committed_during_run: false,
  });
}

function workItemParked(
  eb: EventBuilder,
  reason: 'budget-exhausted' | 'provider-quota' | 'attempts-exhausted' | 'awaiting-human' | 'operator-abort' | 'executor-unavailable',
  detail: string,
  resumable: boolean,
  account: string | null,
  resetsAt: string | null,
): MienguEvent {
  return eb.mkEvent('WorkItemParked', { reason, detail, resumable, account, resets_at: resetsAt });
}

function driftDetected(
  eb: EventBuilder,
  claim: string,
  expected: string,
  observed: string,
  area: string | null = null,
): MienguEvent {
  return eb.mkEvent('DriftDetected', { claim, expected, observed, area });
}

/** By default every oracle is skipped (declared with `command: null`). `activeKinds` names
 *  the ones this sweep will actually record a result for, in fixed build/typecheck/lint/test
 *  order (the only order the projector accepts). */
function oracleSweepStarted(
  eb: EventBuilder,
  scope: 'task' | 'integration',
  taskId: string | null,
  activeKinds: readonly ('build' | 'typecheck' | 'lint' | 'test')[] = [],
): MienguEvent {
  const order: readonly ('build' | 'typecheck' | 'lint' | 'test')[] = ['build', 'typecheck', 'lint', 'test'];
  return eb.mkEvent('OracleSweepStarted', {
    scope,
    task_id: taskId,
    cause_id: null,
    commands: order.map((kind) =>
      activeKinds.includes(kind)
        ? { kind, command: `run ${kind}`, sha256: 'f'.repeat(64) }
        : { kind, command: null, sha256: null },
    ),
  });
}

function oracleResultRecorded(
  eb: EventBuilder,
  sweepId: string,
  scope: 'task' | 'integration',
  taskId: string | null,
  kind: 'build' | 'typecheck' | 'lint' | 'test',
  status: 'passed' | 'failed' | 'timed-out' | 'aborted' | 'spawn-error',
  exitCode: number | null,
): MienguEvent {
  return eb.mkEvent('OracleResultRecorded', {
    sweep_id: sweepId,
    scope,
    task_id: taskId,
    kind,
    command: `run ${kind}`,
    command_sha256: 'f'.repeat(64),
    status,
    exit_code: exitCode,
    signal: null,
    duration_ms: 1,
    stdout: { sha256: 'c'.repeat(64), path: '/tmp/out.log', bytes: 1 },
    stderr: { sha256: 'd'.repeat(64), path: '/tmp/err.log', bytes: 1 },
  });
}

function oracleSweepCompleted(
  eb: EventBuilder,
  sweepId: string,
  scope: 'task' | 'integration',
  taskId: string | null,
  outcome: 'passed' | 'failed' | 'aborted',
  failedKind: 'build' | 'typecheck' | 'lint' | 'test' | null,
  resultEventIds: readonly string[] = [],
): MienguEvent {
  return eb.mkEvent('OracleSweepCompleted', {
    sweep_id: sweepId,
    scope,
    task_id: taskId,
    outcome,
    failed_kind: failedKind,
    result_event_ids: resultEventIds,
  });
}

function taskGraphActivated(eb: EventBuilder, graphEventId: string, orderedTaskIds: string[]): MienguEvent {
  return eb.mkEvent('TaskGraphActivated', { graph_event_id: graphEventId, ordered_task_ids: orderedTaskIds });
}

function taskStarted(eb: EventBuilder, taskId: string, orderIndex: number, graphEventId: string): MienguEvent {
  return eb.mkEvent('TaskStarted', { task_id: taskId, order_index: orderIndex, graph_event_id: graphEventId });
}

function workspaceCheckpointed(
  eb: EventBuilder,
  kind: 'tests-frozen' | 'task-accepted',
  taskId: string | null,
  parentCommit: string,
  commit: string,
): MienguEvent {
  return eb.mkEvent('WorkspaceCheckpointed', {
    kind,
    task_id: taskId,
    parent_commit: parentCommit,
    commit,
    patch: { sha256: 'e'.repeat(64), path: '/tmp/a.patch', bytes: 1 },
  });
}

function taskAccepted(
  eb: EventBuilder,
  taskId: string,
  implementationEventId: string,
  reviewEventId: string,
  oracleSweepId: string,
  checkpointEventId: string,
): MienguEvent {
  return eb.mkEvent(
    'TaskAccepted',
    {
      task_id: taskId,
      implementation_event_id: implementationEventId,
      review_event_id: reviewEventId,
      oracle_sweep_id: oracleSweepId,
      checkpoint_event_id: checkpointEventId,
    },
    checkpointEventId as MienguEvent['causation_id'],
  );
}

/** A minimal item: created only, no shipped work. */
function minimalItem(itemId: string, title: string, slug: string): BatchReportItemInput {
  const eb = makeItemBuilder(itemId);
  return itemInput(itemId, [workItemCreated(eb, title, slug)]);
}

/** One item's full lifecycle to a single accepted task, fed by a decision/component/
 *  requirement chain, so `shipped`, `agentOriginated` and `drift`'s touched-component logic
 *  each have something real to report on. */
function buildShippedItem(
  itemId: string,
  slug: string,
  title: string,
): {
  readonly item: BatchReportItemInput;
  readonly taskId: string;
  readonly reqId: string;
  readonly decisionId: string;
  readonly componentId: string;
} {
  const eb = makeItemBuilder(itemId);
  const reqId = `REQ-${slug}-1`;
  const decisionId = `decision-${slug}-1`;
  const componentId = `component-${slug}-1`;
  const taskId = `task-${slug}-1`;

  const events: MienguEvent[] = [];
  events.push(workItemCreated(eb, title, slug));
  events.push(
    stageCompleted(eb, 'analysis', {
      kind: 'requirement-set',
      body: {
        requirements: [
          {
            req_id: reqId,
            statement: 'do the thing',
            rationale: 'because',
            acceptance: ['it works'],
            priority: 'must',
            source_span: 'prd.md#L1',
          },
        ],
        ambiguities: [],
        out_of_scope: [],
      },
    }),
  );
  events.push(
    stageCompleted(eb, 'architecture', {
      kind: 'architecture-plan',
      body: {
        decisions: [
          {
            decision_id: decisionId,
            title: 't',
            choice: 'use X',
            alternatives: [],
            rationale: 'r',
            req_ids: [reqId],
            supersedes: null,
            blast_radius: 'reversible',
          },
        ],
        components: [{ component_id: componentId, responsibility: 'r', paths: [], depends_on: [] }],
        interfaces: [],
      },
    }),
  );
  const graph = stageCompleted(eb, 'planning', {
    kind: 'task-graph',
    body: {
      tasks: [
        {
          task_id: taskId,
          title: 't',
          req_ids: [reqId],
          component_ids: [componentId],
          expected_paths: ['src/x.ts'],
          depends_on: [],
          definition_of_done: ['d'],
          estimated_turns: 1,
        },
      ],
    },
  });
  events.push(graph);
  events.push(taskGraphActivated(eb, graph.event_id, [taskId]));
  events.push(taskStarted(eb, taskId, 0, graph.event_id));
  const implementation = stageCompleted(eb, 'implementation', {
    kind: 'implementation',
    body: { task_id: taskId, diff_ref: 'ref', files_touched: ['src/x.ts'], assumption_ids: [], deviations: [] },
  });
  events.push(implementation);
  const sweep = oracleSweepStarted(eb, 'task', taskId);
  events.push(sweep);
  events.push(oracleSweepCompleted(eb, sweep.event_id, 'task', taskId, 'passed', null));
  const review = stageCompleted(eb, 'review', {
    kind: 'review-verdict',
    body: { task_id: taskId, verdict: 'accept', findings: [], escalate_to: null },
  });
  events.push(review);
  const checkpoint = workspaceCheckpointed(eb, 'task-accepted', taskId, 'a'.repeat(40), 'b'.repeat(40));
  events.push(checkpoint);
  events.push(taskAccepted(eb, taskId, implementation.event_id, review.event_id, sweep.event_id, checkpoint.event_id));

  return { item: itemInput(itemId, events), taskId, reqId, decisionId, componentId };
}

function baseInput(items: readonly BatchReportItemInput[], overrides?: Partial<BatchReportInput>): BatchReportInput {
  return { locale: 'en', since: null, items, corrupt: [], ...overrides };
}

describe('§8 section order', () => {
  it('empty report contains no section heading', () => {
    const report = buildBatchReport(baseInput([]));
    const text = renderBatchReport(report, 'en');
    expect(text).not.toContain('##');
    expect(report.blockedIrreversible).toEqual([]);
    expect(report.agentOriginated).toEqual([]);
    expect(report.unresolvedAssumptions).toEqual([]);
    expect(report.oracleFailures).toEqual([]);
    expect(report.drift).toEqual([]);
    expect(report.shipped).toEqual([]);
    expect(report.corrupt).toEqual([]);
  });

  it('present sections follow the fixed order even when others are empty', () => {
    const itemId = 'wi-order-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Order item', 'order')];
    events.push(checkpointRaised(eb, 'cp-order-1', 'irreversible', 'architecture', 'ship it', true));
    events.push(assumptionRecorded(eb, 'assumption-order-1', 'q?', 'chosen', [], [], 0));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    const text = renderBatchReport(report, 'en');
    const blockedIdx = text.indexOf('## Blocked irreversible checkpoints');
    const assumptionsIdx = text.indexOf('## Unresolved assumptions');
    // Every qualifying item gets a `shipped` entry (even with zero accepted tasks), so this
    // section is always present once there is at least one item; the other three (nothing was
    // ever agent-originated, no oracle sweep ran, nothing drifted) are correctly absent.
    const shippedIdx = text.indexOf('## Shipped');
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(assumptionsIdx).toBeGreaterThan(blockedIdx);
    expect(shippedIdx).toBeGreaterThan(assumptionsIdx);
    expect(text).not.toContain('## Agent-originated decisions');
    expect(text).not.toContain('## Oracle failures');
    expect(text).not.toContain('## Drift');
    expect(text).not.toContain('## Corrupt items');
  });
});

describe('blockedIrreversible', () => {
  it('reads every open checkpoint with blocking === true, regardless of kind', () => {
    const itemId = 'wi-blocked-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Blocked item', 'blocked')];
    events.push(checkpointRaised(eb, 'cp-blocked-1', 'irreversible', 'integration', 'deploy summary', true));
    events.push(checkpointRaised(eb, 'cp-blocked-2', 'irreversible', 'integration', 'reversible one', false));
    events.push(checkpointRaised(eb, 'cp-blocked-3', 'agent-originated', 'architecture', 'also blocking', true));
    events.push(checkpointRaised(eb, 'cp-blocked-4', 'irreversible', 'integration', 'already accepted', true));
    events.push(checkpointDecided(eb, 'cp-blocked-4', 'accept'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    // §8 amendment: every open blocking checkpoint, not only kind === 'irreversible'.
    expect(report.blockedIrreversible).toHaveLength(2);
    expect(report.blockedIrreversible.map((b) => b.checkpointId)).toEqual(['cp-blocked-1', 'cp-blocked-3']);
    expect(report.blockedIrreversible[0]?.summary).toBe('deploy summary');
  });

  it('sorts irreversible first, then by (raisedAt, itemId, checkpointId)', () => {
    const itemId = 'wi-sorta-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'A', 'sorta')];
    events.push(checkpointRaised(eb, 'cp-sorta-2', 'irreversible', 'integration', 's2', true));
    events.push(checkpointRaised(eb, 'cp-sorta-1', 'irreversible', 'integration', 's1', true));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    const ids = report.blockedIrreversible.map((b) => b.checkpointId);
    // Raised in increasing ts order, so the earlier-raised checkpoint (cp-sorta-2) sorts first.
    expect(ids).toEqual(['cp-sorta-2', 'cp-sorta-1']);
  });

  it('places every irreversible checkpoint before a blocking non-irreversible one, regardless of raisedAt', () => {
    const itemId = 'wi-sortkind-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'A', 'sortkind')];
    events.push(checkpointRaised(eb, 'cp-sortkind-1', 'assumption-gate', 'architecture', 'gate', true));
    events.push(checkpointRaised(eb, 'cp-sortkind-2', 'irreversible', 'integration', 'later irreversible', true));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.blockedIrreversible.map((b) => b.checkpointId)).toEqual(['cp-sortkind-2', 'cp-sortkind-1']);
  });

  it('carries owner, sla, default, triggers and gatedAssumptionIds', () => {
    const itemId = 'wi-fields-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Fields', 'fields')];
    events.push(checkpointRaised(eb, 'cp-fields-1', 'irreversible', 'integration', 'irreversible summary', true));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.blockedIrreversible).toHaveLength(1);
    const entry = report.blockedIrreversible[0];
    expect(entry?.owner).toBe('operator');
    expect(entry?.slaSeconds).toBeNull();
    expect(entry?.defaultDecision).toBeNull();
    expect(entry?.triggers).toBeNull();
    expect(entry?.gatedAssumptionIds).toEqual([]);
  });
});

describe('agentOriginated', () => {
  it('reads claims where agentOriginated === true and links the same-stage checkpoint', () => {
    const itemId = 'wi-agentor-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Agent originated', 'agentor')];
    events.push(
      stageCompleted(eb, 'analysis', {
        kind: 'requirement-set',
        body: {
          requirements: [
            {
              req_id: 'REQ-agentor-1',
              statement: 'agent guessed this',
              rationale: 'r',
              acceptance: ['a'],
              priority: 'must',
              source_span: null,
            },
          ],
          ambiguities: [],
          out_of_scope: [],
        },
      }),
    );
    events.push(checkpointRaised(eb, 'cp-agentor-1', 'agent-originated', 'analysis', 'agent guessed', false));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.agentOriginated).toHaveLength(1);
    const entry = report.agentOriginated[0];
    expect(entry?.kind).toBe('requirement');
    expect(entry?.checkpointId).toBe('cp-agentor-1');
    expect(entry?.wikiLink).toContain(`${itemId}/`);
  });

  it('sorts by (itemId, claimId)', () => {
    const itemId = 'wi-agentor2-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Agent originated two', 'agentor2')];
    events.push(
      stageCompleted(eb, 'architecture', {
        kind: 'architecture-plan',
        body: {
          decisions: [
            {
              decision_id: 'decision-agentor2-1',
              title: 't',
              choice: 'c1',
              alternatives: [],
              rationale: 'r',
              req_ids: [],
              supersedes: null,
              blast_radius: 'reversible',
            },
            {
              decision_id: 'decision-agentor2-2',
              title: 't',
              choice: 'c2',
              alternatives: [],
              rationale: 'r',
              req_ids: [],
              supersedes: null,
              blast_radius: 'reversible',
            },
          ],
          components: [],
          interfaces: [],
        },
      }),
    );
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.agentOriginated).toHaveLength(2);
    const claimIds = report.agentOriginated.map((e) => e.claimId);
    expect([...claimIds].sort()).toEqual(claimIds);
  });
});

describe('unresolvedAssumptions', () => {
  it('every recorded assumption is reported (no Phase 4 producer resolves one)', () => {
    const itemId = 'wi-assume-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Assume', 'assume')];
    events.push(assumptionRecorded(eb, 'assumption-assume-1', 'q1', 'c1', [], [], 0));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.unresolvedAssumptions).toHaveLength(1);
  });

  it('sorts deepest first with a stable (itemId, assumptionId) tie-break', () => {
    const itemId = 'wi-assume2-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Assume two', 'assume2')];
    events.push(assumptionRecorded(eb, 'assumption-assume2-1', 'q1', 'c1', [], [], 1));
    events.push(assumptionRecorded(eb, 'assumption-assume2-2', 'q2', 'c2', [], [], 3));
    events.push(assumptionRecorded(eb, 'assumption-assume2-3', 'q3', 'c3', [], [], 3));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.unresolvedAssumptions.map((a) => a.assumptionId)).toEqual([
      'assumption-assume2-2',
      'assumption-assume2-3',
      'assumption-assume2-1',
    ]);
  });
});

describe('oracleFailures', () => {
  it('reads non-passed results only, carrying durable evidence refs', () => {
    const itemId = 'wi-oracle-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Oracle', 'oracle')];
    // A sweep may carry at most one non-passing result, and it must be the last one recorded
    // (the projector forbids any result following a non-passing one): build passes, test fails.
    const sweep = oracleSweepStarted(eb, 'integration', null, ['build', 'test']);
    events.push(sweep);
    const buildResult = oracleResultRecorded(eb, sweep.event_id, 'integration', null, 'build', 'passed', 0);
    events.push(buildResult);
    const testResult = oracleResultRecorded(eb, sweep.event_id, 'integration', null, 'test', 'failed', 1);
    events.push(testResult);
    events.push(
      oracleSweepCompleted(eb, sweep.event_id, 'integration', null, 'failed', 'test', [buildResult.event_id, testResult.event_id]),
    );
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.oracleFailures).toHaveLength(1);
    expect(report.oracleFailures[0]?.kind).toBe('test');
    expect(report.oracleFailures[0]?.stdout.path).toBe('/tmp/out.log');
  });

  it('sorts by (itemId, sweepId, ORACLE_KINDS index): two sweeps in one item order by sweepId', () => {
    const itemId = 'wi-oracle2-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Oracle two', 'oracle2')];
    const sweepA = oracleSweepStarted(eb, 'integration', null, ['test']);
    events.push(sweepA);
    const resultA = oracleResultRecorded(eb, sweepA.event_id, 'integration', null, 'test', 'failed', 1);
    events.push(resultA);
    events.push(oracleSweepCompleted(eb, sweepA.event_id, 'integration', null, 'failed', 'test', [resultA.event_id]));
    const sweepB = oracleSweepStarted(eb, 'integration', null, ['build']);
    events.push(sweepB);
    const resultB = oracleResultRecorded(eb, sweepB.event_id, 'integration', null, 'build', 'failed', 1);
    events.push(resultB);
    events.push(oracleSweepCompleted(eb, sweepB.event_id, 'integration', null, 'failed', 'build', [resultB.event_id]));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.oracleFailures).toHaveLength(2);
    const sortedBySweepId = [...report.oracleFailures].sort((a, b) => (a.sweepId < b.sweepId ? -1 : 1));
    expect(report.oracleFailures).toEqual(sortedBySweepId);
  });
});

describe('drift', () => {
  it('a quarantined claim renders with resolution claim-quarantined and its origin area', () => {
    const itemId = 'wi-drift-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Drift', 'drift')];
    events.push(
      stageCompleted(eb, 'architecture', {
        kind: 'architecture-plan',
        body: {
          decisions: [],
          components: [{ component_id: 'component-drift-1', responsibility: 'r', paths: [], depends_on: [] }],
          interfaces: [],
        },
      }),
    );
    const claimId = deriveClaims(events).claims.find((c) => c.kind === 'component')?.id;
    expect(claimId).toBeDefined();
    events.push(driftDetected(eb, claimId as string, 'expected value', 'observed value', 'auth'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]?.resolution).toBe('claim-quarantined');
    expect(report.drift[0]?.area).toBe('auth');
    expect(report.drift[0]?.wikiLink).toContain('component-drift-1.md');
  });

  it('unknown-claim contested entry is never dropped, and wikiLink is null', () => {
    const itemId = 'wi-drift2-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Drift two', 'drift2')];
    events.push(driftDetected(eb, 'claim-drift2-999', 'e', 'o'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]?.resolution).toBe('unknown-claim');
    expect(report.drift[0]?.wikiLink).toBeNull();
    const text = renderBatchReport(report, 'en');
    expect(text).toContain('claim not found');
  });

  it('touched-first: a drifted claim on an accepted task\'s component sorts before one that is not', () => {
    const itemId = 'wi-drift3-abc123';
    const { item, componentId } = buildShippedItem(itemId, 'drift3', 'Drift three');
    const eb = makeItemBuilder(itemId);
    const events = item.events.slice();
    const otherComponentEvent = stageCompleted(eb, 'architecture', {
      kind: 'architecture-plan',
      body: {
        decisions: [],
        components: [{ component_id: 'component-drift3-other-1', responsibility: 'r', paths: [], depends_on: [] }],
        interfaces: [],
      },
    });
    // Re-sequence this extra event onto the end of the already-built item log.
    const lastSeq = events[events.length - 1]?.seq ?? 0;
    events.push({ ...otherComponentEvent, seq: lastSeq + 1 } as MienguEvent);

    const set = deriveClaims(events);
    const touchedClaimId = set.claims.find((c) => c.kind === 'component' && c.subject === componentId)?.id;
    const untouchedClaimId = set.claims.find((c) => c.kind === 'component' && c.subject === 'component-drift3-other-1')?.id;
    expect(touchedClaimId).toBeDefined();
    expect(untouchedClaimId).toBeDefined();

    const nextSeq = lastSeq + 2;
    events.push({
      ...driftDetected(eb, untouchedClaimId as string, 'e1', 'o1'),
      seq: nextSeq,
    } as MienguEvent);
    events.push({
      ...driftDetected(eb, touchedClaimId as string, 'e2', 'o2'),
      seq: nextSeq + 1,
    } as MienguEvent);

    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.drift).toHaveLength(2);
    expect(report.drift[0]?.claimId).toBe(touchedClaimId);
    expect(report.drift[0]?.touched).toBe(true);
    expect(report.drift[1]?.claimId).toBe(untouchedClaimId);
    expect(report.drift[1]?.touched).toBe(false);
  });
});

describe('shipped', () => {
  it('reads accepted TaskRuntimeState records plus integration.finalPatch, with a decision chain', () => {
    const itemId = 'wi-ship-abc123';
    const { item, taskId, reqId, decisionId } = buildShippedItem(itemId, 'ship', 'Ship item');
    const report = buildBatchReport(baseInput([item]));
    expect(report.shipped).toHaveLength(1);
    const shippedItem = report.shipped[0];
    expect(shippedItem?.tasks).toHaveLength(1);
    expect(shippedItem?.tasks[0]?.taskId).toBe(taskId);
    expect(shippedItem?.tasks[0]?.reqIds).toEqual([reqId]);
    expect(shippedItem?.tasks[0]?.filesTouched).toEqual(['src/x.ts']);
    expect(shippedItem?.tasks[0]?.checkpointCommit).toBe('b'.repeat(40));
    expect(shippedItem?.decisionChain).toHaveLength(1);
    const linkedDecision = report.agentOriginated.find((a) => a.subject === decisionId);
    expect(linkedDecision).toBeUndefined(); // this decision was operator-sourced (req_ids non-empty), not agent-originated.
  });

  it('sorts by itemId', () => {
    const first = buildShippedItem('wi-shipa-abc123', 'shipa', 'A');
    const second = buildShippedItem('wi-shipb-abc123', 'shipb', 'B');
    const report = buildBatchReport(baseInput([second.item, first.item]));
    expect(report.shipped.map((s) => s.itemId)).toEqual(['wi-shipa-abc123', 'wi-shipb-abc123']);
  });
});

describe('--since (decision 20)', () => {
  it('omits an item whose updatedAt predates the cutoff entirely', () => {
    const oldItem = minimalItem('wi-old-abc123', 'Old item', 'old');
    const cutoff = '2099-01-01T00:00:00.000Z';
    const report = buildBatchReport(baseInput([oldItem], { since: cutoff as BatchReportInput['since'] }));
    expect(report.generatedFrom.items).toBe(0);
  });

  it('never hides a section within a qualifying item: a blocked irreversible checkpoint raised before the cutoff is still reported when the item updates after it', () => {
    const itemId = 'wi-since-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Since item', 'since')];
    events.push(checkpointRaised(eb, 'cp-since-1', 'irreversible', 'integration', 'old but blocking', true));
    events.push(assumptionRecorded(eb, 'assumption-since-1', 'q', 'c', [], [], 0));
    const state = project(events);
    const cutoff = state.checkpoints['cp-since-1']?.raisedAt as string;
    const report = buildBatchReport(baseInput([itemInput(itemId, events)], { since: cutoff as BatchReportInput['since'] }));
    expect(report.generatedFrom.items).toBe(1);
    expect(report.blockedIrreversible).toHaveLength(1);
    expect(report.blockedIrreversible[0]?.checkpointId).toBe('cp-since-1');
  });
});

describe('purity and determinism', () => {
  it('builds from a raw event array alone: no filesystem access, no WorkItemState passed in', () => {
    // The signature itself proves this: BatchReportItemInput carries only `events`.
    const item = buildShippedItem('wi-pure-abc123', 'pure', 'Pure item').item;
    const report = buildBatchReport(baseInput([item]));
    expect(report.shipped).toHaveLength(1);
  });

  it('build and render twice yields byte-identical output', () => {
    const item = buildShippedItem('wi-det-abc123', 'det', 'Det item').item;
    const input = baseInput([item]);
    const first = buildBatchReport(input);
    const second = buildBatchReport(input);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(renderBatchReport(first, 'en')).toBe(renderBatchReport(second, 'en'));
  });

  it('fr and en differ only in lexicon, with identical data ordering', () => {
    const item = buildShippedItem('wi-loc-abc123', 'loc', 'Loc item').item;
    const report = buildBatchReport(baseInput([item]));
    const en = renderBatchReport(report, 'en');
    const fr = renderBatchReport(report, 'fr');
    expect(en.split('\n').length).toBe(fr.split('\n').length);
    expect(en).toContain('wi-loc-abc123');
    expect(fr).toContain('wi-loc-abc123');
    expect(en).not.toBe(fr);
  });
});

describe('corrupt items', () => {
  it('a corrupt item is reported and does not suppress a healthy one', () => {
    const healthy = minimalItem('wi-healthy-abc123', 'Healthy item', 'healthy');
    const report = buildBatchReport(
      baseInput([healthy], {
        corrupt: [{ itemId: 'wi-broken-abc123' as BatchReportItemInput['itemId'], error: 'unreadable log' }],
      }),
    );
    expect(report.corrupt).toHaveLength(1);
    expect(report.corrupt[0]?.error).toBe('unreadable log');
    expect(report.generatedFrom.items).toBe(1);
    const text = renderBatchReport(report, 'en');
    expect(text).toContain('wi-broken-abc123');
  });
});

describe('AutoApproved never renders as a human decision', () => {
  it('an auto-approved checkpoint is excluded from blockedIrreversible and never labelled a human decision', () => {
    const itemId = 'wi-auto-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Auto item', 'auto')];
    events.push(checkpointRaised(eb, 'cp-auto-1', 'irreversible', 'integration', 'auto approved summary', true));
    events.push(autoApproved(eb, 'cp-auto-1'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.blockedIrreversible).toHaveLength(0);
    const text = renderBatchReport(report, 'en');
    expect(text).not.toMatch(/human decision/i);
    expect(text).not.toContain('AutoApproved');
  });
});

describe('Phase 5: blast-radius checkpoints in blockedIrreversible', () => {
  it('a blast-radius checkpoint sorts after an irreversible one and reproduces the classifier verdict', () => {
    const itemId = 'wi-blast-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Blast', 'blast')];
    events.push(
      runStarted(eb, {
        checkpoints: {
          defaultOwner: 'ops-team',
          blastRadius: { migrationOrSchemaPaths: ['**/migrations/**'] },
        },
      }),
    );
    const diff = diffCaptured(eb, ['db/migrations/001.sql'], [], 10, 0);
    events.push(diff);
    events.push(checkpointRaised(eb, 'cp-blast-1', 'irreversible', 'architecture', 'irreversible decision', true));
    events.push(eb.mkEvent('CheckpointRaised', {
      checkpoint: 'cp-blast-2',
      kind: 'blast-radius',
      stage: 'implementation',
      summary: 'blast radius gate',
      blocking: true,
      sla_seconds: null,
      default_decision: null,
    }, diff.event_id));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.blockedIrreversible.map((b) => b.checkpointId)).toEqual(['cp-blast-1', 'cp-blast-2']);
    const blastEntry = report.blockedIrreversible[1];
    expect(blastEntry?.owner).toBe('ops-team');
    expect(blastEntry?.triggers).toEqual([
      { trigger: 'migration-or-schema', severity: 'blocking', paths: ['db/migrations/001.sql'] },
    ]);
  });

  it('triggers is null, never an empty list, when causation_id does not resolve to a DiffCaptured', () => {
    const itemId = 'wi-blastunk-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Blast unknown', 'blastunk')];
    events.push(eb.mkEvent('CheckpointRaised', {
      checkpoint: 'cp-blastunk-1',
      kind: 'blast-radius',
      stage: 'implementation',
      summary: 'blast radius gate',
      blocking: true,
      sla_seconds: null,
      default_decision: null,
    }, null));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.blockedIrreversible).toHaveLength(1);
    expect(report.blockedIrreversible[0]?.triggers).toBeNull();
  });
});

describe('Phase 5: unresolvedAssumptions resolution and escalation', () => {
  it('an assumption resolved by an accepted assumption-gate checkpoint leaves unresolvedAssumptions', () => {
    const itemId = 'wi-resolved-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Resolved', 'resolved')];
    events.push(assumptionRecorded(eb, 'assumption-resolved-1', 'q1', 'c1', [], [], 0));
    events.push(checkpointRaised(eb, 'cp-resolved-1', 'assumption-gate', 'architecture', 'gate', true));
    events.push(checkpointDecided(eb, 'cp-resolved-1', 'accept'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.unresolvedAssumptions).toHaveLength(0);
  });

  it('a rejected gate does not resolve the assumption it gates', () => {
    const itemId = 'wi-rejected-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Rejected', 'rejected')];
    events.push(assumptionRecorded(eb, 'assumption-rejected-1', 'q1', 'c1', [], [], 0));
    events.push(checkpointRaised(eb, 'cp-rejected-1', 'assumption-gate', 'architecture', 'gate', true));
    events.push(checkpointDecided(eb, 'cp-rejected-1', 'reject'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.unresolvedAssumptions).toHaveLength(1);
    expect(report.unresolvedAssumptions[0]?.gateCheckpointId).toBe('cp-rejected-1');
  });

  it('escalated is true exactly at maxStackDepth and false below it', () => {
    const itemId = 'wi-escalate-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Escalate', 'escalate')];
    events.push(runStarted(eb, { assumptions: { maxStackDepth: 2 } }));
    events.push(assumptionRecorded(eb, 'assumption-escalate-1', 'q1', 'c1', [], [], 1));
    events.push(assumptionRecorded(eb, 'assumption-escalate-2', 'q2', 'c2', [], [], 2));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    const one = report.unresolvedAssumptions.find((a) => a.assumptionId === 'assumption-escalate-1');
    const two = report.unresolvedAssumptions.find((a) => a.assumptionId === 'assumption-escalate-2');
    expect(one?.escalated).toBe(false);
    expect(two?.escalated).toBe(true);
  });
});

describe('Phase 5: ShippedItem.park', () => {
  it('a quota park is carried on the shipped entry', () => {
    const itemId = 'wi-shippark-abc123';
    const eb = makeItemBuilder(itemId);
    const events: MienguEvent[] = [workItemCreated(eb, 'Shipped park', 'shippark')];
    events.push(workItemParked(eb, 'provider-quota', 'waiting on window', true, 'stub-account', '2024-06-01T00:00:00.000Z'));
    const report = buildBatchReport(baseInput([itemInput(itemId, events)]));
    expect(report.shipped).toHaveLength(1);
    expect(report.shipped[0]?.park).toEqual({
      reason: 'provider-quota',
      detail: 'waiting on window',
      account: 'stub-account',
      resetsAt: '2024-06-01T00:00:00.000Z',
      resumable: true,
    });
  });

  it('park is null for an item that never parked', () => {
    const item = minimalItem('wi-nopark-abc123', 'No park', 'nopark');
    const report = buildBatchReport(baseInput([item]));
    expect(report.shipped).toHaveLength(1);
    expect(report.shipped[0]?.park).toBeNull();
  });
});

describe('Phase 5: report shape is re-asserted', () => {
  it('the section order is unchanged and no generatedAt field exists', () => {
    const item = buildShippedItem('wi-reassert-abc123', 'reassert', 'Reassert item').item;
    const report = buildBatchReport(baseInput([item]));
    expect(Object.keys(report)).not.toContain('generatedAt');
    expect(Object.keys(report)).toEqual([
      'generatedFrom',
      'blockedIrreversible',
      'agentOriginated',
      'unresolvedAssumptions',
      'oracleFailures',
      'drift',
      'shipped',
      'corrupt',
    ]);
  });
});
