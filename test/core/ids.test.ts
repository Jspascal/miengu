import { describe, it, expect } from 'vitest';
import {
  RE_SLUG,
  RE_REQ_ID,
  RE_TASK_ID,
  RE_CLAIM_ID,
  RE_ASSUMPTION_ID,
  RE_DECISION_ID,
  RE_COMPONENT_ID,
  RE_INTERFACE_ID,
  RE_TEST_ID,
  RE_SUITE_ID,
  RE_WORK_ITEM_ID,
  RE_EVENT_ID,
  RE_RUN_ID,
  RE_CHECKPOINT_ID,
  SlugSchema,
  formatReqId,
  formatTaskId,
  formatClaimId,
  formatAssumptionId,
  formatDecisionId,
  formatComponentId,
  formatInterfaceId,
  formatTestId,
  formatSuiteId,
  formatCheckpointId,
  parseSerial,
  slugify,
  isReqId,
  isTaskId,
  isSlug,
  AccountIdSchema,
  ExecutorInstanceIdSchema,
  isAccountId,
  isExecutorInstanceId,
} from '../../src/core/ids.js';
import type { Slug } from '../../src/core/ids.js';
import { IdError } from '../../src/errors.js';

const SLUG: Slug = SlugSchema.parse('auth-flow');

describe('RE_REQ_ID', () => {
  it('is byte-identical to BUILD_PROMPT.md §4', () => {
    expect(RE_REQ_ID.source).toBe('^REQ-[a-z0-9-]+-\\d+$');
    expect(RE_REQ_ID.flags).toBe('');
  });
});

const FAMILIES = [
  { name: 'req', re: RE_REQ_ID, format: formatReqId },
  { name: 'task', re: RE_TASK_ID, format: formatTaskId },
  { name: 'claim', re: RE_CLAIM_ID, format: formatClaimId },
  { name: 'assumption', re: RE_ASSUMPTION_ID, format: formatAssumptionId },
  { name: 'decision', re: RE_DECISION_ID, format: formatDecisionId },
  { name: 'component', re: RE_COMPONENT_ID, format: formatComponentId },
  { name: 'interface', re: RE_INTERFACE_ID, format: formatInterfaceId },
  { name: 'test', re: RE_TEST_ID, format: formatTestId },
  { name: 'suite', re: RE_SUITE_ID, format: formatSuiteId },
  { name: 'checkpoint', re: RE_CHECKPOINT_ID, format: formatCheckpointId },
] as const;

describe('serial id families: format -> regex -> parseSerial round trip', () => {
  for (const family of FAMILIES) {
    it(`${family.name}: round-trips`, () => {
      const id = family.format(SLUG, 3);
      expect(family.re.test(id)).toBe(true);
      const parsed = parseSerial(id);
      expect(parsed.slug).toBe(SLUG);
      expect(parsed.n).toBe(3);
    });

    it(`${family.name}: throws IdError for n < 1`, () => {
      expect(() => family.format(SLUG, 0)).toThrow(IdError);
      expect(() => family.format(SLUG, -1)).toThrow(IdError);
    });

    it(`${family.name}: throws IdError for a non-integer n`, () => {
      expect(() => family.format(SLUG, 1.5)).toThrow(IdError);
    });
  }
});

describe('family regexes reject malformed ids', () => {
  for (const family of FAMILIES) {
    it(`${family.name}: rejects uppercase`, () => {
      const id = family.format(SLUG, 1).toUpperCase();
      expect(family.re.test(id)).toBe(false);
    });

    it(`${family.name}: rejects spaces`, () => {
      const id = family.format(SLUG, 1).replace('-', ' ');
      expect(family.re.test(id)).toBe(false);
    });

    it(`${family.name}: rejects an empty slug`, () => {
      const id = family.format(SLUG, 1).replace(SLUG, '');
      expect(family.re.test(id)).toBe(false);
    });
  }
});

describe('RE_SLUG', () => {
  it('accepts a well-formed slug', () => {
    expect(RE_SLUG.test('auth-flow-2')).toBe(true);
  });
  it('rejects uppercase, leading/trailing hyphens, and empty', () => {
    expect(RE_SLUG.test('Auth-Flow')).toBe(false);
    expect(RE_SLUG.test('-auth-flow')).toBe(false);
    expect(RE_SLUG.test('auth-flow-')).toBe(false);
    expect(RE_SLUG.test('')).toBe(false);
  });
});

describe('RE_WORK_ITEM_ID, RE_EVENT_ID, RE_RUN_ID', () => {
  it('accept well-formed examples', () => {
    expect(RE_WORK_ITEM_ID.test('wi-auth-flow-a3f9k2')).toBe(true);
    expect(RE_EVENT_ID.test('evt-01234567-89ab-cdef-0123-456789abcdef')).toBe(true);
    expect(RE_RUN_ID.test('run-01234567-89ab-cdef-0123-456789abcdef')).toBe(true);
  });
  it('reject malformed examples', () => {
    expect(RE_WORK_ITEM_ID.test('wi-Auth-a3f9k2')).toBe(false);
    expect(RE_EVENT_ID.test('evt-not-a-uuid')).toBe(false);
    expect(RE_RUN_ID.test('run-not-a-uuid')).toBe(false);
  });
});

describe('isReqId / isTaskId / isSlug', () => {
  it('narrow correctly', () => {
    expect(isReqId(formatReqId(SLUG, 1))).toBe(true);
    expect(isReqId('not-a-req-id')).toBe(false);
    expect(isTaskId(formatTaskId(SLUG, 1))).toBe(true);
    expect(isTaskId('not-a-task-id')).toBe(false);
    expect(isSlug(SLUG)).toBe(true);
    expect(isSlug('Not A Slug')).toBe(false);
  });
});

describe('slugify', () => {
  it('is deterministic and produces valid slugs over a fixture list', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['Auth Flow', 'auth-flow'],
      ['  leading and trailing  ', 'leading-and-trailing'],
      ['Café Déjà vu', 'cafe-deja-vu'],
      ['multiple---hyphens', 'multiple-hyphens'],
      ['CamelCaseWords', 'camelcasewords'],
      ['a_b.c/d', 'a-b-c-d'],
    ];
    for (const [input, expected] of cases) {
      expect(slugify(input)).toBe(expected);
      // deterministic: running twice yields the same result
      expect(slugify(input)).toBe(slugify(input));
      expect(RE_SLUG.test(slugify(input))).toBe(true);
    }
  });

  it('truncates to 48 characters and stays a valid slug', () => {
    const long = 'a'.repeat(100);
    const result = slugify(long);
    expect(result.length).toBeLessThanOrEqual(48);
    expect(RE_SLUG.test(result)).toBe(true);
  });

  it('throws IdError for input with no alphanumeric characters', () => {
    expect(() => slugify('日本語')).toThrow(IdError);
    expect(() => slugify('   ')).toThrow(IdError);
    expect(() => slugify('---')).toThrow(IdError);
  });
});

describe('parseSerial', () => {
  it('throws IdError for an unrecognised id', () => {
    expect(() => parseSerial('not-a-known-id-format')).toThrow(IdError);
  });
});

describe('AccountIdSchema / ExecutorInstanceIdSchema', () => {
  const SCHEMAS = [
    { name: 'AccountId', schema: AccountIdSchema, example: 'claude-personal' },
    { name: 'ExecutorInstanceId', schema: ExecutorInstanceIdSchema, example: 'cc-sonnet' },
  ] as const;

  for (const { name, schema, example } of SCHEMAS) {
    it(`${name}: accepts ${example}`, () => {
      expect(schema.safeParse(example).success).toBe(true);
    });

    it(`${name}: rejects uppercase, underscores, spaces, leading/trailing hyphens, empty, 49+ chars`, () => {
      expect(schema.safeParse('Claude-Personal').success).toBe(false);
      expect(schema.safeParse('claude_personal').success).toBe(false);
      expect(schema.safeParse('claude personal').success).toBe(false);
      expect(schema.safeParse('-claude-personal').success).toBe(false);
      expect(schema.safeParse('claude-personal-').success).toBe(false);
      expect(schema.safeParse('').success).toBe(false);
      expect(schema.safeParse('a'.repeat(49)).success).toBe(false);
    });
  }

  it('isAccountId / isExecutorInstanceId narrow correctly', () => {
    expect(isAccountId('claude-personal')).toBe(true);
    expect(isAccountId('Claude_Personal')).toBe(false);
    expect(isExecutorInstanceId('cc-sonnet')).toBe(true);
    expect(isExecutorInstanceId('cc sonnet')).toBe(false);
  });
});
