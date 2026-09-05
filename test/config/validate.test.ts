import { describe, it, expect } from 'vitest';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { validateConfig, effortRank, CLAUDE_EFFORT_ORDER, CODEX_EFFORT_ORDER } from '../../src/config/validate.js';
import { ConfigError } from '../../src/errors.js';

function validRaw(): Record<string, unknown> {
  return {
    target: { repo: '../some-project' },
    accounts: {
      'claude-personal': {},
      'codex-personal': {},
    },
    executors: {
      'cc-sonnet': { type: 'claude-code', model: 'sonnet', effort: 'medium', account: 'claude-personal' },
      'cc-opus': { type: 'claude-code', model: 'opus', effort: 'high', account: 'claude-personal' },
      'cx-high': { type: 'codex', model: 'gpt-5.2-codex', effort: 'high', account: 'codex-personal' },
      'cx-low': { type: 'codex', model: 'gpt-5.2-codex', effort: 'low', account: 'codex-personal' },
    },
    tiers: {
      'cc-sonnet': 2,
      'cc-opus': 3,
      'cx-low': 1,
      'cx-high': 3,
    },
    roles: {
      analyst: { executor: 'cx-high', maxTurns: 8, contextBudgetTokens: 40000 },
      architect: { executor: 'cx-high', maxTurns: 12, contextBudgetTokens: 90000 },
      planner: { executor: 'cx-low', maxTurns: 6, contextBudgetTokens: 50000 },
      testAuthor: { executor: 'cx-high', maxTurns: 15, contextBudgetTokens: 40000 },
      coder: { executor: 'cc-sonnet', maxTurns: 60, contextBudgetTokens: 60000 },
      reviewer: { executor: 'cc-opus', maxTurns: 10, contextBudgetTokens: 50000 },
    },
  };
}

function parse(raw: Record<string, unknown>) {
  return MienguConfigSchema.parse(raw);
}

describe('validateConfig', () => {
  it('passes a valid config', () => {
    expect(() => validateConfig(parse(validRaw()))).not.toThrow();
  });

  it('V1: fails when an executor names an undeclared account', () => {
    const raw = validRaw();
    (raw['executors'] as Record<string, Record<string, unknown>>)['cc-sonnet']['account'] =
      'codex-personel';
    expect(() => validateConfig(parse(raw))).toThrowError(
      /executor "cc-sonnet" names account "codex-personel", which is not declared under accounts:/,
    );
  });

  it('V2: fails when a role names an undeclared executor', () => {
    const raw = validRaw();
    (raw['roles'] as Record<string, Record<string, unknown>>)['coder']['executor'] = 'cc-missing';
    expect(() => validateConfig(parse(raw))).toThrowError(
      /role "coder" names executor "cc-missing", which is not declared under executors:/,
    );
  });

  it('V3: fails when an executor has no tiers entry', () => {
    const raw = validRaw();
    delete (raw['tiers'] as Record<string, unknown>)['cc-opus'];
    expect(() => validateConfig(parse(raw))).toThrowError(
      /executor "cc-opus" has no entry in tiers:/,
    );
  });

  it('V4: fails when tiers names an undeclared executor', () => {
    const raw = validRaw();
    (raw['tiers'] as Record<string, unknown>)['cc-stale'] = 1;
    expect(() => validateConfig(parse(raw))).toThrowError(
      /tiers declares "cc-stale", which is not a declared executor instance/,
    );
  });

  it('V5: fails when reviewer tier is below coder tier (acceptance criterion 8)', () => {
    const raw = validRaw();
    (raw['tiers'] as Record<string, unknown>)['cc-sonnet'] = 3;
    (raw['tiers'] as Record<string, unknown>)['cc-opus'] = 1;
    expect(() => validateConfig(parse(raw))).toThrowError(
      /reviewer model must be >= coder model — a weaker reviewer cannot refute a stronger coder/,
    );
  });

  it('V6: fails when tiers are equal, providers match, and reviewer effort is below coder effort', () => {
    const raw = validRaw();
    (raw['roles'] as Record<string, Record<string, unknown>>)['reviewer']['executor'] = 'cc-sonnet';
    (raw['roles'] as Record<string, Record<string, unknown>>)['coder']['executor'] = 'cc-opus';
    (raw['executors'] as Record<string, Record<string, unknown>>)['cc-sonnet']['effort'] = 'low';
    (raw['executors'] as Record<string, Record<string, unknown>>)['cc-opus']['effort'] = 'high';
    (raw['tiers'] as Record<string, unknown>)['cc-sonnet'] = 3;
    (raw['tiers'] as Record<string, unknown>)['cc-opus'] = 3;
    expect(() => validateConfig(parse(raw))).toThrowError(
      /reviewer effort "low" is below coder effort "high" on the same provider at the same tier/,
    );
  });

  it('V6: is skipped across providers even at equal tier', () => {
    const raw = validRaw();
    (raw['roles'] as Record<string, Record<string, unknown>>)['reviewer']['executor'] = 'cx-low';
    (raw['tiers'] as Record<string, unknown>)['cx-low'] = 3;
    expect(() => validateConfig(parse(raw))).not.toThrow();
  });

  it('V7: fails when an executor declares an effort its provider does not accept', () => {
    const raw = validRaw();
    (raw['executors'] as Record<string, Record<string, unknown>>)['cc-opus']['effort'] = 'ultra';
    expect(() => validateConfig(parse(raw))).toThrowError(
      /executor "cc-opus" declares effort "ultra", which claude-code does not accept \(low, medium, high, xhigh, max\)/,
    );
  });

  it('V8: fails when a stub instance declares a model or effort', () => {
    const raw = validRaw();
    (raw['executors'] as Record<string, unknown>)['cc-stub'] = {
      type: 'stub',
      model: 'sonnet',
      effort: null,
      account: 'claude-personal',
    };
    (raw['tiers'] as Record<string, unknown>)['cc-stub'] = 1;
    expect(() => validateConfig(parse(raw))).toThrowError(
      /executor "cc-stub" is type stub and must not declare model or effort/,
    );
  });

  it('V9: fails when an account is declared but unreferenced', () => {
    const raw = validRaw();
    (raw['accounts'] as Record<string, unknown>)['orphan-pool'] = {};
    expect(() => validateConfig(parse(raw))).toThrowError(
      /account "orphan-pool" is not referenced by any executor/,
    );
  });

  it('collects two simultaneous violations into one error naming both', () => {
    const raw = validRaw();
    (raw['executors'] as Record<string, Record<string, unknown>>)['cc-sonnet']['account'] =
      'codex-personel';
    delete (raw['tiers'] as Record<string, unknown>)['cc-opus'];
    try {
      validateConfig(parse(raw));
      throw new Error('expected validateConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('codex-personel');
      expect(message).toContain('cc-opus');
    }
  });
});

describe('effortRank', () => {
  it('ranks claude-code efforts on CLAUDE_EFFORT_ORDER', () => {
    expect(effortRank('claude-code', 'low')).toBe(CLAUDE_EFFORT_ORDER.indexOf('low'));
    expect(effortRank('claude-code', 'max')).toBe(CLAUDE_EFFORT_ORDER.indexOf('max'));
  });

  it('ranks codex efforts on CODEX_EFFORT_ORDER', () => {
    expect(effortRank('codex', 'none')).toBe(CODEX_EFFORT_ORDER.indexOf('none'));
    expect(effortRank('codex', 'xhigh')).toBe(CODEX_EFFORT_ORDER.indexOf('xhigh'));
  });

  it('returns null for null effort', () => {
    expect(effortRank('claude-code', null)).toBeNull();
  });
});
