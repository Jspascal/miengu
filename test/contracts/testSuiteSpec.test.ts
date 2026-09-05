import { describe, it, expect } from 'vitest';
import {
  TestCaseSchema,
  TestSuiteSpecDraftSchema,
  TestSuiteSpecSchema,
} from '../../src/contracts/testSuiteSpec.js';

const CASE = {
  test_id: 'test-auth-1',
  req_ids: ['REQ-auth-1'],
  path: 'test/auth/login.test.ts',
  intent: 'A valid credential pair returns a session token.',
  negative: false,
  asserts_output: true,
};

const DRAFT = {
  suite_id: 'suite-auth-1',
  cases: [CASE],
};

const FROZEN = {
  suite_id: 'suite-auth-1',
  frozen_at: '2026-09-04T00:00:00.000Z',
  content_hash: 'a'.repeat(64),
  cases: [CASE],
};

describe('TestCaseSchema', () => {
  it('rejects a case missing asserts_output', () => {
    const withoutAssertsOutput: Record<string, unknown> = { ...CASE };
    delete withoutAssertsOutput['asserts_output'];
    const result = TestCaseSchema.safeParse(withoutAssertsOutput);
    expect(result.success).toBe(false);
  });
});

describe('TestSuiteSpecDraftSchema', () => {
  it('parses a valid draft', () => {
    expect(TestSuiteSpecDraftSchema.safeParse(DRAFT).success).toBe(true);
  });

  it('rejects a draft carrying frozen_at', () => {
    const result = TestSuiteSpecDraftSchema.safeParse({ ...DRAFT, frozen_at: FROZEN.frozen_at });
    expect(result.success).toBe(false);
  });
});

describe('TestSuiteSpecSchema', () => {
  it('requires all four keys', () => {
    expect(TestSuiteSpecSchema.safeParse(FROZEN).success).toBe(true);
    const withoutContentHash: Record<string, unknown> = { ...FROZEN };
    delete withoutContentHash['content_hash'];
    expect(TestSuiteSpecSchema.safeParse(withoutContentHash).success).toBe(false);
  });

  it('rejects a 63-char content_hash', () => {
    const result = TestSuiteSpecSchema.safeParse({ ...FROZEN, content_hash: 'a'.repeat(63) });
    expect(result.success).toBe(false);
  });
});
