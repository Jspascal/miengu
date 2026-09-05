import { describe, it, expect } from 'vitest';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';

const VALID = {
  requirements: [
    {
      req_id: 'REQ-auth-1',
      statement: 'Users can log in with email and password.',
      rationale: 'Baseline authentication is required for any account-scoped feature.',
      acceptance: ['A valid credential pair returns a session token.'],
      priority: 'must',
      source_span: 'brief.md#L10-L12',
    },
  ],
  ambiguities: [
    {
      question: 'Should sessions expire?',
      affects: ['REQ-auth-1'],
      options: ['24 hours', 'never'],
      recommended: '24 hours',
    },
  ],
  out_of_scope: ['Social login'],
};

describe('RequirementSetSchema', () => {
  it('parses a valid fixture', () => {
    const result = RequirementSetSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects an extra key', () => {
    const result = RequirementSetSchema.safeParse({ ...VALID, bogus: true });
    expect(result.success).toBe(false);
  });

  it('rejects an empty requirements array', () => {
    const result = RequirementSetSchema.safeParse({ ...VALID, requirements: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty acceptance array', () => {
    const result = RequirementSetSchema.safeParse({
      ...VALID,
      requirements: [{ ...VALID.requirements[0], acceptance: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an ambiguity with only one option', () => {
    const result = RequirementSetSchema.safeParse({
      ...VALID,
      ambiguities: [{ ...VALID.ambiguities[0], options: ['24 hours'] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed req_id', () => {
    const result = RequirementSetSchema.safeParse({
      ...VALID,
      requirements: [{ ...VALID.requirements[0], req_id: 'REQ-Foo-1' }],
    });
    expect(result.success).toBe(false);
  });
});
