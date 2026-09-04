import { describe, it, expect } from 'vitest';
import { MienguConfigSchema } from '../../src/config/schema.js';

describe('MienguConfigSchema', () => {
  it('parses a minimal file with only target.repo', () => {
    const result = MienguConfigSchema.safeParse({ target: { repo: '../some-project' } });
    expect(result.success).toBe(true);
  });

  it('requires target.repo', () => {
    const result = MienguConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('asserts every default by value', () => {
    const parsed = MienguConfigSchema.parse({ target: { repo: '../some-project' } });
    expect(parsed).toEqual({
      target: { repo: '../some-project', mode: 'worktree', baseRef: 'HEAD' },
      oracles: { build: null, test: null, lint: null, typecheck: null },
      executor: {
        id: 'stub',
        claudeCode: {
          bin: 'claude',
          model: null,
          permissionMode: 'acceptEdits',
          outputFormat: 'stream-json',
          addDirs: [],
          maxBudgetUsd: null,
        },
      },
      budget: {
        maxTurnsPerTask: 40,
        maxWallSecondsPerTask: 1800,
        maxUsdPerRun: null,
        maxWallSecondsPerRun: null,
      },
      limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
      wiki: { language: 'en' },
      locale: 'fr',
      store: { dir: '.miengu', snapshotEvery: 200 },
      log: { level: 'info' },
    });
  });

  const UNKNOWN_KEY_CASES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['top level', { target: { repo: 'x' }, bogus: true }],
    ['target', { target: { repo: 'x', bogus: true } }],
    ['oracles', { target: { repo: 'x' }, oracles: { bogus: true } }],
    ['executor', { target: { repo: 'x' }, executor: { bogus: true } }],
    [
      'executor.claudeCode',
      { target: { repo: 'x' }, executor: { claudeCode: { bogus: true } } },
    ],
    ['budget', { target: { repo: 'x' }, budget: { bogus: true } }],
    ['limits', { target: { repo: 'x' }, limits: { bogus: true } }],
    ['wiki', { target: { repo: 'x' }, wiki: { bogus: true } }],
    ['store', { target: { repo: 'x' }, store: { bogus: true } }],
    ['log', { target: { repo: 'x' }, log: { bogus: true } }],
  ];

  for (const [label, input] of UNKNOWN_KEY_CASES) {
    it(`rejects an unknown key at ${label}`, () => {
      const result = MienguConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  }

  it('rejects target.mode outside the closed enum', () => {
    const result = MienguConfigSchema.safeParse({ target: { repo: 'x', mode: 'ftp' } });
    expect(result.success).toBe(false);
  });

  it('accepts target.mode: clone (declared, not implemented until the isolation provider)', () => {
    const result = MienguConfigSchema.safeParse({ target: { repo: 'x', mode: 'clone' } });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown executor.id', () => {
    const result = MienguConfigSchema.safeParse({
      target: { repo: 'x' },
      executor: { id: 'gpt' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects locale and wiki.language outside fr|en', () => {
    expect(
      MienguConfigSchema.safeParse({ target: { repo: 'x' }, locale: 'de' }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ target: { repo: 'x' }, wiki: { language: 'de' } }).success,
    ).toBe(false);
  });

  it('rejects non-positive or non-integer limits', () => {
    expect(
      MienguConfigSchema.safeParse({ target: { repo: 'x' }, limits: { kOracle: 0 } }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ target: { repo: 'x' }, limits: { kTest: 1.5 } }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ target: { repo: 'x' }, limits: { kReview: -1 } }).success,
    ).toBe(false);
  });
});
