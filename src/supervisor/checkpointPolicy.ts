import { z } from 'zod';
import type { CheckpointKind, MienguEvent, Stage } from '../core/events.js';
import type { AssumptionId, CheckpointId, Slug } from '../core/ids.js';
import { RE_SLUG, formatCheckpointId, parseSerial } from '../core/ids.js';
import type { AssumptionRecord, CheckpointStateRecord, WorkItemState } from '../state/workitem.js';
import type { AssumptionFact } from './assumptions.js';
import type { BlastRadiusPolicy } from './blastRadius.js';

/** Imports the config TYPE only, via the inline `import(...)` form `nextStage.ts` already uses
 *  for exactly this reason — the determinism zone restricts every `../config/*` import
 *  declaration, including `import type`. */
type MienguConfig = import('../config/schema.js').MienguConfig;

// Mirrors src/core/clock.ts's IsoTimestampSchema brand exactly (same brand literal) without
// importing clock.ts, which the determinism zone forbids for this file.
type IsoTimestamp = z.infer<z.ZodBranded<z.ZodString, 'IsoTimestamp'>>;

export interface CheckpointClassPolicy {
  readonly slaSeconds: number | null;
  readonly default: 'accept' | null;
}

export interface GatePolicy {
  readonly owner: string;
  readonly reversible: CheckpointClassPolicy;
  readonly irreversible: CheckpointClassPolicy;
  readonly blastRadius: BlastRadiusPolicy;
  readonly maxStackDepth: number;
}

// Mirrors src/config/schema.ts's checkpoints/assumptions sub-schemas exactly (same shape,
// same defaults) without importing that module, which the determinism zone forbids for this
// file even for a value. `gatePolicyAt` parses only these two sub-objects of the recorded
// `RunStarted.data.config`, with `safeParse`, so it never fabricates a pattern and never
// throws on a log whose in-force config predates Phase 5.
const CheckpointClassConfigSchema = z
  .object({
    slaSeconds: z.number().int().positive().nullable().default(null),
    default: z.literal('accept').nullable().default(null),
  })
  .strict();

const TRIGGER_SEVERITY_SCHEMA = z
  .object({
    'migration-or-schema': z.enum(['blocking', 'advisory', 'off']).default('blocking'),
    'sensitive-surface': z.enum(['blocking', 'advisory', 'off']).default('blocking'),
    'external-contract': z.enum(['blocking', 'advisory', 'off']).default('blocking'),
    'protected-surface': z.enum(['blocking', 'advisory', 'off']).default('blocking'),
    'dependency-manifest': z.enum(['blocking', 'advisory', 'off']).default('blocking'),
    'diff-size': z.enum(['blocking', 'advisory', 'off']).default('advisory'),
  })
  .strict();

const BLAST_RADIUS_CONFIG_SCHEMA = z
  .object({
    migrationOrSchemaPaths: z.array(z.string().min(1)).default([]),
    sensitivePaths: z.array(z.string().min(1)).default([]),
    externalContractPaths: z.array(z.string().min(1)).default([]),
    protectedPaths: z.array(z.string().min(1)).default([]),
    dependencyManifestPaths: z.array(z.string().min(1)).default([]),
    maxDiffLines: z.number().int().positive().default(400),
    maxFilesTouched: z.number().int().positive().default(20),
    severity: TRIGGER_SEVERITY_SCHEMA.default({}),
  })
  .strict();

const CHECKPOINTS_CONFIG_SCHEMA = z
  .object({
    defaultOwner: z.string().regex(RE_SLUG).max(48).default('operator'),
    reversible: CheckpointClassConfigSchema.default({ slaSeconds: 86400, default: 'accept' }),
    irreversible: CheckpointClassConfigSchema.default({ slaSeconds: null, default: null }),
    blastRadius: BLAST_RADIUS_CONFIG_SCHEMA.default({}),
  })
  .strict();

const ASSUMPTIONS_CONFIG_SCHEMA = z
  .object({
    maxStackDepth: z.number().int().positive().default(2),
  })
  .strict();

const EMPTY_CHECKPOINTS_CONFIG = CHECKPOINTS_CONFIG_SCHEMA.parse({});
const EMPTY_ASSUMPTIONS_CONFIG = ASSUMPTIONS_CONFIG_SCHEMA.parse({});

/** Parses `value` against the checkpoints sub-schema; on any failure, falls back to the
 *  schema's own defaults rather than throwing or fabricating a pattern. Total. */
function checkpointsConfigAt(config: unknown): z.infer<typeof CHECKPOINTS_CONFIG_SCHEMA> {
  const raw = config !== null && typeof config === 'object' ? (config as Record<string, unknown>)['checkpoints'] : undefined;
  const result = CHECKPOINTS_CONFIG_SCHEMA.safeParse(raw);
  return result.success ? result.data : EMPTY_CHECKPOINTS_CONFIG;
}

/** Parses `value` against the assumptions sub-schema; on any failure, falls back to the
 *  schema's own defaults rather than throwing or fabricating a pattern. Total. */
function assumptionsConfigAt(config: unknown): z.infer<typeof ASSUMPTIONS_CONFIG_SCHEMA> {
  const raw = config !== null && typeof config === 'object' ? (config as Record<string, unknown>)['assumptions'] : undefined;
  const result = ASSUMPTIONS_CONFIG_SCHEMA.safeParse(raw);
  return result.success ? result.data : EMPTY_ASSUMPTIONS_CONFIG;
}

/** Imports the config TYPE only (see `MienguConfig` above): builds a `GatePolicy` directly
 *  from an already-validated config, with no parsing and no fallback. */
export function gatePolicyFromConfig(c: MienguConfig): GatePolicy {
  return {
    owner: c.checkpoints.defaultOwner,
    reversible: c.checkpoints.reversible,
    irreversible: c.checkpoints.irreversible,
    blastRadius: c.checkpoints.blastRadius,
    maxStackDepth: c.assumptions.maxStackDepth,
  };
}

/** The `RunStarted` in force at or before `seq`: the last one whose own `seq` does not
 *  exceed it. `null` when no `RunStarted` precedes `seq`. */
function inForceRunStarted(events: readonly MienguEvent[], seq: number): MienguEvent | null {
  let found: MienguEvent | null = null;
  for (const event of events) {
    if (event.type !== 'RunStarted' || event.seq > seq) continue;
    if (found === null || event.seq > found.seq) {
      found = event;
    }
  }
  return found;
}

/** Total: parses `RunStarted.data.config` with `MienguConfigSchema`'s Phase 5 sub-schemas only.
 *  A log whose in-force config predates Phase 5 yields the schema defaults, never a
 *  fabrication. */
export function gatePolicyAt(events: readonly MienguEvent[], seq: number): GatePolicy {
  const runStarted = inForceRunStarted(events, seq);
  const config = runStarted !== null && runStarted.type === 'RunStarted' ? runStarted.data.config : undefined;
  const checkpoints = checkpointsConfigAt(config);
  const assumptions = assumptionsConfigAt(config);
  return {
    owner: checkpoints.defaultOwner,
    reversible: checkpoints.reversible,
    irreversible: checkpoints.irreversible,
    blastRadius: checkpoints.blastRadius,
    maxStackDepth: assumptions.maxStackDepth,
  };
}

export function checkpointOwner(events: readonly MienguEvent[], checkpoint: CheckpointId): string {
  let raisedSeq = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.type === 'CheckpointRaised' && event.data.checkpoint === checkpoint) {
      raisedSeq = event.seq;
      break;
    }
  }
  return gatePolicyAt(events, raisedSeq).owner;
}

/** Binding decision 4. `max(n) + 1` over every id already present, 1 when there are none.
 *  An id `parseSerial` rejects is ignored rather than thrown. */
export function nextCheckpointSerial(
  checkpoints: Readonly<Record<string, CheckpointStateRecord>>,
): number {
  let max = 0;
  for (const id of Object.keys(checkpoints)) {
    try {
      const { n } = parseSerial(id);
      if (n > max) max = n;
    } catch {
      // Not a recognised serial id: ignored, never thrown.
    }
  }
  return max + 1;
}

export function nextAssumptionSerial(assumptions: readonly AssumptionRecord[]): number {
  let max = 0;
  for (const a of assumptions) {
    try {
      const { n } = parseSerial(a.id);
      if (n > max) max = n;
    } catch {
      // Not a recognised serial id: ignored, never thrown.
    }
  }
  return max + 1;
}

export interface CheckpointDraft {
  readonly checkpoint: CheckpointId;
  readonly kind: CheckpointKind;
  readonly stage: Stage;
  readonly summary: string;
  readonly blocking: boolean;
  readonly slaSeconds: number | null;
  readonly defaultDecision: 'accept' | null;
}

function isBlocking(kind: CheckpointKind, reversibility: 'reversible' | 'irreversible'): boolean {
  if (kind === 'irreversible' || kind === 'assumption-gate' || kind === 'escalation') {
    return true;
  }
  if (kind === 'blast-radius') {
    return reversibility === 'irreversible';
  }
  return false;
}

/** The single place blocking/SLA/default is decided for any checkpoint, from any producer. */
export function checkpointDraft(o: {
  readonly serial: number;
  readonly slug: Slug;
  readonly kind: CheckpointKind;
  readonly stage: Stage;
  readonly summary: string;
  readonly reversibility: 'reversible' | 'irreversible';
  readonly policy: GatePolicy;
}): CheckpointDraft {
  const blocking = isBlocking(o.kind, o.reversibility);
  const cls = blocking ? o.policy.irreversible : o.policy.reversible;
  return {
    checkpoint: formatCheckpointId(o.slug, o.serial),
    kind: o.kind,
    stage: o.stage,
    summary: o.summary,
    blocking,
    slaSeconds: cls.slaSeconds,
    defaultDecision: cls.default,
  };
}

/** Binding decision 10. Returns `null` when there is nothing unresolved, or when an
 *  `assumption-gate` checkpoint is already open for this item. */
export function assumptionGateDraft(o: {
  readonly serial: number;
  readonly slug: Slug;
  readonly stage: Stage;
  readonly open: readonly AssumptionFact[];
  readonly checkpoints: Readonly<Record<string, CheckpointStateRecord>>;
  readonly policy: GatePolicy;
}): CheckpointDraft | null {
  if (o.open.length === 0) {
    return null;
  }
  const alreadyOpen = Object.values(o.checkpoints).some(
    (record) => record.kind === 'assumption-gate' && record.status === 'open',
  );
  if (alreadyOpen) {
    return null;
  }
  const ids: readonly AssumptionId[] = o.open.map((fact) => fact.id);
  return checkpointDraft({
    serial: o.serial,
    slug: o.slug,
    kind: 'assumption-gate',
    stage: o.stage,
    summary: `assumption gate: ${ids.join(', ')} unresolved`,
    reversibility: 'irreversible',
    policy: o.policy,
  });
}

export interface SlaCandidate {
  readonly checkpoint: CheckpointId;
  readonly slaSeconds: number;
  readonly defaultDecision: 'accept';
  readonly raisedAt: IsoTimestamp;
}

/** Binding decision 8's pure half: eligibility only. No arithmetic on timestamps, no clock. */
export function slaCandidates(
  events: readonly MienguEvent[],
  state: WorkItemState,
): readonly SlaCandidate[] {
  const raisedByCheckpoint = new Map<string, MienguEvent & { type: 'CheckpointRaised' }>();
  for (const event of events) {
    if (event.type === 'CheckpointRaised' && !raisedByCheckpoint.has(event.data.checkpoint)) {
      raisedByCheckpoint.set(event.data.checkpoint, event);
    }
  }

  const candidates: SlaCandidate[] = [];
  for (const record of Object.values(state.checkpoints)) {
    if (record.status !== 'open') continue;
    const raised = raisedByCheckpoint.get(record.id);
    if (raised === undefined) continue;
    const { sla_seconds, default_decision } = raised.data;
    if (sla_seconds === null || sla_seconds <= 0) continue;
    if (default_decision !== 'accept') continue;
    candidates.push({
      checkpoint: record.id,
      slaSeconds: sla_seconds,
      defaultDecision: 'accept',
      raisedAt: record.raisedAt,
    });
  }
  return candidates;
}

/** `${slaSeconds}s`. The declared SLA, never the observed elapsed time. */
export function autoApprovalAfter(slaSeconds: number): string {
  return `${String(slaSeconds)}s`;
}
