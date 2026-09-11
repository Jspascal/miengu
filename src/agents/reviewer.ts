import type { ReviewVerdict } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { packSection } from '../wiki/contextpack.js';
import { checkReviewVerdict } from './checks.js';
import type { CheckContext } from './checks.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

/**
 * §15.6 pack: the diff · the task's requirements · decisions whose `req_ids` intersect ·
 * oracle results · the frozen test list (names and intents, not bodies). Never builds a
 * `coder-transcript` section — load-bearing per §15.6: a reviewer that shares the
 * author's context agrees with the author.
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
  addBrownfieldSections(sections, i);
  const task = i.task;
  if (i.checkContext.requirementSet !== null) {
    // §15.6 scopes this to the task's own `req_ids`. It previously shipped the FULL
    // RequirementSet under the heading "Task's requirements", which both mislabels the
    // content and hands the Reviewer requirements no part of this diff was meant to satisfy —
    // inviting `requirement-miss` findings against work that was never in scope.
    const scoped =
      task === null
        ? i.checkContext.requirementSet
        : {
            ...i.checkContext.requirementSet,
            requirements: i.checkContext.requirementSet.requirements.filter((r) =>
              task.req_ids.includes(r.req_id),
            ),
          };
    sections.push(
      packSection('requirement-set', "Task's requirements", JSON.stringify(scoped, null, 2), i.raw.artifactTiers.requirementSet),
    );
  }
  if (task !== null && i.checkContext.architecturePlan !== null) {
    const intersecting = i.checkContext.architecturePlan.decisions.filter((d) =>
      d.req_ids.some((r) => task.req_ids.includes(r)),
    );
    if (intersecting.length > 0) {
      sections.push(packSection('architecture-decisions', 'Intersecting decisions', JSON.stringify(intersecting, null, 2), i.raw.artifactTiers.architecturePlan));
    }
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
  if (task !== null) {
    sections.push(packSection('task', 'Task', JSON.stringify(task, null, 2), i.raw.artifactTiers.taskGraph));
  }
  if (i.raw.testConventions !== null) {
    sections.push(packSection('test-conventions', 'Test conventions', i.raw.testConventions, 'T1'));
  }
  if (i.raw.diff !== null) {
    sections.push(packSection('diff', 'Diff', i.raw.diff, 'T1'));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(packSection('oracle-results', 'Oracle results', i.raw.oracleResults, 'T1'));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(packSection('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2), 'T2'));
  }
  if (i.raw.currentTaskReviewerFindings !== null) {
    sections.push(packSection('current-task-reviewer-findings', 'Current task reviewer findings', i.raw.currentTaskReviewerFindings, 'T2'));
  }
  return sections;
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

export function buildTaskSection(): string {
  return 'Review the diff above against the requirement, not against the tests, and ' +
    'produce a ReviewVerdict. Refute — accept only when you looked for a blocking finding ' +
    'and failed to find one.';
}

export function validate(artifact: unknown, c: CheckContext, pack: PackBuildInput): readonly string[] {
  return checkReviewVerdict(artifact as ReviewVerdict, c, pack.task, pack.activeT1OracleFailure, pack.activeCauseLevel);
}

/** §15.6: no post-step — the verdict is recorded, never acted on (binding decision 2). */
export function postStep(i: PostStepInput): Promise<PostStepResult> {
  return Promise.resolve({ kind: 'ok', body: i.artifact, derived: [] });
}

export const reviewerModule: RoleModule = {
  role: 'reviewer',
  stage: 'review',
  artifactKind: 'review-verdict',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
