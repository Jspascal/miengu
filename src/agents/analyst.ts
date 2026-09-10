import { formatAssumptionId } from '../core/ids.js';
import { sha256Canonical } from '../core/hash.js';
import type { RequirementSet } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { packSection } from '../wiki/contextpack.js';
import { checkRequirementSet } from './checks.js';
import type { CheckContext } from './checks.js';
import { renderEscalationContext } from './agent.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';
import type { AppendInput } from '../core/log.js';
import { assumptionDepth, escalates } from '../supervisor/assumptions.js';
import type { AssumptionFact } from '../supervisor/assumptions.js';
import { checkpointDraft } from '../supervisor/checkpointPolicy.js';
import type { CheckpointDraft } from '../supervisor/checkpointPolicy.js';

/**
 * §15.1 pack: the request/PRD text · the wiki index (component names and one-line
 * summaries only) · existing `req_id`s for this project · previously recorded
 * out-of-scope items. Never emits a kind in the Analyst's `omits` list — no architecture,
 * source or task-level material is ever built here.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  if (i.raw.prd !== null) {
    sections.push(packSection('prd', 'Request', i.raw.prd, 'T0'));
  }
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
  if (i.raw.escalationContext !== null) {
    sections.push(packSection('escalation-context', 'Escalation context', renderEscalationContext('analyst', i.raw.escalationContext), 'T1'));
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

/** Maps a `CheckpointDraft` (`src/supervisor/checkpointPolicy.ts`) onto the snake_case
 *  `CheckpointRaised` event shape. */
function checkpointRaisedInput(draft: CheckpointDraft): AppendInput {
  return {
    type: 'CheckpointRaised',
    data: {
      checkpoint: draft.checkpoint,
      kind: draft.kind,
      stage: draft.stage,
      summary: draft.summary,
      blocking: draft.blocking,
      sla_seconds: draft.slaSeconds,
      default_decision: draft.defaultDecision,
    },
    actor: { kind: 'supervisor', id: null },
    causationId: null,
  };
}

/**
 * §15.1 post-step. For each ambiguity, mint `AssumptionRecorded` choosing `recommended`
 * if present, else `options[0]`, with an id continuing from `i.gate.nextAssumptionSerial`
 * (binding decision 4: never a local counter) and a real chain depth (binding decision 9).
 * An ambiguity whose depth reaches the configured cap additionally raises one blocking
 * `escalation` checkpoint; the assumption itself is still recorded, never withheld.
 * `source_span: null` requirements are tagged `agent-originated` on `ItemArtifactRecorded`.
 * Never blocks a stage — there is no failure path here.
 */
export function postStep(i: PostStepInput): Promise<PostStepResult> {
  const artifact = i.artifact as RequirementSet;
  const derived: AppendInput[] = [];

  // `open` accumulates each assumption minted earlier in this same batch, so a later
  // ambiguity's depth can rest on an earlier one from the same array (binding decision 9).
  let open: readonly AssumptionFact[] = i.gate.openAssumptions;
  let checkpointSerial = i.gate.nextCheckpointSerial;

  artifact.ambiguities.forEach((ambiguity, index) => {
    const chosen = ambiguity.recommended ?? ambiguity.options[0] ?? '';
    const id = formatAssumptionId(i.slug, i.gate.nextAssumptionSerial + index);
    const depth = assumptionDepth(ambiguity.affects, open);
    derived.push({
      type: 'AssumptionRecorded',
      data: {
        id,
        question: ambiguity.question,
        chosen,
        alternatives: ambiguity.options.filter((option) => option !== chosen),
        affects: ambiguity.affects,
        depth,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    });
    open = [
      ...open,
      { id, affects: ambiguity.affects, depth, resolved: false, seq: -1, gateCheckpointId: null },
    ];

    if (escalates(depth, i.gate.policy.maxStackDepth)) {
      const draft = checkpointDraft({
        serial: checkpointSerial,
        slug: i.slug,
        kind: 'escalation',
        stage: 'analysis',
        summary: `assumption '${id}' escalates at depth ${String(depth)}`,
        reversibility: 'irreversible',
        policy: i.gate.policy,
      });
      checkpointSerial += 1;
      derived.push(checkpointRaisedInput(draft));
    }
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
