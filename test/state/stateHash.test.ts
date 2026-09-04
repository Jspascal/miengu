import { describe, it, expect } from 'vitest';
import { sha256Canonical } from '../../src/core/hash.js';
import { stateHash } from '../../src/state/stateHash.js';
import { emptyAttempts, PROJECTION_VERSION } from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';

function baseState(): WorkItemState {
  return {
    projectionVersion: PROJECTION_VERSION,
    itemId: 'wi-example-abc123' as WorkItemState['itemId'],
    slug: 'example' as WorkItemState['slug'],
    seq: 1,
    lastEventId: null,
    createdAt: '2024-01-01T00:00:00.000Z' as WorkItemState['createdAt'],
    updatedAt: '2024-01-01T00:00:00.000Z' as WorkItemState['updatedAt'],
    title: 'Example item',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    configHash: 'deadbeef',
    status: 'active',
    stage: 'intake',
    stageEnteredAt: null,
    attempts: emptyAttempts(),
    failures: [],
    park: null,
    budget: { consumed: { wallSeconds: 0, turns: 0, usd: 0, partial: { turns: false, usd: false } }, exhausted: null },
    workspace: null,
    lastExecutor: null,
    lastDiff: null,
    artifacts: {},
    checkpoints: {},
    assumptions: [],
    drift: [],
    tampering: [],
    runs: [],
  };
}

describe('stateHash', () => {
  it('equals sha256Canonical of the state', () => {
    const state = baseState();
    expect(stateHash(state)).toBe(sha256Canonical(state));
  });

  it('the same state built two ways hashes identically', () => {
    const a = baseState();
    const b = baseState();
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('is independent of key insertion order', () => {
    const a = baseState();
    const b = Object.fromEntries(Object.entries(a).reverse()) as unknown as WorkItemState;
    expect(stateHash(a)).toBe(stateHash(b));
  });

  it('a one-field change alters the hash', () => {
    const a = baseState();
    const b: WorkItemState = { ...a, title: 'Different title' };
    expect(stateHash(a)).not.toBe(stateHash(b));
  });

  it('a nested one-field change alters the hash', () => {
    const a = baseState();
    const b: WorkItemState = { ...a, budget: { ...a.budget, consumed: { ...a.budget.consumed, turns: 1 } } };
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
});
