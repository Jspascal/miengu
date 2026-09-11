import { describe, expect, it } from 'vitest';
import { MienguConfigSchema } from '../../src/config/schema.js';
import type { LoadedConfig } from '../../src/config/load.js';
import { ConfigError } from '../../src/errors.js';
import { assertExecutorCommandsAvailable, expandExecutorEnv } from '../../src/executors/processConfig.js';

function loadedWithBin(bin: string): LoadedConfig {
  const executor = { type: 'claude-code' as const, account: 'primary', bin };
  const config = MienguConfigSchema.parse({
    target: { repo: '.' },
    accounts: { primary: {} },
    executors: { claude: executor },
    tiers: { claude: 1 },
    roles: {
      analyst: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
      architect: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
      planner: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
      testAuthor: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
      coder: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
      reviewer: { executor: 'claude', maxTurns: 1, contextBudgetTokens: 100 },
    },
  });
  return {
    config,
    configHash: 'hash',
    configPath: '/tmp/miengu.config.yaml',
    storeDir: '/tmp/.miengu',
    targetRepo: '/tmp',
  };
}

describe('executor process configuration', () => {
  it('expands explicit inherited environment references', () => {
    expect(expandExecutorEnv(
      { CLAUDE_CONFIG_DIR: '${HOME}/.claude-work' },
      { HOME: '/users/example' },
    )).toEqual({ CLAUDE_CONFIG_DIR: '/users/example/.claude-work' });
  });

  it('fails before a run when bin names a shell alias instead of an executable', async () => {
    await expect(assertExecutorCommandsAvailable(loadedWithBin('missing-miengu-shell-alias')))
      .rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as Error).message).toContain('shell aliases are not visible');
        return true;
      });
  });

  it('accepts an executable absolute path', async () => {
    await expect(assertExecutorCommandsAvailable(loadedWithBin(process.execPath))).resolves.toBeUndefined();
  });
});
