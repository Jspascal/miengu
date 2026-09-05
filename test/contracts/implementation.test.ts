import { describe, it, expect } from 'vitest';
import { ImplementationSchema } from '../../src/contracts/implementation.js';

const VALID = {
  task_id: 'task-auth-1',
  diff_ref: 'diff-sha256:abc123',
  files_touched: ['src/auth/login.ts'],
  assumption_ids: ['assumption-auth-1'],
  deviations: [
    {
      from_decision_id: 'decision-auth-1',
      reason: 'Used a different library than the plan specified.',
    },
  ],
};

describe('ImplementationSchema', () => {
  it('parses a valid fixture', () => {
    const result = ImplementationSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects an extra key', () => {
    const result = ImplementationSchema.safeParse({ ...VALID, bogus: true });
    expect(result.success).toBe(false);
  });

  it('rejects an extra key inside deviations[]', () => {
    const result = ImplementationSchema.safeParse({
      ...VALID,
      deviations: [{ ...VALID.deviations[0], bogus: true }],
    });
    expect(result.success).toBe(false);
  });
});
