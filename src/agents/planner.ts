import type { TaskGraph } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { checkTaskGraph } from './checks.js';
import type { CheckContext } from './checks.js';
import { renderEscalationContext } from './agent.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

function section(
  kind: ContextPackSection['kind'],
  heading: string,
  body: string,
): ContextPackSection {
  return { kind, heading, body, tier: 'T1', sourceEventId: null };
}

/**
 * §15.3 pack: `RequirementSet` · `ArchitecturePlan` (decisions, components, interfaces) ·
 * file map. Never emits `prd`, `frozen-test-bodies`, `source-files`, `diff`,
 * `coder-transcript` or `reviewer-findings`.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  if (i.raw.wikiIndex !== null) {
    sections.push(section('wiki-index', 'Wiki index', i.raw.wikiIndex));
  }
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
  if (i.checkContext.requirementSet !== null) {
    sections.push(
      section('requirement-set', 'Requirement set', JSON.stringify(i.checkContext.requirementSet, null, 2)),
    );
  }
  if (i.checkContext.architecturePlan !== null) {
    const plan = i.checkContext.architecturePlan;
    sections.push(section('architecture-decisions', 'Decisions', JSON.stringify(plan.decisions, null, 2)));
    sections.push(section('architecture-components', 'Component map', JSON.stringify(plan.components, null, 2)));
    sections.push(section('architecture-interfaces', 'Interfaces', JSON.stringify(plan.interfaces, null, 2)));
  }
  if (i.raw.fileMap !== null) {
    sections.push(section('file-map', 'File map', i.raw.fileMap));
  }
  if (i.raw.testConventions !== null) {
    sections.push(section('test-conventions', 'Test conventions', i.raw.testConventions));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(section('oracle-results', 'Oracle results', i.raw.oracleResults));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(section('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2)));
  }
  if (i.raw.escalationContext !== null) {
    sections.push(section('escalation-context', 'Escalation context', renderEscalationContext('planner', i.raw.escalationContext)));
  }
  return sections;
}

export function buildTaskSection(): string {
  return 'Read the requirements and architecture above and produce a TaskGraph: ' +
    'independently completable tasks ordered by dependency only, each with an observable ' +
    'definition_of_done.';
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkTaskGraph(artifact as TaskGraph, c);
}

/** §15.3: no post-step. The mechanical checks are the strongest gate in the system. */
export function postStep(i: PostStepInput): Promise<PostStepResult> {
  return Promise.resolve({ kind: 'ok', body: i.artifact, derived: [] });
}

export const plannerModule: RoleModule = {
  role: 'planner',
  stage: 'planning',
  artifactKind: 'task-graph',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
