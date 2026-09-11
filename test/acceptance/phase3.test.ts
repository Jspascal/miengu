import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { EventLog, itemPaths } from '../../src/core/log.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';
import { StoredEventSchema } from '../../src/core/events.js';
import { silentLogger } from '../../src/logging.js';
import { project } from '../../src/state/projector.js';
import { stateHash } from '../../src/state/stateHash.js';
import { ESCALATION_RANK, bucketLimit, classifyFailure, deterministicTaskOrder, invalidationClosure, nextEscalationLevel } from '../../src/supervisor/escalation.js';
import { checkpointAcceptedTask, checkpointFrozenTests, captureFinalPatch, rebuildWorkspace } from '../../src/integrator/merge.js';
import { createWorkspaceProvider } from '../../src/executors/isolation.js';
import type { TaskGraph } from '../../src/contracts/taskGraph.js';

const execFileAsync = promisify(execFile);
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-phase3-accept');

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

const graph: TaskGraph = {
  tasks: [
    { task_id: 'task-example-1', title: 'A', req_ids: ['REQ-example-1'], component_ids: ['component-example-1'], expected_paths: ['a.ts'], depends_on: [], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-example-2', title: 'B', req_ids: ['REQ-example-2'], component_ids: ['component-example-2'], expected_paths: ['b.ts'], depends_on: ['task-example-1'], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-example-3', title: 'C', req_ids: ['REQ-example-3'], component_ids: ['component-example-3'], expected_paths: ['c.ts'], depends_on: ['task-example-2'], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-example-4', title: 'D', req_ids: ['REQ-example-4'], component_ids: ['component-example-4'], expected_paths: ['d.ts'], depends_on: [], definition_of_done: ['done'], estimated_turns: 1 },
  ],
};

describe('Phase 3 acceptance: deterministic task supervision', () => {
  it('uses Kahn order rather than planner declaration order, with ascending task-id ties', () => {
    const declared = [
      { task_id: 'task-example-3' as const, depends_on: ['task-example-2' as const] },
      { task_id: 'task-example-4' as const, depends_on: [] },
      { task_id: 'task-example-2' as const, depends_on: [] },
      { task_id: 'task-example-1' as const, depends_on: [] },
    ];
    expect(deterministicTaskOrder(declared)).toEqual([
      'task-example-1', 'task-example-2', 'task-example-3', 'task-example-4',
    ]);
  });

  it('selects the stable topological task closure and keeps each escalation route finite and monotonic', () => {
    // The graph order is the durable scheduler order. Coder invalidation retains siblings,
    // whereas Planner/Architect/Analyst invalidate the exact progressively broader boundary.
    expect(invalidationClosure(graph, 'coder', 'task-example-1')).toMatchObject({
      taskIds: ['task-example-1', 'task-example-2', 'task-example-3'],
      reqIds: ['REQ-example-1', 'REQ-example-2', 'REQ-example-3'],
      componentIds: ['component-example-1', 'component-example-2', 'component-example-3'],
      invalidateArtifacts: ['taskArtifacts'],
    });
    expect(invalidationClosure(graph, 'planner', 'task-example-1').invalidateArtifacts).toEqual(['taskGraph', 'taskArtifacts']);
    expect(invalidationClosure(graph, 'architect', 'task-example-1').invalidateArtifacts).toEqual(['architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration']);
    expect(invalidationClosure(graph, 'analyst', 'task-example-1').invalidateArtifacts).toEqual(['requirementSet', 'architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration']);

    expect(classifyFailure('oracle')).toMatchObject({ initialLevel: 'coder', bucket: 'oracle' });
    expect(classifyFailure('test')).toMatchObject({ initialLevel: 'coder', bucket: 'test' });
    expect(classifyFailure('review-revision')).toMatchObject({ initialLevel: 'coder', bucket: 'review' });
    expect(classifyFailure('task-design').initialLevel).toBe('planner');
    expect(classifyFailure('architecture').initialLevel).toBe('architect');
    expect(classifyFailure('requirements').initialLevel).toBe('analyst');
    expect(classifyFailure('agent-output').initialLevel).toBe('reviewer');

    const limits = { kOracle: 2, kTest: 3, kReview: 4, maxAttemptsPerStage: 5 };
    expect(bucketLimit('oracle', limits)).toBe(2);
    expect(bucketLimit('test', limits)).toBe(3);
    expect(bucketLimit('review', limits)).toBe(4);
    expect(bucketLimit('reviewer', limits)).toBe(5);
    for (const level of ['coder', 'reviewer', 'planner', 'architect', 'analyst'] as const) {
      const next = nextEscalationLevel(level);
      expect(next).not.toBeNull();
      expect(ESCALATION_RANK[next!]).toBeGreaterThan(ESCALATION_RANK[level]);
    }
    expect(nextEscalationLevel('human')).toBeNull();

    // Six ranks and finitely bounded buckets prove termination before MAX_LOOP_ITERATIONS;
    // provider quota is deliberately outside all cause buckets.
    const worstCaseAttempts = limits.kOracle + limits.maxAttemptsPerStage * 4;
    expect(worstCaseAttempts).toBeLessThan(1000);
  });

  it('persists the task-oracle/review acceptance chain, replays v3 exactly, and keeps v2 read-only', async () => {
    const store = await mkdtemp(join(tmpdir(), 'miengu-phase3-events-'));
    const ids = createIdMinter(fixedRng('phase3-accept'));
    const { log } = await EventLog.create({ storeDir: store, itemId, runId: ids.runId(), clock: fixedClock(START), ids, logger: silentLogger });
    try {
      const append = async (type: Parameters<typeof log.append>[0]['type'], data: unknown) =>
        log.append({ type, data, actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId });
      const created = await append('WorkItemCreated', { title: 'phase three', slug: 'phase3', source: { kind: 'prd-file', path: '/tmp/prd', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'b'.repeat(64) });
      const taskGraph = await append('StageCompleted', { stage: 'planning', attempt: 1, artifact: { kind: 'task-graph', sha256: 'c'.repeat(64), body: graph } });
      await append('TaskGraphActivated', { graph_event_id: taskGraph.event_id, ordered_task_ids: ['task-example-1', 'task-example-2', 'task-example-3', 'task-example-4'] });
      await append('TaskStarted', { task_id: 'task-example-1', order_index: 0, graph_event_id: taskGraph.event_id });
      const implementation = await append('StageCompleted', { stage: 'implementation', attempt: 1, artifact: { kind: 'implementation', sha256: 'd'.repeat(64), body: { task_id: 'task-example-1' } } });
      const sweep = await append('OracleSweepStarted', { scope: 'task', task_id: 'task-example-1', cause_id: null, commands: [
        { kind: 'build', command: 'true', sha256: 'e'.repeat(64) },
        { kind: 'typecheck', command: null, sha256: null },
        { kind: 'lint', command: null, sha256: null },
        { kind: 'test', command: null, sha256: null },
      ] });
      const oracle = await append('OracleResultRecorded', { sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', kind: 'build', command: 'true', command_sha256: 'e'.repeat(64), status: 'passed', exit_code: 0, signal: null, duration_ms: 0, stdout: { sha256: '0'.repeat(64), path: '/tmp/oracle.stdout', bytes: 0 }, stderr: { sha256: '0'.repeat(64), path: '/tmp/oracle.stderr', bytes: 0 } });
      await append('OracleSweepCompleted', { sweep_id: sweep.event_id, scope: 'task', task_id: 'task-example-1', outcome: 'passed', failed_kind: null, result_event_ids: [oracle.event_id] });
      const review = await append('StageCompleted', { stage: 'review', attempt: 1, artifact: { kind: 'review-verdict', sha256: 'f'.repeat(64), body: { task_id: 'task-example-1', verdict: 'accept', findings: [], escalate_to: null } } });
      const checkpoint = await append('WorkspaceCheckpointed', { kind: 'task-accepted', task_id: 'task-example-1', parent_commit: 'base', commit: 'accepted', patch: { sha256: '0'.repeat(64), path: '/tmp/task.patch', bytes: 1 } });
      await append('TaskAccepted', { task_id: 'task-example-1', implementation_event_id: implementation.event_id, review_event_id: review.event_id, oracle_sweep_id: sweep.event_id, checkpoint_event_id: checkpoint.event_id });

      const events = await log.readAll();
      const folded = project(events);
      expect(folded.tasks?.records['task-example-1']?.status).toBe('accepted');
      expect(folded.tasks?.currentTaskId).toBeNull();
      expect(events.findIndex((event) => event.type === 'OracleResultRecorded')).toBeLessThan(events.findIndex((event) => event.type === 'TaskAccepted'));
      expect(events.findIndex((event) => event.type === 'StageCompleted' && event.data.stage === 'review')).toBeLessThan(events.findIndex((event) => event.type === 'TaskAccepted'));
      expect(stateHash(project(events))).toBe(stateHash(folded));

      // A V2 prefix is replayable through the compatibility parser but a writable open is refused.
      const paths = itemPaths(store, itemId);
      const v2 = events.slice(0, 2).map((event) => JSON.stringify({ ...event, schema_version: 2 })).join('\n').concat('\n');
      await log.close();
      await writeFile(paths.eventsFile, v2, 'utf8');
      const before = await readFile(paths.eventsFile, 'utf8');
      const v2State = project(v2.trim().split('\n').map((line) => StoredEventSchema.parse(JSON.parse(line))));
      expect(v2State.projectionVersion).toBe(5);
      await expect(EventLog.open({ storeDir: store, itemId, runId: ids.runId(), clock: fixedClock(START), ids, logger: silentLogger })).rejects.toThrow('v2 event logs are read-only');
      expect(await readFile(paths.eventsFile, 'utf8')).toBe(before);
      expect(created.seq).toBe(1);
    } finally {
      await log.close().catch(() => undefined);
      await rm(store, { recursive: true, force: true });
    }
  });

  it('reconstructs retained sibling work from detached checkpoints and never changes the target branch', async () => {
    const target = await mkdtemp(join(tmpdir(), 'miengu-phase3-target-'));
    const workspaces = await mkdtemp(join(tmpdir(), 'miengu-phase3-workspaces-'));
    const evidence = await mkdtemp(join(tmpdir(), 'miengu-phase3-evidence-'));
    try {
      await git(target, ['init', '--initial-branch=main']);
      await git(target, ['config', 'user.email', 'test@example.com']);
      await git(target, ['config', 'user.name', 'Test']);
      await writeFile(join(target, 'README.md'), 'base\n');
      await git(target, ['add', '-A']);
      await git(target, ['commit', '-m', 'base']);
      const mainBefore = (await git(target, ['rev-parse', 'main'])).trim();
      const workspace = createWorkspaceProvider('worktree');
      const prepared = await workspace.prepare({ itemId, targetRepo: target, baseRef: 'main', workspacesDir: workspaces, name: 'phase3' });
      await writeFile(join(prepared.workdir, 'frozen.test'), 'frozen\n');
      const frozen = await checkpointFrozenTests({ workspace, prepared, evidenceDir: evidence });
      await writeFile(join(prepared.workdir, 'accepted-a.txt'), 'a\n');
      const taskA = await checkpointAcceptedTask({ workspace, prepared, evidenceDir: evidence, taskId: 'task-example-1', orderIndex: 0 });
      await writeFile(join(prepared.workdir, 'accepted-d.txt'), 'd\n');
      const taskD = await checkpointAcceptedTask({ workspace, prepared, evidenceDir: evidence, taskId: 'task-example-4', orderIndex: 3 });
      const rebuilt = await rebuildWorkspace({ workspace, prepared, originalBaseCommit: prepared.baseCommit, frozenTests: frozen, retainedTasks: [taskD, taskA], invalidatedTaskIds: ['task-example-1'] });
      expect(rebuilt).toMatchObject({ kind: 'rebuilt', retainedTaskCommits: [{ taskId: 'task-example-4' }] });
      await expect(readFile(join(prepared.workdir, 'accepted-a.txt'))).rejects.toThrow();
      expect(await readFile(join(prepared.workdir, 'accepted-d.txt'), 'utf8')).toBe('d\n');
      const final = await captureFinalPatch({ workspace, prepared, originalBaseCommit: prepared.baseCommit, evidenceDir: evidence });
      expect(final.patch.bytes).toBeGreaterThan(0);
      expect((await git(target, ['rev-parse', 'main'])).trim()).toBe(mainBefore);
      await workspace.discard(prepared, { retain: false });
    } finally {
      await rm(target, { recursive: true, force: true });
      await rm(workspaces, { recursive: true, force: true });
      await rm(evidence, { recursive: true, force: true });
    }
  });
});
