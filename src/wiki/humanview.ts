import type { MienguEvent } from '../core/events.js';
import type { EventId, WorkItemId } from '../core/ids.js';
import type { ProvenanceTier } from '../core/provenance.js';
import { PROVENANCE_TIERS } from '../core/provenance.js';
import type { Claim, ClaimSet, ClaimStatus } from './records.js';
import { deriveClaims } from './records.js';

/** §4/§7: the human view lives under `<store.dir>/wiki/`; the CLI joins this to the store dir. */
export const WIKI_DIR = 'wiki';

/** A component id can never equal this reserved key (decision 8: `_unassigned` cannot collide
 *  with `RE_COMPONENT_ID`, which requires a `component-` prefix). */
const UNASSIGNED_KEY = '_unassigned';

/** Fixed render order (decision 16 / §4), deliberately not `CLAIM_STATUSES`' order. */
const STATUS_RENDER_ORDER: readonly ClaimStatus[] = [
  'active',
  'superseded',
  'quarantined',
  'invalidated',
];

export interface WikiFile {
  /** Store-relative, POSIX separators. */
  readonly path: string;
  readonly content: string;
}

export interface HumanViewItem {
  readonly itemId: WorkItemId;
  readonly events: readonly MienguEvent[];
}

export interface HumanViewInput {
  readonly language: 'fr' | 'en';
  readonly items: readonly HumanViewItem[];
}

type WikiStringKey =
  | 'indexTitle'
  | 'indexEmpty'
  | 'unassignedTitle'
  | 'componentTitle'
  | 'contributingItems'
  | 'sectionActive'
  | 'sectionSuperseded'
  | 'sectionQuarantined'
  | 'sectionInvalidated'
  | 'provisionalLabel'
  | 'supersededBy'
  | 'quarantinedExpected'
  | 'quarantinedObserved'
  | 'invalidatedBy'
  | 'noResponsibility';

/** Frozen bilingual lexicon (decision 16). Every heading and label rendered by this module
 *  comes from here; nothing else is translated or synthesised. */
export const WIKI_STRINGS: Record<'fr' | 'en', Record<WikiStringKey, string>> = {
  en: {
    indexTitle: 'Wiki index',
    indexEmpty: 'No components recorded yet.',
    unassignedTitle: 'Unassigned',
    componentTitle: 'Component',
    contributingItems: 'Contributing items',
    sectionActive: 'Active',
    sectionSuperseded: 'Superseded',
    sectionQuarantined: 'Quarantined',
    sectionInvalidated: 'Invalidated',
    provisionalLabel: 'provisional',
    supersededBy: 'superseded by',
    quarantinedExpected: 'expected',
    quarantinedObserved: 'observed',
    invalidatedBy: 'invalidated by',
    noResponsibility: '—',
  },
  fr: {
    indexTitle: 'Index du wiki',
    indexEmpty: 'Aucun composant enregistré pour le moment.',
    unassignedTitle: 'Non affecté',
    componentTitle: 'Composant',
    contributingItems: 'Éléments contributeurs',
    sectionActive: 'Actif',
    sectionSuperseded: 'Remplacé',
    sectionQuarantined: 'Mis en quarantaine',
    sectionInvalidated: 'Invalidé',
    provisionalLabel: 'provisoire',
    supersededBy: 'remplacé par',
    quarantinedExpected: 'attendu',
    quarantinedObserved: 'observé',
    invalidatedBy: 'invalidé par',
    noResponsibility: '—',
  },
};

function defaultCompare(a: string, b: string): number {
  // Array.prototype.sort's default comparator, UTF-16 code units (decision 3): the
  // ICU-version-dependent locale-aware string compare method is forbidden in this zone.
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

const TIER_RANK: Record<ProvenanceTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };

function sortClaims(claims: readonly Claim[]): Claim[] {
  return [...claims].sort((a, b) => {
    const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (byTier !== 0) {
      return byTier;
    }
    return defaultCompare(a.id, b.id);
  });
}

/** First cause `ArtifactsInvalidated` event id per invalidated `originEventId`, in seq order
 *  (§4/decision 6: "invalidated" carries no cause reference of its own — the cause is the
 *  `ArtifactsInvalidated` event that named the claim's origin event). */
function buildInvalidationCauseMap(events: readonly MienguEvent[]): ReadonlyMap<EventId, EventId> {
  const map = new Map<EventId, EventId>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (event.type !== 'ArtifactsInvalidated') {
      continue;
    }
    for (const originId of event.data.artifact_event_ids) {
      if (!map.has(originId)) {
        map.set(originId, event.event_id);
      }
    }
  }
  return map;
}

interface ItemEntry {
  readonly itemId: WorkItemId;
  readonly claimSet: ClaimSet;
  readonly invalidationCauseByOriginEventId: ReadonlyMap<EventId, EventId>;
}

function sectionKeyFor(status: ClaimStatus): WikiStringKey {
  switch (status) {
    case 'active':
      return 'sectionActive';
    case 'superseded':
      return 'sectionSuperseded';
    case 'quarantined':
      return 'sectionQuarantined';
    case 'invalidated':
      return 'sectionInvalidated';
  }
}

/** Decision 16's visual-weight table for an `active` claim, dispatched on tier. Anchored so
 *  the batch report can link into it (§4). */
function renderActiveClaim(
  claim: Claim,
  itemId: WorkItemId,
  strings: Record<WikiStringKey, string>,
): string {
  const anchor = `<a id="${itemId}/${claim.id}"></a>`;
  const badge = `[${claim.tier}]`;
  switch (claim.tier) {
    case 'T0':
      return `${anchor}**${claim.statement}** ${badge}`;
    case 'T1':
      return `${anchor}${claim.statement} ${badge}`;
    case 'T2':
      return `${anchor}\n> ${claim.statement} ${badge}`;
    case 'T3':
      return `${anchor}\n> *${claim.statement}* ${badge} (${strings.provisionalLabel})`;
  }
}

function renderSupersededClaim(
  claim: Claim,
  itemId: WorkItemId,
  strings: Record<WikiStringKey, string>,
): string {
  const anchor = `<a id="${itemId}/${claim.id}"></a>`;
  const successor = claim.supersededByClaimId;
  const link =
    successor !== null
      ? ` (${strings.supersededBy} [${successor}](#${itemId}/${successor}))`
      : '';
  return `${anchor}~~${claim.statement}~~${link}`;
}

function renderQuarantinedClaim(
  claim: Claim,
  itemId: WorkItemId,
  strings: Record<WikiStringKey, string>,
): string {
  const anchor = `<a id="${itemId}/${claim.id}"></a>`;
  const q = claim.quarantine;
  const detail =
    q !== null
      ? ` — ${strings.quarantinedExpected}: ${q.expected} / ${strings.quarantinedObserved}: ${q.observed}`
      : '';
  return `${anchor}~~${claim.statement}~~${detail}`;
}

function renderInvalidatedClaim(
  claim: Claim,
  itemId: WorkItemId,
  strings: Record<WikiStringKey, string>,
  causeByOriginEventId: ReadonlyMap<EventId, EventId>,
): string {
  const anchor = `<a id="${itemId}/${claim.id}"></a>`;
  const causeId = causeByOriginEventId.get(claim.originEventId) ?? null;
  const detail = causeId !== null ? ` — ${strings.invalidatedBy} ${causeId}` : '';
  return `${anchor}~~${claim.statement}~~${detail}`;
}

function renderClaimLine(
  claim: Claim,
  status: ClaimStatus,
  entry: ItemEntry,
  strings: Record<WikiStringKey, string>,
): string {
  switch (status) {
    case 'active':
      return renderActiveClaim(claim, entry.itemId, strings);
    case 'superseded':
      return renderSupersededClaim(claim, entry.itemId, strings);
    case 'quarantined':
      return renderQuarantinedClaim(claim, entry.itemId, strings);
    case 'invalidated':
      return renderInvalidatedClaim(claim, entry.itemId, strings, entry.invalidationCauseByOriginEventId);
  }
}

/** One section per contributing item, ordered `(createdAt, itemId)` (already the order of
 *  `itemsSorted`); within an item, the fixed status order, then claims by tier rank then id. */
function renderComponentFile(
  title: string,
  itemsSorted: readonly ItemEntry[],
  claimsByItem: ReadonlyMap<WorkItemId, readonly Claim[]>,
  strings: Record<WikiStringKey, string>,
): string {
  const parts: string[] = [`# ${title}`];
  for (const entry of itemsSorted) {
    const claims = claimsByItem.get(entry.itemId);
    if (claims === undefined || claims.length === 0) {
      continue;
    }
    parts.push(`## ${entry.claimSet.title} (${entry.itemId})`);
    for (const status of STATUS_RENDER_ORDER) {
      const inStatus = sortClaims(claims.filter((c) => c.status === status));
      if (inStatus.length === 0) {
        continue;
      }
      parts.push(`### ${strings[sectionKeyFor(status)]}`);
      for (const claim of inStatus) {
        parts.push(renderClaimLine(claim, status, entry, strings));
      }
    }
  }
  return parts.join('\n\n');
}

/** The first active `component` claim's statement naming `componentId`, across items in
 *  `(createdAt, itemId)` order; the first claim of any status if none is active; `''` if the
 *  component id is only ever referenced (never itself claimed). Never synthesised. */
function findResponsibility(componentId: string, itemsSorted: readonly ItemEntry[]): string {
  let fallback: string | null = null;
  for (const entry of itemsSorted) {
    for (const claim of entry.claimSet.claims) {
      if (claim.kind === 'component' && claim.subject === componentId) {
        if (claim.status === 'active') {
          return claim.statement;
        }
        if (fallback === null) {
          fallback = claim.statement;
        }
      }
    }
  }
  return fallback ?? '';
}

function tierCounts(claimsByItem: ReadonlyMap<WorkItemId, readonly Claim[]>): Record<ProvenanceTier, number> {
  const counts: Record<ProvenanceTier, number> = { T0: 0, T1: 0, T2: 0, T3: 0 };
  for (const claims of claimsByItem.values()) {
    for (const claim of claims) {
      if (claim.status === 'active') {
        counts[claim.tier] += 1;
      }
    }
  }
  return counts;
}

interface IndexEntry {
  readonly key: string;
  readonly responsibility: string;
  readonly itemIds: readonly WorkItemId[];
  readonly counts: Record<ProvenanceTier, number>;
}

function renderIndex(entries: readonly IndexEntry[], strings: Record<WikiStringKey, string>): string {
  const heading = `# ${strings.indexTitle}`;
  if (entries.length === 0) {
    return `${heading}\n\n${strings.indexEmpty}`;
  }
  const lines = entries.map((e) => {
    const label = e.key === UNASSIGNED_KEY ? strings.unassignedTitle : e.key;
    const responsibility = e.responsibility.length > 0 ? e.responsibility : strings.noResponsibility;
    const items = e.itemIds.join(', ');
    const counts = PROVENANCE_TIERS.map((t) => `${t}:${e.counts[t]}`).join(' ');
    return `- [${label}](components/${e.key}.md) — ${responsibility} — ${strings.contributingItems}: ${items} — ${counts}`;
  });
  return `${heading}\n\n${lines.join('\n')}`;
}

/**
 * Pure. Deterministic. Performs no I/O.
 *
 * Projects each item's events into a `ClaimSet` via `deriveClaims` (records.ts, Group A) and
 * renders from that alone (§4/§12: no other module, no filesystem, no clock). Split by
 * component (decision 8), never by stage: a claim renders in every file its
 * `trace.componentIds` names, and in `_unassigned.md` when that set is empty. Because claim
 * ids are unique only within a work item (decision 3), every anchor and cross-reference in a
 * multi-item component file is qualified `<itemId>/<claimId>`.
 */
export function renderHumanView(i: HumanViewInput): readonly WikiFile[] {
  const strings = WIKI_STRINGS[i.language];

  const itemEntries: ItemEntry[] = i.items.map((item) => ({
    itemId: item.itemId,
    claimSet: deriveClaims(item.events),
    invalidationCauseByOriginEventId: buildInvalidationCauseMap(item.events),
  }));

  itemEntries.sort((a, b) => {
    const byCreated = defaultCompare(a.claimSet.createdAt, b.claimSet.createdAt);
    if (byCreated !== 0) {
      return byCreated;
    }
    return defaultCompare(a.itemId, b.itemId);
  });

  // key -> itemId -> claims, mint order preserved within each item.
  const claimsByKeyThenItem = new Map<string, Map<WorkItemId, Claim[]>>();
  for (const entry of itemEntries) {
    for (const claim of entry.claimSet.claims) {
      const keys: readonly string[] =
        claim.trace.componentIds.length > 0 ? claim.trace.componentIds : [UNASSIGNED_KEY];
      for (const key of keys) {
        let byItem = claimsByKeyThenItem.get(key);
        if (byItem === undefined) {
          byItem = new Map<WorkItemId, Claim[]>();
          claimsByKeyThenItem.set(key, byItem);
        }
        let arr = byItem.get(entry.itemId);
        if (arr === undefined) {
          arr = [];
          byItem.set(entry.itemId, arr);
        }
        arr.push(claim);
      }
    }
  }

  const realKeys = [...claimsByKeyThenItem.keys()]
    .filter((k) => k !== UNASSIGNED_KEY)
    .sort(defaultCompare);
  const orderedKeys = claimsByKeyThenItem.has(UNASSIGNED_KEY) ? [...realKeys, UNASSIGNED_KEY] : realKeys;

  const files: WikiFile[] = [];
  const indexEntries: IndexEntry[] = [];

  for (const key of orderedKeys) {
    const byItem = claimsByKeyThenItem.get(key);
    if (byItem === undefined) {
      continue;
    }
    const contributingItemIds = itemEntries.filter((e) => byItem.has(e.itemId)).map((e) => e.itemId);
    const responsibility = key === UNASSIGNED_KEY ? '' : findResponsibility(key, itemEntries);
    const counts = tierCounts(byItem);
    const title = key === UNASSIGNED_KEY ? strings.unassignedTitle : `${strings.componentTitle}: ${key}`;
    const content = renderComponentFile(title, itemEntries, byItem, strings);
    files.push({ path: `${WIKI_DIR}/components/${key}.md`, content });
    indexEntries.push({ key, responsibility, itemIds: contributingItemIds, counts });
  }

  files.unshift({ path: `${WIKI_DIR}/index.md`, content: renderIndex(indexEntries, strings) });

  return files;
}

/** True for a path this renderer owns, used by the CLI to prune stale files (§4). Matches
 *  exactly `wiki/index.md` and `wiki/components/<component_id|_unassigned>.md`. */
export function isRenderedWikiPath(relPath: string): boolean {
  if (relPath === `${WIKI_DIR}/index.md`) {
    return true;
  }
  const prefix = `${WIKI_DIR}/components/`;
  const suffix = '.md';
  if (!relPath.startsWith(prefix) || !relPath.endsWith(suffix)) {
    return false;
  }
  const id = relPath.slice(prefix.length, relPath.length - suffix.length);
  if (id === UNASSIGNED_KEY) {
    return true;
  }
  return /^component-[a-z0-9-]+-\d+$/.test(id);
}
