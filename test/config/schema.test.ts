import { describe, it, expect } from 'vitest';
import { MienguConfigSchema, CheckpointsConfigSchema } from '../../src/config/schema.js';

function validConfig(): Record<string, unknown> {
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

describe('MienguConfigSchema', () => {
  it('parses the §3.11 YAML shape', () => {
    const result = MienguConfigSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
  });

  it('accepts explicit executable arguments and environment', () => {
    const config = validConfig();
    (config['executors'] as Record<string, unknown>)['cc-sonnet'] = {
      type: 'claude-code',
      account: 'claude-personal',
      bin: 'claude',
      args: ['--settings', '/tmp/settings.json'],
      env: { CLAUDE_CONFIG_DIR: '${HOME}/.claude-work' },
    };
    const parsed = MienguConfigSchema.parse(config);
    expect(parsed.executors['cc-sonnet']?.args).toEqual(['--settings', '/tmp/settings.json']);
    expect(parsed.executors['cc-sonnet']?.env).toEqual({ CLAUDE_CONFIG_DIR: '${HOME}/.claude-work' });
  });

  it('requires target.repo', () => {
    const result = MienguConfigSchema.safeParse({ ...validConfig(), target: {} });
    expect(result.success).toBe(false);
  });

  it('asserts every default by value', () => {
    const parsed = MienguConfigSchema.parse(validConfig());
    expect(parsed).toEqual({
      target: { repo: '../some-project', mode: 'worktree', baseRef: 'HEAD' },
      oracles: { build: null, test: null, lint: null, typecheck: null },
      accounts: {
        'claude-personal': {
          maxTurnsPerItem: null,
          maxWallSecondsPerItem: null,
          maxUsdPerItem: null,
        },
        'codex-personal': {
          maxTurnsPerItem: null,
          maxWallSecondsPerItem: null,
          maxUsdPerItem: null,
        },
      },
      executors: {
        'cc-sonnet': {
          type: 'claude-code',
          model: 'sonnet',
          effort: 'medium',
          account: 'claude-personal',
          bin: null,
          args: [],
          env: {},
          permissionMode: null,
          addDirs: [],
          maxBudgetUsd: null,
          extraConfig: [],
        },
        'cc-opus': {
          type: 'claude-code',
          model: 'opus',
          effort: 'high',
          account: 'claude-personal',
          bin: null,
          args: [],
          env: {},
          permissionMode: null,
          addDirs: [],
          maxBudgetUsd: null,
          extraConfig: [],
        },
        'cx-high': {
          type: 'codex',
          model: 'gpt-5.2-codex',
          effort: 'high',
          account: 'codex-personal',
          bin: null,
          args: [],
          env: {},
          permissionMode: null,
          addDirs: [],
          maxBudgetUsd: null,
          extraConfig: [],
        },
        'cx-low': {
          type: 'codex',
          model: 'gpt-5.2-codex',
          effort: 'low',
          account: 'codex-personal',
          bin: null,
          args: [],
          env: {},
          permissionMode: null,
          addDirs: [],
          maxBudgetUsd: null,
          extraConfig: [],
        },
      },
      tiers: { 'cc-sonnet': 2, 'cc-opus': 3, 'cx-low': 1, 'cx-high': 3 },
      roles: {
        analyst: { executor: 'cx-high', maxTurns: 8, contextBudgetTokens: 40000 },
        architect: { executor: 'cx-high', maxTurns: 12, contextBudgetTokens: 90000 },
        planner: { executor: 'cx-low', maxTurns: 6, contextBudgetTokens: 50000 },
        testAuthor: { executor: 'cx-high', maxTurns: 15, contextBudgetTokens: 40000 },
        coder: { executor: 'cc-sonnet', maxTurns: 60, contextBudgetTokens: 60000 },
        reviewer: { executor: 'cc-opus', maxTurns: 10, contextBudgetTokens: 50000 },
      },
      budget: { maxWallSecondsPerInvocation: 1800, maxUsdPerRun: null },
      limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
      planner: { maxPathsPerTask: 8 },
      assumptions: { maxStackDepth: 2 },
      brownfield: {
        enabled: true,
        maxTreeEntries: 5000,
        maxFilesPerScope: 200,
        maxDependencyDepth: 2,
        maxFileBytes: 262144,
        maxTestExcerptBytes: 8192,
        maxGitCommits: 200,
        maxFilesPerCommit: 50,
        falsification: {
          maxPredicatesPerScope: 8,
          maxWallSeconds: 30,
          maxOutputBytes: 65536,
          commands: {},
          sandbox: null,
        },
      },
      checkpoints: {
        defaultOwner: 'operator',
        reversible: { slaSeconds: 86400, default: 'accept' },
        irreversible: { slaSeconds: null, default: null },
        blastRadius: {
          migrationOrSchemaPaths: [],
          sensitivePaths: [],
          externalContractPaths: [],
          protectedPaths: [],
          dependencyManifestPaths: [],
          maxDiffLines: 400,
          maxFilesTouched: 20,
          severity: {
            'migration-or-schema': 'blocking',
            'sensitive-surface': 'blocking',
            'external-contract': 'blocking',
            'protected-surface': 'blocking',
            'dependency-manifest': 'blocking',
            'diff-size': 'advisory',
          },
        },
      },
      wiki: { language: 'en' },
      locale: 'fr',
      store: { dir: '.miengu', snapshotEvery: 200 },
      log: { level: 'info' },
    });
  });

  const UNKNOWN_KEY_CASES: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['top level', { ...validConfig(), bogus: true }],
    ['target', { ...validConfig(), target: { repo: 'x', bogus: true } }],
    ['oracles', { ...validConfig(), oracles: { bogus: true } }],
    [
      'accounts.*',
      {
        ...validConfig(),
        accounts: { ...validConfig()['accounts'] as object, 'claude-personal': { bogus: true } },
      },
    ],
    [
      'executors.*',
      {
        ...validConfig(),
        executors: {
          ...validConfig()['executors'] as object,
          'cc-sonnet': { ...(validConfig()['executors'] as Record<string, object>)['cc-sonnet'], bogus: true },
        },
      },
    ],
    [
      'roles.*',
      {
        ...validConfig(),
        roles: {
          ...validConfig()['roles'] as object,
          coder: { ...(validConfig()['roles'] as Record<string, object>)['coder'], bogus: true },
        },
      },
    ],
    ['budget', { ...validConfig(), budget: { bogus: true } }],
    ['limits', { ...validConfig(), limits: { bogus: true } }],
    ['planner', { ...validConfig(), planner: { bogus: true } }],
    ['assumptions', { ...validConfig(), assumptions: { bogus: true } }],
    ['brownfield', { ...validConfig(), brownfield: { bogus: true } }],
    ['brownfield.falsification', { ...validConfig(), brownfield: { falsification: { bogus: true } } }],
    ['brownfield.falsification.commands.*', { ...validConfig(), brownfield: { falsification: { commands: { check: { bogus: true } } } } }],
    ['brownfield.falsification.sandbox', { ...validConfig(), brownfield: { falsification: { sandbox: { bogus: true } } } }],
    ['checkpoints', { ...validConfig(), checkpoints: { bogus: true } }],
    ['checkpoints.reversible', { ...validConfig(), checkpoints: { reversible: { bogus: true } } }],
    ['checkpoints.blastRadius', { ...validConfig(), checkpoints: { blastRadius: { bogus: true } } }],
    ['checkpoints.blastRadius.severity', { ...validConfig(), checkpoints: { blastRadius: { severity: { bogus: true } } } }],
    ['wiki', { ...validConfig(), wiki: { bogus: true } }],
    ['store', { ...validConfig(), store: { bogus: true } }],
    ['log', { ...validConfig(), log: { bogus: true } }],
  ];

  for (const [label, input] of UNKNOWN_KEY_CASES) {
    it(`rejects an unknown key at ${label}`, () => {
      const result = MienguConfigSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  }

  it('rejects target.mode outside the closed enum', () => {
    const result = MienguConfigSchema.safeParse({
      ...validConfig(),
      target: { repo: 'x', mode: 'ftp' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts target.mode: clone (declared, not implemented until the isolation provider)', () => {
    const result = MienguConfigSchema.safeParse({
      ...validConfig(),
      target: { repo: 'x', mode: 'clone' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a config carrying the Phase 1 executor: block', () => {
    const result = MienguConfigSchema.safeParse({ ...validConfig(), executor: { id: 'stub' } });
    expect(result.success).toBe(false);
  });

  it('rejects type: api-sdk', () => {
    const config = validConfig();
    (config['executors'] as Record<string, unknown>)['cc-sonnet'] = {
      type: 'api-sdk',
      model: 'sonnet',
      effort: 'medium',
      account: 'claude-personal',
    };
    const result = MienguConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects roles missing reviewer', () => {
    const config = validConfig();
    const roles = { ...(config['roles'] as Record<string, unknown>) };
    delete roles['reviewer'];
    config['roles'] = roles;
    const result = MienguConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects an account value failing RE_SLUG', () => {
    const config = validConfig();
    config['accounts'] = { ...(config['accounts'] as object), 'Claude_Personal': {} };
    const result = MienguConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects locale and wiki.language outside fr|en', () => {
    expect(
      MienguConfigSchema.safeParse({ ...validConfig(), locale: 'de' }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ ...validConfig(), wiki: { language: 'de' } }).success,
    ).toBe(false);
  });

  it('rejects non-positive or non-integer limits', () => {
    expect(
      MienguConfigSchema.safeParse({ ...validConfig(), limits: { kOracle: 0 } }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ ...validConfig(), limits: { kTest: 1.5 } }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({ ...validConfig(), limits: { kReview: -1 } }).success,
    ).toBe(false);
  });

  it('defaults checkpoints and assumptions when omitted entirely (binding decision 6)', () => {
    const parsed = MienguConfigSchema.parse(validConfig());
    expect(parsed.assumptions).toEqual({ maxStackDepth: 2 });
    expect(parsed.checkpoints.defaultOwner).toBe('operator');
    expect(parsed.checkpoints.reversible).toEqual({ slaSeconds: 86400, default: 'accept' });
    expect(parsed.checkpoints.irreversible).toEqual({ slaSeconds: null, default: null });
    expect(parsed.checkpoints.blastRadius.migrationOrSchemaPaths).toEqual([]);
    expect(parsed.checkpoints.blastRadius.sensitivePaths).toEqual([]);
    expect(parsed.checkpoints.blastRadius.externalContractPaths).toEqual([]);
    expect(parsed.checkpoints.blastRadius.protectedPaths).toEqual([]);
    expect(parsed.checkpoints.blastRadius.dependencyManifestPaths).toEqual([]);
    expect(parsed.checkpoints.blastRadius.maxDiffLines).toBe(400);
    expect(parsed.checkpoints.blastRadius.maxFilesTouched).toBe(20);
    expect(parsed.checkpoints.blastRadius.severity).toEqual({
      'migration-or-schema': 'blocking',
      'sensitive-surface': 'blocking',
      'external-contract': 'blocking',
      'protected-surface': 'blocking',
      'dependency-manifest': 'blocking',
      'diff-size': 'advisory',
    });
  });

  it('defaults the bounded brownfield block with no process predicate configuration', () => {
    const parsed = MienguConfigSchema.parse(validConfig());
    expect(parsed.brownfield).toEqual({
      enabled: true,
      maxTreeEntries: 5000,
      maxFilesPerScope: 200,
      maxDependencyDepth: 2,
      maxFileBytes: 262144,
      maxTestExcerptBytes: 8192,
      maxGitCommits: 200,
      maxFilesPerCommit: 50,
      falsification: {
        maxPredicatesPerScope: 8,
        maxWallSeconds: 30,
        maxOutputBytes: 65536,
        commands: {},
        sandbox: null,
      },
    });
  });

  it('requires non-empty command argv and nonnegative dependency depth', () => {
    expect(
      MienguConfigSchema.safeParse({
        ...validConfig(),
        brownfield: { falsification: { commands: { check: { argv: [] } } } },
      }).success,
    ).toBe(false);
    expect(
      MienguConfigSchema.safeParse({
        ...validConfig(),
        brownfield: { maxDependencyDepth: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('CheckpointsConfigSchema', () => {
  it('binding decision 7: default: reject is refused at parse, naming neither accept nor null', () => {
    const result = CheckpointsConfigSchema.safeParse({
      reversible: { slaSeconds: 86400, default: 'reject' },
    });
    expect(result.success).toBe(false);
  });

  it('binding decision 7: irreversible.default: reject is refused at parse', () => {
    const result = CheckpointsConfigSchema.safeParse({
      irreversible: { slaSeconds: null, default: 'reject' },
    });
    expect(result.success).toBe(false);
  });
});
