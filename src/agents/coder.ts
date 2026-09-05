import type { Implementation } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { restoreFrozenTests, verifyFrozenTests } from '../supervisor/freeze.js';
import { checkImplementation, dispatchedTask } from './checks.js';
import type { CheckContext } from './checks.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

function section(
  kind: ContextPackSection['kind'],
  heading: string,
  body: string,
): ContextPackSection {
  return { kind, heading, body, tier: 'T1', sourceEventId: null };
}

/**
 * §15.5 pack: exactly one `Task` · files under its `expected_paths` plus their direct
 * dependencies · the frozen tests matching its `req_ids` · the `interfaces` it implements
 * · only those decisions whose `req_ids` intersect the task's. Never emits `prd`,
 * `wiki-index`, `requirement-set`, `task-graph`, `coder-transcript` or `reviewer-findings`.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  const task = i.checkContext.taskGraph !== null ? dispatchedTask(i.checkContext.taskGraph) : null;

  if (i.raw.existingReqIds.length > 0) {
    sections.push(
      section('existing-req-ids', 'Existing requirement ids', i.raw.existingReqIds.join('\n')),
    );
  }
  if (i.raw.priorOutOfScope.length > 0) {
    sections.push(
      section('prior-out-of-scope', 'Previously recorded out of scope', i.raw.priorOutOfScope.join('\n')),
    );
  }
  if (i.raw.stackFacts !== null) {
    sections.push(section('stack-facts', 'Stack facts', i.raw.stackFacts));
  }
  if (i.raw.systemSkeleton !== null) {
    sections.push(section('system-skeleton', 'System skeleton', i.raw.systemSkeleton));
  }

  if (task !== null && i.checkContext.architecturePlan !== null) {
    const plan = i.checkContext.architecturePlan;
    const intersectingDecisions = plan.decisions.filter((d) => d.req_ids.some((r) => task.req_ids.includes(r)));
    if (intersectingDecisions.length > 0) {
      sections.push(
        section('architecture-decisions', 'Decisions intersecting this task', JSON.stringify(intersectingDecisions, null, 2)),
      );
    }
    const componentIds = new Set(task.component_ids);
    const components = plan.components.filter((c) => componentIds.has(c.component_id));
    if (components.length > 0) {
      sections.push(section('architecture-components', 'Task components', JSON.stringify(components, null, 2)));
    }
    const interfaces = plan.interfaces.filter((iface) => componentIds.has(iface.component_id));
    if (interfaces.length > 0) {
      sections.push(section('architecture-interfaces', 'Interfaces this task implements', JSON.stringify(interfaces, null, 2)));
    }
  }

  if (task !== null) {
    sections.push(section('file-map', 'expected_paths', task.expected_paths.join('\n')));
    sections.push(section('task', 'Task', JSON.stringify(task, null, 2)));
  }

  if (i.raw.testConventions !== null) {
    sections.push(section('test-conventions', 'Test conventions', i.raw.testConventions));
  }
  if (i.raw.frozenTestList.length > 0) {
    sections.push(
      section(
        'frozen-test-list',
        'Frozen test list (names and intents only)',
        i.raw.frozenTestList.map((t) => `${t.testId}: ${t.intent}`).join('\n'),
      ),
    );
  }
  if (task !== null && i.raw.frozenTestBodies.length > 0) {
    // The bodies matching the task's req_ids only — the caller is responsible for having
    // already filtered `raw.frozenTestBodies` to this task's paths; buildCandidates never
    // widens what it was given.
    sections.push(
      section(
        'frozen-test-bodies',
        'Frozen tests for this task',
        i.raw.frozenTestBodies.map((f) => `--- ${f.path} ---\n${f.body}`).join('\n\n'),
      ),
    );
  }
  const relevantSourceFiles = task !== null
    ? i.raw.sourceFiles.filter((f) => task.expected_paths.some((p) => f.path.startsWith(p)))
    : i.raw.sourceFiles;
  if (relevantSourceFiles.length > 0) {
    sections.push(
      section('source-files', 'Source files', relevantSourceFiles.map((f) => `--- ${f.path} ---\n${f.body}`).join('\n\n')),
    );
  }
  if (i.raw.diff !== null) {
    sections.push(section('diff', 'Prior diff', i.raw.diff));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(section('oracle-results', 'Oracle results', i.raw.oracleResults));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(section('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2)));
  }
  return sections;
}

export function buildTaskSection(i: PackBuildInput): string {
  const task = i.checkContext.taskGraph !== null ? dispatchedTask(i.checkContext.taskGraph) : null;
  if (task === null) {
    throw new Error('coder.buildTaskSection: no dispatched task (empty or cyclic TaskGraph)');
  }
  return (
    `Implement task '${task.task_id}': ${task.title}\n\n` +
    `Satisfy the frozen tests for this task. definition_of_done:\n` +
    task.definition_of_done.map((d) => `- ${d}`).join('\n')
  );
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkImplementation(artifact as Implementation, c);
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
