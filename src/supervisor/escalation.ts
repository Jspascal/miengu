import { ESCALATION_LEVELS } from '../core/events.js';
import type {
  EscalationLevel,
  FailureAttemptBucket,
  FailureKind,
  InvalidationTarget,
} from '../core/events.js';
import type { ComponentId, ReqId, TaskId } from '../core/ids.js';
import type { TaskGraph } from '../contracts/taskGraph.js';
import type { AttemptLimits } from './nextStage.js';

export const ESCALATION_RANK: Readonly<Record<EscalationLevel, number>> = {
  coder: 0,
  reviewer: 1,
  planner: 2,
  architect: 3,
  analyst: 4,
  human: 5,
};

export interface FailureClassification {
  readonly bucket: FailureAttemptBucket;
  readonly initialLevel: EscalationLevel;
  readonly invalidationTarget: InvalidationTarget | null;
}

export interface InvalidationClosure {
  readonly taskIds: readonly TaskId[];
  readonly reqIds: readonly ReqId[];
  readonly componentIds: readonly ComponentId[];
  readonly invalidateArtifacts: readonly (
    | 'requirementSet'
    | 'architecturePlan'
    | 'taskGraph'
    | 'testSuiteSpec'
    | 'taskArtifacts'
    | 'integration'
  )[];
}

export function escalationRank(level: EscalationLevel): number {
  return ESCALATION_RANK[level];
}

export function bucketLimit(bucket: FailureAttemptBucket, limits: AttemptLimits): number {
  switch (bucket) {
    case 'oracle':
      return limits.kOracle;
    case 'test':
      return limits.kTest;
    case 'review':
      return limits.kReview;
    case 'reviewer':
    case 'planner':
    case 'architect':
    case 'analyst':
      return limits.maxAttemptsPerStage;
  }
}

/** Maps durable failure facts to the ladder bucket and its first eligible handler. */
export function classifyFailure(kind: FailureKind): FailureClassification {
  switch (kind) {
    case 'oracle':
      return { bucket: 'oracle', initialLevel: 'coder', invalidationTarget: 'coder' };
    case 'test':
      return { bucket: 'test', initialLevel: 'coder', invalidationTarget: 'coder' };
    case 'review-revision':
      return { bucket: 'review', initialLevel: 'coder', invalidationTarget: 'coder' };
    case 'agent-output':
      return { bucket: 'reviewer', initialLevel: 'reviewer', invalidationTarget: null };
    case 'sandbox':
    case 'task-design':
      return { bucket: 'planner', initialLevel: 'planner', invalidationTarget: 'planner' };
    case 'architecture':
      return { bucket: 'architect', initialLevel: 'architect', invalidationTarget: 'architect' };
    case 'requirements':
      return { bucket: 'analyst', initialLevel: 'analyst', invalidationTarget: 'analyst' };
    case 'integration':
      return { bucket: 'planner', initialLevel: 'planner', invalidationTarget: 'planner' };
  }
}

/** `null` is the human terminal: no lower or wrapped level exists. */
export function nextEscalationLevel(level: EscalationLevel): EscalationLevel | null {
  const next = ESCALATION_LEVELS[escalationRank(level) + 1];
  return next ?? null;
}

/**
 * Kahn topological sort with a bytewise ascending task-id tie-break.  The resulting order is
 * persisted in TaskGraphActivated, so it must never depend on the planner's declaration order
 * or on locale-sensitive comparison rules.
 */
export function deterministicTaskOrder(
  tasks: readonly { readonly task_id: TaskId; readonly depends_on: readonly TaskId[] }[],
): readonly TaskId[] {
  const byId = new Map(tasks.map((task) => [task.task_id, task] as const));
  if (byId.size !== tasks.length) {
    throw new Error('task graph contains duplicate task ids');
  }
  const remaining = new Map<TaskId, Set<TaskId>>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const task of tasks) {
    const dependencies = new Set(task.depends_on);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`task "${task.task_id}" depends on unknown task "${dependency}"`);
      }
      const entries = dependents.get(dependency) ?? [];
      entries.push(task.task_id);
      dependents.set(dependency, entries);
    }
    remaining.set(task.task_id, dependencies);
  }
  const compareTaskId = (a: TaskId, b: TaskId): number => a < b ? -1 : a > b ? 1 : 0;
  const ready = [...remaining.entries()]
    .filter(([, dependencies]) => dependencies.size === 0)
    .map(([taskId]) => taskId)
    .sort(compareTaskId);
  const ordered: TaskId[] = [];
  while (ready.length > 0) {
    const taskId = ready.shift();
    if (taskId === undefined) break;
    ordered.push(taskId);
    for (const dependent of dependents.get(taskId) ?? []) {
      const dependencies = remaining.get(dependent);
      if (dependencies === undefined) continue;
      dependencies.delete(taskId);
      if (dependencies.size === 0) {
        ready.push(dependent);
      }
    }
    ready.sort(compareTaskId);
  }
  if (ordered.length !== tasks.length) {
    throw new Error('task graph contains a dependency cycle');
  }
  return ordered;
}

function sorted<T extends string>(values: Iterable<T>): readonly T[] {
  return [...new Set(values)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Computes the conservative invalidation boundary without consulting state or a worktree.
 * For a coder revision, only the selected task and its transitive dependents are invalidated;
 * higher-level targets deliberately cover the whole graph.
 */
export function invalidationClosure(
  graph: TaskGraph,
  target: InvalidationTarget,
  taskId: TaskId | null,
): InvalidationClosure {
  const byId = new Map(graph.tasks.map((task) => [task.task_id, task] as const));
  let taskIds: readonly TaskId[];
  let invalidateArtifacts: InvalidationClosure['invalidateArtifacts'];

  if (target === 'coder') {
    if (taskId === null || !byId.has(taskId)) {
      taskIds = [];
    } else {
      const dependents = new Map<TaskId, TaskId[]>();
      for (const task of graph.tasks) {
        for (const dependency of task.depends_on) {
          const entries = dependents.get(dependency) ?? [];
          entries.push(task.task_id);
          dependents.set(dependency, entries);
        }
      }
      const closure = new Set<TaskId>([taskId]);
      const pending = [taskId];
      while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) continue;
        for (const dependent of dependents.get(current) ?? []) {
          if (!closure.has(dependent)) {
            closure.add(dependent);
            pending.push(dependent);
          }
        }
      }
      taskIds = sorted(closure);
    }
    invalidateArtifacts = ['taskArtifacts'];
  } else {
    taskIds = sorted(byId.keys());
    invalidateArtifacts =
      target === 'planner'
        ? ['taskGraph', 'taskArtifacts']
        : target === 'architect'
          ? ['architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration']
          : ['requirementSet', 'architecturePlan', 'taskGraph', 'testSuiteSpec', 'taskArtifacts', 'integration'];
  }

  const affected = taskIds.map((id) => byId.get(id)).filter((task): task is NonNullable<typeof task> => task !== undefined);
  return {
    taskIds,
    reqIds: sorted(affected.flatMap((task) => task.req_ids)),
    componentIds: sorted(affected.flatMap((task) => task.component_ids)),
    invalidateArtifacts,
  };
}
