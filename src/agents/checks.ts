import type {
  ArchitecturePlan,
  Implementation,
  RequirementSet,
  ReviewVerdict,
  TaskGraph,
  TestSuiteSpecDraft,
} from '../contracts/index.js';
import { parseSerial } from '../core/ids.js';
import type { ComponentId, DecisionId, ReqId, TaskId } from '../core/ids.js';

export interface CheckContext {
  readonly requirementSet: RequirementSet | null;
  readonly architecturePlan: ArchitecturePlan | null;
  readonly taskGraph: TaskGraph | null;
  readonly maxPathsPerTask: number; // from config.planner — no literal in code
  readonly testDirs: readonly string[]; // from detected conventions
}

/** All `priority: 'must'` requirements' `req_id`s, in declared order. */
export function mustRequirements(r: RequirementSet): readonly ReqId[] {
  return r.requirements.filter((req) => req.priority === 'must').map((req) => req.req_id);
}

/**
 * Binding decision 6: the first task in `topoOrder` — the one the Coder is dispatched on
 * and the Reviewer reviews. `null` when the graph is cyclic (no valid order) or empty.
 */
export function dispatchedTask(g: TaskGraph): TaskGraph['tasks'][number] | null {
  const order = topoOrder(g);
  if (order === null || order.length === 0) {
    return null;
  }
  const firstId = order[0];
  return g.tasks.find((t) => t.task_id === firstId) ?? null;
}

/** Kahn's algorithm, ties broken by ascending `task_id`. `null` when the graph is cyclic. */
export function topoOrder(g: TaskGraph): readonly TaskId[] | null {
  const ids = g.tasks.map((t) => t.task_id);
  const idSet = new Set<TaskId>(ids);
  const remaining = new Map<TaskId, number>();
  const dependents = new Map<TaskId, TaskId[]>();
  for (const id of ids) {
    remaining.set(id, 0);
    dependents.set(id, []);
  }
  for (const task of g.tasks) {
    for (const dep of task.depends_on) {
      if (!idSet.has(dep)) {
        continue; // a dependency on a non-existent task is reported by a separate check
      }
      remaining.set(task.task_id, (remaining.get(task.task_id) ?? 0) + 1);
      dependents.get(dep)?.push(task.task_id);
    }
  }

  const order: TaskId[] = [];
  const available = new Set<TaskId>(ids.filter((id) => remaining.get(id) === 0));
  while (available.size > 0) {
    const next = [...available].sort()[0] as TaskId;
    available.delete(next);
    order.push(next);
    for (const dependent of dependents.get(next) ?? []) {
      const updated = (remaining.get(dependent) ?? 0) - 1;
      remaining.set(dependent, updated);
      if (updated === 0) {
        available.add(dependent);
      }
    }
  }

  return order.length === ids.length ? order : null;
}

/** Every task reachable from a zero-`depends_on` root by walking forward through the
 *  "is a dependency of" edges. For a well-formed acyclic graph this always holds; kept as
 *  an independent, separately named check per §15.3/§3.19 rather than folded into
 *  `topoOrder`, so a cyclic fixture reports both failures under their own messages. */
function unreachableTaskIds(g: TaskGraph): readonly TaskId[] {
  const ids = g.tasks.map((t) => t.task_id);
  const idSet = new Set<TaskId>(ids);
  const dependents = new Map<TaskId, TaskId[]>();
  for (const id of ids) {
    dependents.set(id, []);
  }
  for (const task of g.tasks) {
    for (const dep of task.depends_on) {
      if (idSet.has(dep)) {
        dependents.get(dep)?.push(task.task_id);
      }
    }
  }
  const roots = g.tasks.filter((t) => t.depends_on.length === 0).map((t) => t.task_id);
  const visited = new Set<TaskId>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    for (const dependent of dependents.get(current) ?? []) {
      if (!visited.has(dependent)) {
        visited.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return ids.filter((id) => !visited.has(id));
}

export function checkRequirementSet(a: RequirementSet, c: CheckContext): readonly string[] {
  void c; // CheckContext is unused here — the Analyst's checks are entirely self-contained.
  const failures: string[] = [];

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const req of a.requirements) {
    if (seen.has(req.req_id)) {
      duplicates.add(req.req_id);
    }
    seen.add(req.req_id);
  }
  if (duplicates.size > 0) {
    failures.push(`req_id is not unique: ${[...duplicates].sort().join(', ')}`);
  }

  const numbers = a.requirements
    .map((req) => {
      try {
        return parseSerial(req.req_id).n;
      } catch {
        return null;
      }
    })
    .filter((n): n is number => n !== null)
    .sort((x, y) => x - y);
  const expected = numbers.map((_, index) => index + 1);
  if (JSON.stringify(numbers) !== JSON.stringify(expected)) {
    failures.push('req_id numbering is not monotonic from 1 with no gaps');
  }

  for (const req of a.requirements) {
    if (req.acceptance.length < 1) {
      failures.push(`requirement '${req.req_id}' has no acceptance entries`);
    }
  }

  const reqIds = new Set(a.requirements.map((req) => req.req_id));
  for (const ambiguity of a.ambiguities) {
    for (const affected of ambiguity.affects) {
      if (!reqIds.has(affected)) {
        failures.push(
          `ambiguity ${JSON.stringify(ambiguity.question)} affects unresolved req_id '${affected}'`,
        );
      }
    }
    if (ambiguity.options.length < 2) {
      failures.push(`ambiguity ${JSON.stringify(ambiguity.question)} has fewer than 2 options`);
    }
  }

  return failures;
}

export function checkArchitecturePlan(a: ArchitecturePlan, c: CheckContext): readonly string[] {
  const failures: string[] = [];

  const seenDecisionIds = new Set<string>();
  const duplicateDecisionIds = new Set<string>();
  for (const decision of a.decisions) {
    if (seenDecisionIds.has(decision.decision_id)) {
      duplicateDecisionIds.add(decision.decision_id);
    }
    seenDecisionIds.add(decision.decision_id);
  }
  if (duplicateDecisionIds.size > 0) {
    failures.push(`decision_id is not unique: ${[...duplicateDecisionIds].sort().join(', ')}`);
  }

  const priorDecisionIds = new Set<DecisionId>();
  for (const decision of a.decisions) {
    if (decision.supersedes !== null && !priorDecisionIds.has(decision.supersedes)) {
      failures.push(
        `decision '${decision.decision_id}' supersedes '${decision.supersedes}', which is not a prior decision`,
      );
    }
    priorDecisionIds.add(decision.decision_id);
  }

  const reqIds = c.requirementSet === null ? null : new Set(c.requirementSet.requirements.map((r) => r.req_id));
  if (reqIds !== null) {
    for (const decision of a.decisions) {
      for (const reqId of decision.req_ids) {
        if (!reqIds.has(reqId)) {
          failures.push(`decision '${decision.decision_id}' references unresolved req_id '${reqId}'`);
        }
      }
    }
    for (const iface of a.interfaces) {
      for (const reqId of iface.req_ids) {
        if (!reqIds.has(reqId)) {
          failures.push(`interface '${iface.interface_id}' references unresolved req_id '${reqId}'`);
        }
      }
    }
  }

  if (c.requirementSet !== null) {
    const must = new Set(mustRequirements(c.requirementSet));
    const touched = new Set<ReqId>();
    for (const decision of a.decisions) {
      for (const reqId of decision.req_ids) {
        touched.add(reqId);
      }
    }
    for (const iface of a.interfaces) {
      for (const reqId of iface.req_ids) {
        touched.add(reqId);
      }
    }
    for (const reqId of must) {
      if (!touched.has(reqId)) {
        failures.push(`must requirement '${reqId}' is not touched by any decision or interface`);
      }
    }
  }

  for (const decision of a.decisions) {
    if (decision.alternatives.length < 1) {
      failures.push(`decision '${decision.decision_id}' has no alternatives`);
    }
  }

  const componentIds = new Set(a.components.map((component) => component.component_id));
  for (const iface of a.interfaces) {
    if (!componentIds.has(iface.component_id)) {
      failures.push(
        `interface '${iface.interface_id}' references unresolved component_id '${iface.component_id}'`,
      );
    }
  }

  return failures;
}

export function checkTaskGraph(a: TaskGraph, c: CheckContext): readonly string[] {
  const failures: string[] = [];

  const seenTaskIds = new Set<string>();
  const duplicateTaskIds = new Set<string>();
  for (const task of a.tasks) {
    if (seenTaskIds.has(task.task_id)) {
      duplicateTaskIds.add(task.task_id);
    }
    seenTaskIds.add(task.task_id);
  }
  if (duplicateTaskIds.size > 0) {
    failures.push(`task_id is not unique: ${[...duplicateTaskIds].sort().join(', ')}`);
  }

  const order = topoOrder(a);
  if (order === null) {
    failures.push('task graph contains a cycle');
  }

  if (c.requirementSet !== null) {
    const must = new Set(mustRequirements(c.requirementSet));
    const covered = new Set<ReqId>();
    for (const task of a.tasks) {
      for (const reqId of task.req_ids) {
        covered.add(reqId);
      }
    }
    for (const reqId of must) {
      if (!covered.has(reqId)) {
        failures.push(`must requirement '${reqId}' is not covered by any task`);
      }
    }

    const reqIds = new Set(c.requirementSet.requirements.map((r) => r.req_id));
    for (const task of a.tasks) {
      for (const reqId of task.req_ids) {
        if (!reqIds.has(reqId)) {
          failures.push(`task '${task.task_id}' references unresolved req_id '${reqId}'`);
        }
      }
    }
  }

  for (const task of a.tasks) {
    if (task.expected_paths.length > c.maxPathsPerTask) {
      failures.push(
        `task '${task.task_id}' has ${task.expected_paths.length} expected_paths, ` +
          `exceeding maxPathsPerTask (${c.maxPathsPerTask})`,
      );
    }
  }

  if (c.architecturePlan !== null) {
    const componentIds = new Set<ComponentId>(
      c.architecturePlan.components.map((component) => component.component_id),
    );
    for (const task of a.tasks) {
      for (const componentId of task.component_ids) {
        if (!componentIds.has(componentId)) {
          failures.push(`task '${task.task_id}' references unresolved component_id '${componentId}'`);
        }
      }
    }
  }

  const taskIds = new Set(a.tasks.map((task) => task.task_id));
  for (const task of a.tasks) {
    if (task.depends_on.includes(task.task_id)) {
      failures.push(`task '${task.task_id}' depends on itself`);
    }
    for (const dep of task.depends_on) {
      if (!taskIds.has(dep)) {
        failures.push(`task '${task.task_id}' depends on non-existent task '${dep}'`);
      }
    }
  }

  const unreachable = unreachableTaskIds(a);
  for (const taskId of unreachable) {
    failures.push(`task '${taskId}' is unreachable from any zero-dependency root`);
  }

  return failures;
}

export function checkTestSuiteSpec(a: TestSuiteSpecDraft, c: CheckContext): readonly string[] {
  const failures: string[] = [];

  if (!a.cases.some((test) => test.negative)) {
    failures.push('no test case has negative: true');
  }
  if (!a.cases.some((test) => test.asserts_output)) {
    failures.push('no test case has asserts_output: true');
  }

  if (c.requirementSet !== null) {
    const must = new Set(mustRequirements(c.requirementSet));
    const covered = new Set<ReqId>();
    for (const test of a.cases) {
      for (const reqId of test.req_ids) {
        covered.add(reqId);
      }
    }
    for (const reqId of must) {
      if (!covered.has(reqId)) {
        failures.push(`must requirement '${reqId}' is not covered by any test case`);
      }
    }

    const reqIds = new Set(c.requirementSet.requirements.map((r) => r.req_id));
    for (const test of a.cases) {
      for (const reqId of test.req_ids) {
        if (!reqIds.has(reqId)) {
          failures.push(`test '${test.test_id}' references unresolved req_id '${reqId}'`);
        }
      }
    }
  }

  for (const test of a.cases) {
    const insideTestDir = c.testDirs.some((dir) => test.path.startsWith(dir));
    if (!insideTestDir) {
      failures.push(`test '${test.test_id}' path '${test.path}' is outside the target's test directories`);
    }
  }

  const seenTestIds = new Set<string>();
  const duplicateTestIds = new Set<string>();
  for (const test of a.cases) {
    if (seenTestIds.has(test.test_id)) {
      duplicateTestIds.add(test.test_id);
    }
    seenTestIds.add(test.test_id);
  }
  if (duplicateTestIds.size > 0) {
    failures.push(`test_id is not unique: ${[...duplicateTestIds].sort().join(', ')}`);
  }

  return failures;
}

export function checkImplementation(a: Implementation, c: CheckContext): readonly string[] {
  const failures: string[] = [];

  if (c.taskGraph !== null) {
    const taskIds = new Set(c.taskGraph.tasks.map((task) => task.task_id));
    if (!taskIds.has(a.task_id)) {
      failures.push(`task_id '${a.task_id}' does not match the dispatched task`);
    }
  }

  if (c.architecturePlan !== null) {
    const decisionIds = new Set(c.architecturePlan.decisions.map((decision) => decision.decision_id));
    for (const deviation of a.deviations) {
      if (!decisionIds.has(deviation.from_decision_id)) {
        failures.push(
          `deviation references unresolved from_decision_id '${deviation.from_decision_id}'`,
        );
      }
    }
  }

  // §3.19 also lists "every assumption_ids[] entry was actually recorded", which needs the
  // set of `AssumptionRecorded` events for this item — data `CheckContext` does not carry.
  // `assumption_ids` is already `AssumptionId`-branded (format-checked) by the schema; there
  // is nothing further this pure, context-limited check can verify.

  if (a.files_touched.length < 1) {
    failures.push('files_touched is empty');
  }

  return failures;
}

export function checkReviewVerdict(a: ReviewVerdict, c: CheckContext): readonly string[] {
  const failures: string[] = [];

  const escalating = a.verdict === 'escalate';
  if (escalating !== (a.escalate_to !== null)) {
    failures.push("escalate_to must be non-null iff verdict === 'escalate'");
  }

  if (c.taskGraph !== null) {
    const taskIds = new Set(c.taskGraph.tasks.map((task) => task.task_id));
    if (!taskIds.has(a.task_id)) {
      failures.push(`task_id '${a.task_id}' does not match the reviewed task`);
    }
  }

  if (a.verdict === 'accept' && a.findings.some((finding) => finding.severity === 'blocking')) {
    failures.push("verdict: 'accept' with a blocking finding is incoherent");
  }

  return failures;
}
