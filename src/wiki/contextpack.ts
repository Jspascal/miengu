import type { ProvenanceTier } from '../core/provenance.js';
import type { EventId, WorkItemId } from '../core/ids.js';
import type { Stage } from '../core/events.js';

export interface ContextPackSection {
  readonly heading: string;
  readonly body: string;
  readonly tier: ProvenanceTier;
  readonly sourceEventId: EventId | null;
}

export interface ContextPack {
  readonly packId: string;
  readonly itemId: WorkItemId;
  readonly stage: Stage;
  readonly tierFloor: ProvenanceTier;
  readonly sections: readonly ContextPackSection[];
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
    tierFloor: 'T3',
    sections: [],
  };
}
