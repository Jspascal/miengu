import type { Implementation, TaskGraph } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { packSection } from '../wiki/contextpack.js';
import { restoreFrozenTests, verifyFrozenTests } from '../supervisor/freeze.js';
import { checkImplementation } from './checks.js';
import type { CheckContext } from './checks.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

/**
 * §15.5 pack: exactly one `Task` · files under its `expected_paths` plus their direct
 * dependencies · the frozen tests matching its `req_ids` · the `interfaces` it implements
 * · only those decisions whose `req_ids` intersect the task's. Never emits `prd`,
 * `wiki-index`, `requirement-set`, `task-graph`, `coder-transcript`, other-task findings, or
 * escalation context.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  const task = i.task;

  if (i.raw.existingReqIds.length > 0) {
    sections.push(
      packSection(
        'existing-req-ids', 'Existing requirement ids', i.raw.existingReqIds.join('\n'),
        i.raw.artifactTiers.requirementSet,
      ),
    );
  }
  if (i.raw.priorOutOfScope.length > 0) {
    sections.push(
      packSection(
        'prior-out-of-scope', 'Previously recorded out of scope', i.raw.priorOutOfScope.join('\n'),
        i.raw.artifactTiers.requirementSet,
      ),
    );
  }
  for (const stackFacts of i.raw.stackFacts) {
    sections.push(packSection('stack-facts', 'Stack facts', stackFacts.body, stackFacts.tier, stackFacts.sourceEventId));
  }
  for (const systemSkeleton of i.raw.systemSkeleton) {
    sections.push(packSection('system-skeleton', 'System skeleton', systemSkeleton.body, systemSkeleton.tier, systemSkeleton.sourceEventId));
  }
  addBrownfieldSections(sections, i);

  if (task !== null && i.checkContext.architecturePlan !== null) {
    const plan = i.checkContext.architecturePlan;
    const architectureTier = i.raw.artifactTiers.architecturePlan;
    const intersectingDecisions = plan.decisions.filter((d) => d.req_ids.some((r) => task.req_ids.includes(r)));
    if (intersectingDecisions.length > 0) {
      sections.push(
        packSection('architecture-decisions', 'Decisions intersecting this task', JSON.stringify(intersectingDecisions, null, 2), architectureTier),
      );
    }
    const componentIds = new Set(task.component_ids);
    const components = plan.components.filter((c) => componentIds.has(c.component_id));
    if (components.length > 0) {
      sections.push(packSection('architecture-components', 'Task components', JSON.stringify(components, null, 2), architectureTier));
    }
    const interfaces = plan.interfaces.filter((iface) => componentIds.has(iface.component_id));
    if (interfaces.length > 0) {
      sections.push(packSection('architecture-interfaces', 'Interfaces this task implements', JSON.stringify(interfaces, null, 2), architectureTier));
    }
  }

  if (task !== null) {
    sections.push(packSection('file-map', 'expected_paths', task.expected_paths.join('\n'), i.raw.artifactTiers.taskGraph));
    sections.push(packSection('task', 'Task', JSON.stringify(task, null, 2), i.raw.artifactTiers.taskGraph));
  }

  if (i.raw.testConventions !== null) {
    sections.push(packSection('test-conventions', 'Test conventions', i.raw.testConventions, 'T1'));
  }
  if (i.raw.frozenTestList.length > 0) {
    sections.push(
      packSection(
        'frozen-test-list',
        'Frozen test list (names and intents only)',
        i.raw.frozenTestList.map((t) => `${t.testId}: ${t.intent}`).join('\n'),
        'T1',
      ),
    );
  }
  if (task !== null && i.raw.frozenTestBodies.length > 0) {
    // The bodies matching the task's req_ids only — the caller is responsible for having
    // already filtered `raw.frozenTestBodies` to this task's paths; buildCandidates never
    // widens what it was given.
    sections.push(
      packSection(
        'frozen-test-bodies',
        'Frozen tests for this task',
        i.raw.frozenTestBodies.map((f) => `--- ${f.path} ---\n${f.body}`).join('\n\n'),
        'T1',
      ),
    );
  }
  const relevantSourceFiles = task !== null
    ? i.raw.sourceFiles.filter((f) => sourceFileBelongsToTask(f.path, task, i.checkContext.taskGraph))
    : i.raw.sourceFiles;
  if (relevantSourceFiles.length > 0) {
    sections.push(
      packSection('source-files', 'Source files', relevantSourceFiles.map((f) => `--- ${f.path} ---\n${f.body}`).join('\n\n'), 'T1'),
    );
  }
  if (i.raw.diff !== null) {
    sections.push(packSection('diff', 'Prior diff', i.raw.diff, 'T1'));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(packSection('oracle-results', 'Oracle results', i.raw.oracleResults, 'T1'));
  }
  if (i.raw.currentTaskReviewerFindings !== null) {
    sections.push(packSection('current-task-reviewer-findings', 'Current task reviewer findings', i.raw.currentTaskReviewerFindings, 'T2'));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(packSection('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2), 'T2'));
  }
  return sections;
}

/**
 * §15.5 / decision 20: `raw.sourceFiles` is the Coder-only body channel and is already the
 * neighborhood-scoped set the caller selected for this task (frozen-test bodies and
 * brownfield tests-as-spec excerpts, the latter carried at their observed pre-existing
 * paths). Prefixing that filter with the task's `expected_paths` — its *new* output paths —
 * silently drops every brownfield excerpt, since an observed path like `test/foo.test.ts`
 * never shares a prefix with a task's output. Relevance rule instead: a file under this
 * task's own `expected_paths` is always kept; a file under a *sibling* task's
 * `expected_paths` is withheld (that is the leakage the prefix filter guarded against); a
 * file under neither is pre-existing context upstream already tied to this task, so it is
 * kept.
 */
function sourceFileBelongsToTask(
  path: string,
  task: NonNullable<PackBuildInput['task']>,
  taskGraph: TaskGraph | null,
): boolean {
  if (task.expected_paths.some((p) => path.startsWith(p))) {
    return true;
  }
  const siblingPaths = (taskGraph?.tasks ?? [])
    .filter((t) => t.task_id !== task.task_id)
    .flatMap((t) => t.expected_paths);
  return !siblingPaths.some((p) => path.startsWith(p));
}

function addBrownfieldSections(sections: ContextPackSection[], i: PackBuildInput): void {
  for (const history of i.raw.brownfieldHistory ?? []) {
    sections.push(packSection('brownfield-history', 'Brownfield history', history.body, history.tier, history.sourceEventId));
  }
  for (const falsification of i.raw.brownfieldFalsification ?? []) {
    sections.push(packSection('brownfield-falsification', 'Brownfield falsification', falsification.body, falsification.tier, falsification.sourceEventId));
  }
  for (const drift of i.raw.brownfieldDrift ?? []) {
    sections.push(packSection('brownfield-drift', 'Touched brownfield drift', drift.body, drift.tier, drift.sourceEventId));
  }
}

export function buildTaskSection(i: PackBuildInput): string {
  const task = i.task;
  if (task === null) {
    throw new Error('coder.buildTaskSection: no dispatched task (empty or cyclic TaskGraph)');
  }
  return (
    `Implement task '${task.task_id}': ${task.title}\n\n` +
    `Satisfy the frozen tests for this task. definition_of_done:\n` +
    task.definition_of_done.map((d) => `- ${d}`).join('\n')
  );
}

export function validate(artifact: unknown, c: CheckContext, pack: PackBuildInput): readonly string[] {
  return checkImplementation(artifact as Implementation, c, pack.task);
}

/**
 * §15.5 post-step: re-hash the frozen test files. Any change -> `TestsTampered`, restore
 * from the frozen copy, reject the implementation, return the task to the Coder. Oracles
 * are Phase 3 and are not run here.
 */
export async function postStep(i: PostStepInput): Promise<PostStepResult> {
  const artifact = i.artifact as Implementation;

  if (i.frozenTests === null) {
    return { kind: 'ok', body: artifact, derived: [] };
  }

  const verdict = await verifyFrozenTests({ workdir: i.workdir, frozen: i.frozenTests });
  if (verdict.kind === 'intact') {
    return { kind: 'ok', body: artifact, derived: [] };
  }

  await restoreFrozenTests({ workdir: i.workdir, frozen: i.frozenTests });

  const derived: PostStepResult['derived'] = [
    {
      type: 'TestsTampered',
      data: {
        task_id: artifact.task_id,
        suite_id: i.frozenTests.suiteId,
        expected_hash: i.frozenTests.contentHash,
        observed_hash: verdict.observedHash,
        paths: verdict.paths,
        restored: true,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    },
  ];

  return {
    kind: 'failed',
    reason: 'tests-tampered',
    detail: `frozen test file(s) changed: ${verdict.paths.join(', ')}`,
    derived,
  };
}

export const coderModule: RoleModule = {
  role: 'coder',
  stage: 'implementation',
  artifactKind: 'implementation',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
