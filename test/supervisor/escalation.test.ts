import { describe, expect, it } from 'vitest';
import type { FailureKind } from '../../src/core/events.js';
import type { TaskGraph } from '../../src/contracts/taskGraph.js';
import {
  bucketLimit,
  classifyFailure,
  escalationRank,
  invalidationClosure,
  nextEscalationLevel,
} from '../../src/supervisor/escalation.js';

const LIMITS = { kOracle: 3, kTest: 2, kReview: 4, maxAttemptsPerStage: 5 };
const graph: TaskGraph = {
  tasks: [
    { task_id: 'task-a', title: 'A', req_ids: ['req-a'], component_ids: ['cmp-a'], expected_paths: ['a.ts'], depends_on: [], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-b', title: 'B', req_ids: ['req-b'], component_ids: ['cmp-b'], expected_paths: ['b.ts'], depends_on: ['task-a'], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-c', title: 'C', req_ids: ['req-c'], component_ids: ['cmp-c'], expected_paths: ['c.ts'], depends_on: ['task-b'], definition_of_done: ['done'], estimated_turns: 1 },
    { task_id: 'task-d', title: 'D', req_ids: ['req-d'], component_ids: ['cmp-d'], expected_paths: ['d.ts'], depends_on: [], definition_of_done: ['done'], estimated_turns: 1 },
  ],
};

describe('escalation', () => {
  it.each([
    ['oracle', 'oracle', 'coder'], ['test', 'test', 'coder'], ['review-revision', 'review', 'coder'],
    ['task-design', 'planner', 'planner'], ['architecture', 'architect', 'architect'],
    ['requirements', 'analyst', 'analyst'], ['agent-output', 'reviewer', 'reviewer'],
    ['sandbox', 'planner', 'planner'], ['integration', 'planner', 'planner'],
  ] as const)('classifies %s', (kind, bucket, level) => {
    expect(classifyFailure(kind as FailureKind)).toMatchObject({ bucket, initialLevel: level });
  });

  it('uses the three special limits and the general agent limit', () => {
    expect(bucketLimit('oracle', LIMITS)).toBe(3);
    expect(bucketLimit('test', LIMITS)).toBe(2);
    expect(bucketLimit('review', LIMITS)).toBe(4);
    expect(bucketLimit('planner', LIMITS)).toBe(5);
  });

  it('advances strictly through human and never wraps', () => {
    const levels = ['coder', 'reviewer', 'planner', 'architect', 'analyst', 'human'] as const;
    for (const [index, level] of levels.entries()) {
      const next = nextEscalationLevel(level);
      if (index === levels.length - 1) expect(next).toBeNull();
      else expect(escalationRank(next!)).toBeGreaterThan(escalationRank(level));
    }
  });

  it('uses the coder dependent closure and sorts every affected id', () => {
    expect(invalidationClosure(graph, 'coder', 'task-a')).toEqual({
      taskIds: ['task-a', 'task-b', 'task-c'], reqIds: ['req-a', 'req-b', 'req-c'], componentIds: ['cmp-a', 'cmp-b', 'cmp-c'], invalidateArtifacts: ['taskArtifacts'],
    });
  });

  it('uses the same bytewise ordering as the persisted Kahn schedule', () => {
    const byteOrderGraph: TaskGraph = {
      tasks: [
        { task_id: 'task-z-1', title: 'Z', req_ids: ['REQ-z-1'], component_ids: ['component-z-1'], expected_paths: ['z.ts'], depends_on: [], definition_of_done: ['done'], estimated_turns: 1 },
        { task_id: 'task-a-1', title: 'A', req_ids: ['REQ-a-1'], component_ids: ['component-a-1'], expected_paths: ['a.ts'], depends_on: ['task-z-1'], definition_of_done: ['done'], estimated_turns: 1 },
        { task_id: 'task-b-1', title: 'B', req_ids: ['REQ-b-1'], component_ids: ['component-b-1'], expected_paths: ['b.ts'], depends_on: ['task-z-1'], definition_of_done: ['done'], estimated_turns: 1 },
      ],
    };
    expect(invalidationClosure(byteOrderGraph, 'coder', 'task-z-1').taskIds).toEqual(['task-a-1', 'task-b-1', 'task-z-1']);
  });

  it.each([
    ['planner', ['taskGraph', 'taskArtifacts']],
    ['architect', ['architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration']],
    ['analyst', ['requirementSet', 'architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration']],
  ] as const)('uses the full graph boundary for %s', (target, invalidateArtifacts) => {
    const closure = invalidationClosure(graph, target, null);
    expect(closure.taskIds).toEqual(['task-a', 'task-b', 'task-c', 'task-d']);
    expect(closure.invalidateArtifacts).toEqual(invalidateArtifacts);
  });
});
