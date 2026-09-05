import type { ReviewVerdict } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { checkReviewVerdict, dispatchedTask } from './checks.js';
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
 * §15.6 pack: the diff · the task's requirements · decisions whose `req_ids` intersect ·
 * oracle results · the frozen test list (names and intents, not bodies). Never builds a
 * `coder-transcript` section — load-bearing per §15.6: a reviewer that shares the
 * author's context agrees with the author.
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
  const task = i.checkContext.taskGraph !== null ? dispatchedTask(i.checkContext.taskGraph) : null;
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
      section('requirement-set', "Task's requirements", JSON.stringify(scoped, null, 2)),
    );
  }
  if (task !== null && i.checkContext.architecturePlan !== null) {
    const intersecting = i.checkContext.architecturePlan.decisions.filter((d) =>
      d.req_ids.some((r) => task.req_ids.includes(r)),
    );
    if (intersecting.length > 0) {
      sections.push(section('architecture-decisions', 'Intersecting decisions', JSON.stringify(intersecting, null, 2)));
    }
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
  if (task !== null) {
    sections.push(section('task', 'Task', JSON.stringify(task, null, 2)));
  }
  if (i.raw.testConventions !== null) {
    sections.push(section('test-conventions', 'Test conventions', i.raw.testConventions));
  }
  if (i.raw.diff !== null) {
    sections.push(section('diff', 'Diff', i.raw.diff));
  }
  if (i.raw.oracleResults !== null) {
    sections.push(section('oracle-results', 'Oracle results', i.raw.oracleResults));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(section('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2)));
  }
  if (i.raw.reviewerFindings !== null) {
    sections.push(section('reviewer-findings', 'Prior reviewer findings', i.raw.reviewerFindings));
  }
  return sections;
}

export function buildTaskSection(): string {
  return 'Review the diff above against the requirement, not against the tests, and ' +
    'produce a ReviewVerdict. Refute — accept only when you looked for a blocking finding ' +
    'and failed to find one.';
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkReviewVerdict(artifact as ReviewVerdict, c);
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
