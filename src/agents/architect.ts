import { sha256Canonical } from '../core/hash.js';
import type { ArchitecturePlan } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { packSection } from '../wiki/contextpack.js';
import { checkArchitecturePlan } from './checks.js';
import type { CheckContext } from './checks.js';
import { renderEscalationContext } from './agent.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';
import type { AppendInput } from '../core/log.js';
import { assumptionGateDraft, checkpointDraft } from '../supervisor/checkpointPolicy.js';
import type { CheckpointDraft } from '../supervisor/checkpointPolicy.js';

/**
 * §15.2 pack: full `RequirementSet` · system skeleton · prior decisions · component map ·
 * stack facts from config. Never emits `prd`, `task-graph`, `task`, `frozen-test-bodies`,
 * `source-files`, `diff`, `oracle-results`, `coder-transcript` or `reviewer-findings`.
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
    sections.push(packSection('architecture-decisions', 'Prior decisions', JSON.stringify(plan.decisions, null, 2), architectureTier));
    sections.push(packSection('architecture-components', 'Component map', JSON.stringify(plan.components, null, 2), architectureTier));
    sections.push(
      packSection('architecture-interfaces', 'Prior interfaces', JSON.stringify(plan.interfaces, null, 2), architectureTier),
    );
  }
  if (i.raw.testConventions !== null) {
    sections.push(packSection('test-conventions', 'Test conventions', i.raw.testConventions, 'T1'));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(packSection('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2), 'T2'));
  }
  if (i.raw.escalationContext !== null) {
    sections.push(packSection('escalation-context', 'Escalation context', renderEscalationContext('architect', i.raw.escalationContext), 'T1'));
  }
  return sections;
}

export function buildTaskSection(): string {
  return 'Read the requirements above and produce an ArchitecturePlan: decisions with their ' +
    'req_ids (empty when agent-originated), a component map, and interfaces precise enough ' +
    'for the Test Author to write against without seeing an implementation.';
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkArchitecturePlan(artifact as ArchitecturePlan, c);
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
 * §15.2 post-step: decisions with `req_ids: []` are flagged `agent-originated`. Decisions
 * with `blast_radius: 'irreversible'` each raise one blocking `CheckpointRaised`, with ids
 * continuing from `i.gate.nextCheckpointSerial` (binding decision 4: never a local counter)
 * and their blocking/SLA/default chosen by `checkpointDraft`. When at least one such
 * checkpoint was raised and an unresolved assumption exists with no `assumption-gate`
 * already open, one blocking assumption-gate checkpoint is raised alongside it.
 */
export function postStep(i: PostStepInput): Promise<PostStepResult> {
  const artifact = i.artifact as ArchitecturePlan;
  const derived: AppendInput[] = [];

  const agentOriginated = artifact.decisions.filter((d) => d.req_ids.length === 0);
  if (agentOriginated.length > 0) {
    derived.push({
      type: 'ItemArtifactRecorded',
      data: {
        role: 'architect',
        stage: 'architecture',
        artifact_kind: 'architecture-plan',
        sha256: sha256Canonical(artifact),
        summary: `${String(agentOriginated.length)} decision(s) agent-originated (req_ids: [])`,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    });
  }

  let serial = i.gate.nextCheckpointSerial;
  let raisedBlocking = false;
  for (const decision of artifact.decisions) {
    if (decision.blast_radius !== 'irreversible') {
      continue;
    }
    const draft = checkpointDraft({
      serial,
      slug: i.slug,
      kind: 'irreversible',
      stage: 'architecture',
      summary: `decision '${decision.decision_id}' is irreversible: ${decision.title}`,
      reversibility: 'irreversible',
      policy: i.gate.policy,
    });
    serial += 1;
    raisedBlocking = raisedBlocking || draft.blocking;
    derived.push(checkpointRaisedInput(draft));
  }

  if (raisedBlocking) {
    const gateDraft = assumptionGateDraft({
      serial,
      slug: i.slug,
      stage: 'architecture',
      open: i.gate.openAssumptions,
      checkpoints: i.gate.checkpoints,
      policy: i.gate.policy,
    });
    if (gateDraft !== null) {
      derived.push(checkpointRaisedInput(gateDraft));
    }
  }

  return Promise.resolve({ kind: 'ok', body: artifact, derived });
}

export const architectModule: RoleModule = {
  role: 'architect',
  stage: 'architecture',
  artifactKind: 'architecture-plan',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
