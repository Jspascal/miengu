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
  falsifications: [],
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

  it('requires the falsifications array', () => {
    const withoutFalsifications = {
      decisions: VALID.decisions,
      components: VALID.components,
      interfaces: VALID.interfaces,
    };
    expect(ArchitecturePlanSchema.safeParse(withoutFalsifications).success).toBe(false);
  });

  it('accepts a falsification with a null subject and a closed predicate', () => {
    const result = ArchitecturePlanSchema.safeParse({
      ...VALID,
      falsifications: [
        {
          assertion: 'the auth module still lives under src/auth',
          subject: null,
          area: 'src/auth',
          predicate: { kind: 'path-exists', path: 'src/auth/index.ts', expected: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a falsification whose subject is a qualified existing claim', () => {
    const result = ArchitecturePlanSchema.safeParse({
      ...VALID,
      falsifications: [
        {
          assertion: 'the hot module contract holds',
          subject: { claim_item: 'wi-hotfix-aaaaaa', claim: 'claim-hot-1' },
          area: null,
          predicate: { kind: 'text-includes', path: 'src/hot.ts', needle: 'export function hot', expected: true },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a falsification carrying free-form executable text', () => {
    const result = ArchitecturePlanSchema.safeParse({
      ...VALID,
      falsifications: [
        {
          assertion: 'a',
          subject: null,
          area: null,
          predicate: { kind: 'path-exists', path: 'src/x.ts', expected: true, argv: ['rm', '-rf'] },
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
