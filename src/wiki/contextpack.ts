import type { ProvenanceTier } from '../core/provenance.js';
import { isAtLeast, tierRank } from '../core/provenance.js';
import type { EventId, WorkItemId } from '../core/ids.js';
import type { Role, Stage } from '../core/events.js';
import { ContextPackError } from '../errors.js';
import { sha256Canonical } from '../core/hash.js';

export const PACK_SOURCE_KINDS = [
  'prd',
  'wiki-index',
  'existing-req-ids',
  'prior-out-of-scope',
  'stack-facts',
  'system-skeleton',
  'requirement-set',
  'architecture-decisions',
  'architecture-components',
  'architecture-interfaces',
  'file-map',
  'task-graph',
  'task',
  'test-conventions',
  'frozen-test-list',
  'frozen-test-bodies',
  'source-files',
  'diff',
  'oracle-results',
  'assumptions',
  'coder-transcript',
  'current-task-reviewer-findings',
  'other-task-reviewer-findings',
  'escalation-context',
] as const;
export type PackSourceKind = (typeof PACK_SOURCE_KINDS)[number];

export interface RolePackPolicy {
  readonly includes: readonly PackSourceKind[];
  readonly required: readonly PackSourceKind[]; // subset of includes; never dropped for budget
  readonly omits: readonly PackSourceKind[];
}

/** Widens each array to `readonly PackSourceKind[]` so indexing `ROLE_PACK_POLICY[role]`
 *  with the `Role` union does not collapse `.includes()` to one role's narrow tuple type. */
function rolePolicy(
  includes: readonly PackSourceKind[],
  required: readonly PackSourceKind[],
  omits: readonly PackSourceKind[],
): RolePackPolicy {
  return { includes, required, omits };
}

/**
 * TOTAL PARTITION: for every role, `includes ∪ omits === PACK_SOURCE_KINDS` and
 * `includes ∩ omits === ∅` (asserted by test). A new `PackSourceKind` therefore cannot be
 * added without every role classifying it — that is what makes acceptance criterion 4
 * ("context isolation is provable") a property of the type rather than a snapshot of today's
 * list. Encodes §15.1–15.6's packs and §3.17's table; the two bolded rows there are
 * load-bearing: the Test Author never sees `architecture-components`, `file-map` or
 * `task-graph`, and the Reviewer never sees `coder-transcript`.
 */
export const ROLE_PACK_POLICY = {
  analyst: rolePolicy(
    [
      'prd', 'wiki-index', 'existing-req-ids', 'prior-out-of-scope', 'stack-facts',
      'requirement-set', 'assumptions', 'escalation-context',
    ],
    ['prd'],
    [
      'system-skeleton',
      'architecture-decisions',
      'architecture-components',
      'architecture-interfaces',
      'file-map',
      'task-graph',
      'task',
      'test-conventions',
      'frozen-test-list',
      'frozen-test-bodies',
      'source-files',
      'diff',
      'oracle-results',
      'coder-transcript',
      'current-task-reviewer-findings',
      'other-task-reviewer-findings',
    ],
  ),
  architect: rolePolicy(
    [
      'wiki-index',
      'existing-req-ids',
      'prior-out-of-scope',
      'stack-facts',
      'system-skeleton',
      'requirement-set',
      'architecture-decisions',
      'architecture-components',
      'architecture-interfaces',
      'file-map',
      'test-conventions',
      'frozen-test-list',
      'assumptions',
      'escalation-context',
    ],
    ['requirement-set'],
    [
      'prd',
      'task-graph',
      'task',
      'frozen-test-bodies',
      'source-files',
      'diff',
      'oracle-results',
      'coder-transcript',
      'current-task-reviewer-findings',
      'other-task-reviewer-findings',
    ],
  ),
  planner: rolePolicy(
    [
      'wiki-index',
      'existing-req-ids',
      'prior-out-of-scope',
      'stack-facts',
      'system-skeleton',
      'requirement-set',
      'architecture-decisions',
      'architecture-components',
      'architecture-interfaces',
      'file-map',
      'task-graph',
      'task',
      'test-conventions',
      'frozen-test-list',
      'oracle-results',
      'assumptions',
      'escalation-context',
    ],
    ['requirement-set', 'architecture-decisions', 'architecture-components', 'architecture-interfaces'],
    [
      'prd', 'frozen-test-bodies', 'source-files', 'diff', 'coder-transcript',
      'current-task-reviewer-findings', 'other-task-reviewer-findings',
    ],
  ),
  testAuthor: rolePolicy(
    [
      'wiki-index',
      'existing-req-ids',
      'prior-out-of-scope',
      'stack-facts',
      'system-skeleton',
      'requirement-set',
      'architecture-interfaces',
      'test-conventions',
      'frozen-test-list',
      'assumptions',
    ],
    ['requirement-set', 'architecture-interfaces', 'test-conventions'],
    [
      'prd',
      'architecture-decisions',
      'architecture-components',
      'file-map',
      'task-graph',
      'task',
      'frozen-test-bodies',
      'source-files',
      'diff',
      'oracle-results',
      'coder-transcript',
      'current-task-reviewer-findings',
      'other-task-reviewer-findings',
      'escalation-context',
    ],
  ),
  coder: rolePolicy(
    [
      'existing-req-ids',
      'prior-out-of-scope',
      'stack-facts',
      'system-skeleton',
      'architecture-decisions',
      'architecture-components',
      'architecture-interfaces',
      'file-map',
      'task',
      'test-conventions',
      'frozen-test-list',
      'frozen-test-bodies',
      'source-files',
      'diff',
      'oracle-results',
      'assumptions',
      'current-task-reviewer-findings',
    ],
    ['task', 'frozen-test-bodies', 'architecture-interfaces'],
    [
      'prd', 'wiki-index', 'requirement-set', 'task-graph', 'coder-transcript',
      'other-task-reviewer-findings', 'escalation-context',
    ],
  ),
  reviewer: rolePolicy(
    [
      'wiki-index',
      'existing-req-ids',
      'prior-out-of-scope',
      'stack-facts',
      'system-skeleton',
      'requirement-set',
      'architecture-decisions',
      'architecture-components',
      'architecture-interfaces',
      'file-map',
      'task',
      'test-conventions',
      'frozen-test-list',
      'diff',
      'oracle-results',
      'assumptions',
      'current-task-reviewer-findings',
    ],
    ['diff', 'requirement-set', 'frozen-test-list'],
    [
      'prd', 'task-graph', 'frozen-test-bodies', 'source-files', 'coder-transcript',
      'other-task-reviewer-findings', 'escalation-context',
    ],
  ),
} satisfies Record<Role, RolePackPolicy>;

export interface ContextPackSection {
  readonly kind: PackSourceKind;
  readonly heading: string;
  readonly body: string;
  readonly tier: ProvenanceTier;
  readonly sourceEventId: EventId | null;
}

export interface ContextPack {
  readonly packId: string;
  readonly itemId: WorkItemId;
  readonly stage: Stage;
  readonly role: Role | null;
  readonly tierFloor: ProvenanceTier;
  readonly sections: readonly ContextPackSection[];
  readonly estimatedTokens: number;
  readonly dropped: readonly { kind: PackSourceKind; heading: string; reason: 'budget' }[];
}

/** ceil(utf8Bytes / 4). AN ESTIMATE — never a claim about the provider's own token count. */
export function estimateTokens(text: string): number {
  const utf8Bytes = new TextEncoder().encode(text).length;
  return Math.ceil(utf8Bytes / 4);
}

/** Deterministic markdown, section order preserved. */
export function renderPack(p: ContextPack): string {
  return p.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n');
}

/**
 * A pack with no sections and no floor. Phase 4 builds assembly, filtering, and token
 * budgeting; this constructor exists only so §9's frozen `Executor` interface has a
 * `ContextPack` value to reference in Phase 1.
 */
export function emptyContextPack(itemId: WorkItemId, stage: Stage): ContextPack {
  return {
    packId: `empty-${itemId}-${stage}`,
    itemId,
    stage,
    role: null,
    tierFloor: 'T3',
    sections: [],
    estimatedTokens: 0,
    dropped: [],
  };
}

function computePackId(role: Role, stage: Stage, sections: readonly ContextPackSection[]): string {
  const hash = sha256Canonical({ role, stage, sections });
  return `pack-${hash.slice(0, 16)}`;
}

/**
 * Among non-`required` sections, find the one to drop next: weakest tier first, then
 * reverse `includes` order. `sections` is already ordered by `policy.includes`, so "reverse
 * includes order" among a tied tier group is simply the last such section in the array.
 */
function findDropIndex(
  sections: readonly ContextPackSection[],
  required: readonly PackSourceKind[],
): number {
  let weakestRank = -1;
  for (const section of sections) {
    if (required.includes(section.kind)) {
      continue;
    }
    const rank = tierRank(section.tier);
    if (rank > weakestRank) {
      weakestRank = rank;
    }
  }
  if (weakestRank === -1) {
    return -1;
  }
  for (let idx = sections.length - 1; idx >= 0; idx -= 1) {
    const section = sections[idx];
    if (section === undefined || required.includes(section.kind)) {
      continue;
    }
    if (tierRank(section.tier) === weakestRank) {
      return idx;
    }
  }
  return -1;
}

/**
 * §3.17, normative, in order:
 * 1. Omit enforcement first — a candidate whose `kind` is in the role's `omits` throws,
 *    naming the role, the kind and the heading. Not a silent filter.
 * 2. Drop candidates weaker than `tierFloor`.
 * 3. Order sections by `policy.includes` order, then by candidate order within a kind.
 * 4. While over budget: drop the last non-`required` section by (weakest tier first, then
 *    reverse `includes` order), recording it in `dropped`.
 * 5. If `required` sections alone exceed the budget, throw — never truncate a required
 *    section's body.
 * 6. Pure: no clock, no fs, no randomness. Same input twice → byte-identical pack.
 */
export function assemblePack(i: {
  itemId: WorkItemId;
  stage: Stage;
  role: Role;
  candidates: readonly ContextPackSection[];
  budgetTokens: number;
  tierFloor: ProvenanceTier;
}): ContextPack {
  const policy = ROLE_PACK_POLICY[i.role];

  for (const candidate of i.candidates) {
    if (policy.omits.includes(candidate.kind)) {
      throw new ContextPackError(
        `role '${i.role}' must not receive pack section of kind '${candidate.kind}' ` +
          `(heading: ${JSON.stringify(candidate.heading)})`,
        { role: i.role, kind: candidate.kind, heading: candidate.heading },
      );
    }
  }

  const withinTier = i.candidates.filter((c) => isAtLeast(c.tier, i.tierFloor));

  const ordered: ContextPackSection[] = [];
  for (const kind of policy.includes) {
    for (const candidate of withinTier) {
      if (candidate.kind === kind) {
        ordered.push(candidate);
      }
    }
  }

  const sections = [...ordered];
  const dropped: { kind: PackSourceKind; heading: string; reason: 'budget' }[] = [];
  let estimated = sections.reduce((sum, s) => sum + estimateTokens(s.body), 0);

  while (estimated > i.budgetTokens) {
    const dropIndex = findDropIndex(sections, policy.required);
    if (dropIndex === -1) {
      throw new ContextPackError(
        `role '${i.role}'s required pack sections alone exceed the token budget ` +
          `(${estimated} > ${i.budgetTokens})`,
        { role: i.role, estimatedTokens: estimated, budgetTokens: i.budgetTokens },
      );
    }
    const [removed] = sections.splice(dropIndex, 1);
    if (removed !== undefined) {
      dropped.push({ kind: removed.kind, heading: removed.heading, reason: 'budget' });
      estimated -= estimateTokens(removed.body);
    }
  }

  return {
    packId: computePackId(i.role, i.stage, sections),
    itemId: i.itemId,
    stage: i.stage,
    role: i.role,
    tierFloor: i.tierFloor,
    sections,
    estimatedTokens: estimated,
    dropped,
  };
}
