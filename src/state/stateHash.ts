import { sha256Canonical } from '../core/hash.js';
import type { WorkItemState } from './workitem.js';

/**
 * This is the definition of "identical state" in the Phase 1 acceptance criterion. Must not
 * live inside projector.ts, and projector.ts must not import it. This includes qualified drift
 * targets (`claimItem`, `claim`) so cross-item claim attribution is snapshot-integrity relevant.
 */
export function stateHash(s: WorkItemState): string {
  return sha256Canonical(s);
}
