import type { TaskGraph } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { packSection } from '../wiki/contextpack.js';
import { checkTaskGraph } from './checks.js';
import type { CheckContext } from './checks.js';
import { renderEscalationContext } from './agent.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

/**
 * §15.3 pack: `RequirementSet` · `ArchitecturePlan` (decisions, components, interfaces) ·
 * file map. Never emits `prd`, `frozen-test-bodies`, `source-files`, `diff`,
 * `coder-transcript` or `reviewer-findings`.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  for (const wikiIndex of i.raw.wikiIndex) {
    sections.push(packSection('wiki-index', 'Wiki index', wikiIndex.body, wikiIndex.tier, wikiIndex.sourceEventId));
  }
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
  if (i.checkContext.requirementSet !== null) {
    sections.push(
      packSection(
        'requirement-set', 'Requirement set', JSON.stringify(i.checkContext.requirementSet, null, 2),
        i.raw.artifactTiers.requirementSet,
      ),
    );
  }
  if (i.checkContext.architecturePlan !== null) {
    const plan = i.checkContext.architecturePlan;
    const architectureTier = i.raw.artifactTiers.architecturePlan;
    sections.push(packSection('architecture-decisions', 'Decisions', JSON.stringify(plan.decisions, null, 2), architectureTier));
    sections.push(packSection('architecture-components', 'Component map', JSON.stringify(plan.components, null, 2), architectureTier));
    sections.push(packSection('architecture-interfaces', 'Interfaces', JSON.stringify(plan.interfaces, null, 2), architectureTier));
  }
  for (const fileMap of i.raw.fileMap) {
    sections.push(packSection('file-map', 'File map', fileMap.body, fileMap.tier, fileMap.sourceEventId));
  }
  if (i.raw.testConventions !== null) {
    sections.push(packSection('test-conventions', 'Test conventions', i.raw.testConventions, 'T1'));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(packSection('oracle-results', 'Oracle results', i.raw.oracleResults, 'T1'));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(packSection('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2), 'T2'));
  }
  if (i.raw.escalationContext !== null) {
    // §7/binding decision 13: this section's tier tracks its weakest content. The Planner's
    // escalation context embeds `current_task_reviewer_findings` — the Reviewer's own
    // agent-asserted opinion (T2 everywhere else it appears: coder.ts, reviewer.ts) — so the
    // container cannot be stamped T1 (machine-verified fact) when findings are present.
    const escalationTier = i.raw.escalationContext.currentTaskReviewerFindings !== null ? 'T2' : 'T1';
    sections.push(packSection('escalation-context', 'Escalation context', renderEscalationContext('planner', i.raw.escalationContext), escalationTier));
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
