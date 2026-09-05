import { describe, it, expect } from 'vitest';
import { ArchitecturePlanSchema } from '../../src/contracts/architecturePlan.js';

const VALID = {
  decisions: [
    {
      decision_id: 'decision-auth-1',
      title: 'Use JWT sessions',
      choice: 'JWT',
      alternatives: ['opaque tokens'],
      rationale: 'Stateless verification avoids a session store.',
      req_ids: ['REQ-auth-1'],
      supersedes: null,
      blast_radius: 'reversible',
    },
  ],
  components: [
    {
      component_id: 'component-auth-1',
      responsibility: 'Handles login and session issuance.',
      paths: ['src/auth/'],
      depends_on: [],
    },
  ],
  interfaces: [
    {
      interface_id: 'interface-auth-1',
      component_id: 'component-auth-1',
      signature: 'login(email, password): Session',
      behaviour: 'Validates credentials and issues a session token.',
      req_ids: ['REQ-auth-1'],
    },
  ],
};

describe('ArchitecturePlanSchema', () => {
  it('parses a valid fixture', () => {
    const result = ArchitecturePlanSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects interfaces[].req_ids: []', () => {
    const result = ArchitecturePlanSchema.safeParse({
      ...VALID,
      interfaces: [{ ...VALID.interfaces[0], req_ids: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bad decision_id', () => {
    const result = ArchitecturePlanSchema.safeParse({
      ...VALID,
      decisions: [{ ...VALID.decisions[0], decision_id: 'Decision-Auth-1' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts supersedes: null', () => {
    const result = ArchitecturePlanSchema.safeParse(VALID);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.decisions[0]?.supersedes).toBeNull();
    }
  });

  it('rejects an extra key', () => {
    const result = ArchitecturePlanSchema.safeParse({ ...VALID, bogus: true });
    expect(result.success).toBe(false);
  });
});
