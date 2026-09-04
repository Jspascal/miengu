import { describe, it, expect } from 'vitest';
import { systemRng, fixedRng, createIdMinter } from '../../src/core/idgen.js';
import { RE_EVENT_ID, RE_RUN_ID, RE_WORK_ITEM_ID, SlugSchema } from '../../src/core/ids.js';

describe('systemRng', () => {
  it('produces well-formed uuids and base36 strings', () => {
    const uuid = systemRng.uuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const b36 = systemRng.base36(6);
    expect(b36).toMatch(/^[a-z0-9]{6}$/);
  });

  it('produces different values on successive calls', () => {
    expect(systemRng.uuid()).not.toBe(systemRng.uuid());
  });
});

describe('fixedRng', () => {
  it('is deterministic given the same seed', () => {
    const a = fixedRng('seed-1');
    const b = fixedRng('seed-1');
    for (let i = 0; i < 5; i += 1) {
      expect(a.uuid()).toBe(b.uuid());
    }
  });

  it('produces well-formed uuids and base36 strings', () => {
    const rng = fixedRng('seed-2');
    expect(rng.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(rng.base36(6)).toMatch(/^[a-z0-9]{6}$/);
  });

  it('advances on each call, never repeating within the same instance', () => {
    const rng = fixedRng('seed-3');
    const first = rng.uuid();
    const second = rng.uuid();
    expect(first).not.toBe(second);
  });

  it('different seeds produce different sequences', () => {
    const a = fixedRng('seed-a');
    const b = fixedRng('seed-b');
    expect(a.uuid()).not.toBe(b.uuid());
  });
});

describe('createIdMinter', () => {
  const slug = SlugSchema.parse('auth-flow');

  it('mints ids matching their family regexes', () => {
    const minter = createIdMinter(fixedRng('minter-seed'));
    expect(RE_EVENT_ID.test(minter.eventId())).toBe(true);
    expect(RE_RUN_ID.test(minter.runId())).toBe(true);
    expect(RE_WORK_ITEM_ID.test(minter.workItemId(slug))).toBe(true);
  });

  it('workItemId embeds the given slug', () => {
    const minter = createIdMinter(fixedRng('minter-seed-2'));
    const id = minter.workItemId(slug);
    expect(id.startsWith(`wi-${slug}-`)).toBe(true);
  });

  it('sessionUuid returns a raw uuid, not prefixed', () => {
    const minter = createIdMinter(fixedRng('minter-seed-3'));
    const session = minter.sessionUuid();
    expect(session).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic end-to-end given a deterministic rng', () => {
    const minterA = createIdMinter(fixedRng('deterministic-seed'));
    const minterB = createIdMinter(fixedRng('deterministic-seed'));
    expect(minterA.eventId()).toBe(minterB.eventId());
    expect(minterA.runId()).toBe(minterB.runId());
    expect(minterA.workItemId(slug)).toBe(minterB.workItemId(slug));
  });
});
