import { describe, it, expect } from 'vitest';
import { ReviewVerdictSchema } from '../../src/contracts/reviewVerdict.js';

const VALID = {
  task_id: 'task-auth-1',
  verdict: 'revise',
  findings: [
    {
      severity: 'blocking',
      kind: 'requirement-miss',
      detail: 'The login endpoint does not validate the password field.',
      path: 'src/auth/login.ts',
    },
  ],
  escalate_to: null,
};

describe('ReviewVerdictSchema', () => {
  it('parses a valid fixture', () => {
    const result = ReviewVerdictSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('accepts only the three role names or null for escalate_to', () => {
    for (const value of ['planner', 'architect', 'analyst', null]) {
      expect(ReviewVerdictSchema.safeParse({ ...VALID, escalate_to: value }).success).toBe(true);
    }
    expect(ReviewVerdictSchema.safeParse({ ...VALID, escalate_to: 'coder' }).success).toBe(false);
  });

  it('rejects an unknown severity', () => {
    const result = ReviewVerdictSchema.safeParse({
      ...VALID,
      findings: [{ ...VALID.findings[0], severity: 'critical' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    const result = ReviewVerdictSchema.safeParse({
      ...VALID,
      findings: [{ ...VALID.findings[0], kind: 'style' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an extra key', () => {
    const result = ReviewVerdictSchema.safeParse({ ...VALID, bogus: true });
    expect(result.success).toBe(false);
  });
});
