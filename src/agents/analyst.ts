import { formatAssumptionId } from '../core/ids.js';
import { sha256Canonical } from '../core/hash.js';
import type { RequirementSet } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { checkRequirementSet } from './checks.js';
import type { CheckContext } from './checks.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';
import type { AppendInput } from '../core/log.js';

function section(
  kind: ContextPackSection['kind'],
  heading: string,
  body: string,
): ContextPackSection {
  return { kind, heading, body, tier: 'T1', sourceEventId: null };
}

/**
 * §15.1 pack: the request/PRD text · the wiki index (component names and one-line
 * summaries only) · existing `req_id`s for this project · previously recorded
 * out-of-scope items. Never emits a kind in the Analyst's `omits` list — no architecture,
 * source or task-level material is ever built here.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  if (i.raw.prd !== null) {
    sections.push(section('prd', 'Request', i.raw.prd));
  }
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
  return sections;
}

export function buildTaskSection(): string {
  return 'Read the request above and produce a RequirementSet: one testable assertion per ' +
    'requirement, the ambiguities you found, and what is implied out of scope.';
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkRequirementSet(artifact as RequirementSet, c);
}

/**
 * §15.1 post-step. For each ambiguity, mint `AssumptionRecorded` choosing `recommended`
 * if present, else `options[0]`. `source_span: null` requirements are tagged `agent-originated`
 * on `ItemArtifactRecorded`. Never blocks — there is no failure path here.
 */
export function postStep(i: PostStepInput): Promise<PostStepResult> {
  const artifact = i.artifact as RequirementSet;
  const derived: AppendInput[] = [];

  artifact.ambiguities.forEach((ambiguity, index) => {
    const chosen = ambiguity.recommended ?? ambiguity.options[0] ?? '';
    derived.push({
      type: 'AssumptionRecorded',
      data: {
        id: formatAssumptionId(i.slug, index + 1),
        question: ambiguity.question,
        chosen,
        alternatives: ambiguity.options.filter((option) => option !== chosen),
        affects: ambiguity.affects,
        depth: 0,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    });
  });

  const agentOriginatedCount = artifact.requirements.filter((r) => r.source_span === null).length;
  if (agentOriginatedCount > 0) {
    derived.push({
      type: 'ItemArtifactRecorded',
      data: {
        role: 'analyst',
        stage: 'analysis',
        artifact_kind: 'requirement-set',
        sha256: sha256Canonical(artifact),
        summary: `${String(agentOriginatedCount)} requirement(s) agent-originated (source_span: null)`,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    });
  }

  return Promise.resolve({ kind: 'ok', body: artifact, derived });
}

export const analystModule: RoleModule = {
  role: 'analyst',
  stage: 'analysis',
  artifactKind: 'requirement-set',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
