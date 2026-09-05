import { describe, it, expect, vi } from 'vitest';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import type { MienguConfig } from '../../src/config/schema.js';
import { STAGES } from '../../src/core/events.js';
import { roleForStage } from '../../src/state/workitem.js';
import { policyFromConfig } from '../../src/supervisor/nextStage.js';

const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

function baseConfigInput(): Record<string, unknown> {
  return {
    target: { repo: '../some-project' },
    accounts: {
      'claude-personal': {},
      'codex-personal': {},
    },
    executors: {
      'cc-sonnet': {
        type: 'claude-code',
        model: 'sonnet',
        effort: 'medium',
        account: 'claude-personal',
      },
      'cc-opus': {
        type: 'claude-code',
        model: 'opus',
        effort: 'high',
        account: 'claude-personal',
      },
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
    limits: { kOracle: 3, kTest: 3, kReview: 2, maxAttemptsPerStage: 3 },
  };
}

function baseConfig(): MienguConfig {
  return MienguConfigSchema.parse(baseConfigInput());
}

function deps() {
  return {
    paths: { transcriptsDir: '/tmp/miengu-transcripts', messagesDir: '/tmp/miengu-messages' },
    clock: fixedClock(START),
    ids: createIdMinter(fixedRng('registry-test')),
    logger: silentLogger,
  };
}

describe('buildExecutorRegistry', () => {
  it('builds all six role handles from the example config', async () => {
    const { buildExecutorRegistry } = await import('../../src/executors/registry.js');
    const registry = buildExecutorRegistry({ config: baseConfig(), ...deps() });
    expect(registry.handles).toHaveLength(6);
    const roles = registry.handles.map((h) => h.role).sort();
    expect(roles).toEqual(
      ['analyst', 'architect', 'coder', 'planner', 'reviewer', 'testAuthor'].sort(),
    );
  });

  it("forRole('coder') resolves to the configured instance and account", async () => {
    const { buildExecutorRegistry } = await import('../../src/executors/registry.js');
    const registry = buildExecutorRegistry({ config: baseConfig(), ...deps() });
    const handle = registry.forRole('coder');
    expect(handle.executor.id).toBe('cc-sonnet');
    expect(handle.executor.account).toBe('claude-personal');
  });

  it('two roles pointing at the same instance name get two distinct adapter objects that agree on id and account', async () => {
    const { buildExecutorRegistry } = await import('../../src/executors/registry.js');
    const registry = buildExecutorRegistry({ config: baseConfig(), ...deps() });
    const analyst = registry.forRole('analyst');
    const architect = registry.forRole('architect');
    expect(analyst.executor).not.toBe(architect.executor);
    expect(analyst.executor.id).toBe(architect.executor.id);
    expect(analyst.executor.account).toBe(architect.executor.account);
  });

  it('throws ConfigError naming the role and the intent when a provider cannot express it', async () => {
    vi.resetModules();
    vi.doMock('../../src/executors/stub.js', () => {
      class FakeStubExecutor {
        readonly id: string;
        readonly type = 'stub';
        readonly account: string;
        readonly capabilities = {
          nativeStructuredOutput: false,
          resumableSessions: false,
          sandboxModes: ['workspace-write'],
        };
        lastRun = null;
        constructor(o: { id: string; account: string }) {
          this.id = o.id;
          this.account = o.account;
        }
        run(): never {
          throw new Error('FakeStubExecutor.run must not be called by this test');
        }
      }
      return { StubExecutor: FakeStubExecutor };
    });

    const { buildExecutorRegistry } = await import('../../src/executors/registry.js');
    const { ConfigError: FreshConfigError } = await import('../../src/errors.js');

    const configInput = baseConfigInput();
    const executors = configInput['executors'] as Record<string, unknown>;
    executors['stub-analyst'] = { type: 'stub', account: 'claude-personal' };
    const roles = configInput['roles'] as Record<string, unknown>;
    roles['analyst'] = { executor: 'stub-analyst', maxTurns: 8, contextBudgetTokens: 40000 };
    const config = MienguConfigSchema.parse(configInput);

    let thrown: unknown;
    try {
      buildExecutorRegistry({ config, ...deps() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FreshConfigError);
    expect((thrown as InstanceType<typeof FreshConfigError>).message).toContain('analyst');
    expect((thrown as InstanceType<typeof FreshConfigError>).message).toContain('read-only');

    vi.doUnmock('../../src/executors/stub.js');
    vi.resetModules();
  });

  it("policyFromConfig(cfg).stageAccounts agrees with registry.accountForRole for every role stage", async () => {
    const { buildExecutorRegistry } = await import('../../src/executors/registry.js');
    const config = baseConfig();
    const registry = buildExecutorRegistry({ config, ...deps() });
    const policy = policyFromConfig(config);
    for (const stage of STAGES) {
      const role = roleForStage(stage);
      if (role === null) {
        expect(policy.stageAccounts[stage]).toBeNull();
        continue;
      }
      expect(policy.stageAccounts[stage]).toBe(registry.accountForRole(role));
    }
  });
});
