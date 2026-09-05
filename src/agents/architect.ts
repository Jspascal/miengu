import { formatCheckpointId } from '../core/ids.js';
import { sha256Canonical } from '../core/hash.js';
import type { ArchitecturePlan } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { checkArchitecturePlan } from './checks.js';
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
 * §15.2 pack: full `RequirementSet` · system skeleton · prior decisions · component map ·
 * stack facts from config. Never emits `prd`, `task-graph`, `task`, `frozen-test-bodies`,
 * `source-files`, `diff`, `oracle-results`, `coder-transcript` or `reviewer-findings`.
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
    sections.push(section('architecture-decisions', 'Prior decisions', JSON.stringify(plan.decisions, null, 2)));
    sections.push(section('architecture-components', 'Component map', JSON.stringify(plan.components, null, 2)));
    sections.push(
      section('architecture-interfaces', 'Prior interfaces', JSON.stringify(plan.interfaces, null, 2)),
    );
  }
  if (i.raw.testConventions !== null) {
    sections.push(section('test-conventions', 'Test conventions', i.raw.testConventions));
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(section('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2)));
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

/**
 * §15.2 post-step: decisions with `req_ids: []` are flagged `agent-originated`. Decisions
 * with `blast_radius: 'irreversible'` each raise one blocking `CheckpointRaised`.
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

  let checkpointIndex = 0;
  for (const decision of artifact.decisions) {
    if (decision.blast_radius !== 'irreversible') {
      continue;
    }
    checkpointIndex += 1;
    derived.push({
      type: 'CheckpointRaised',
      data: {
        checkpoint: formatCheckpointId(i.slug, checkpointIndex),
        kind: 'irreversible',
        stage: 'architecture',
        summary: `decision '${decision.decision_id}' is irreversible: ${decision.title}`,
        blocking: true,
        sla_seconds: null,
        default_decision: null,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: null,
    });
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
