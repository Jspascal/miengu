import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { ConfigError } from '../errors.js';
import type { LoadedConfig } from '../config/load.js';
import type { ExecutorType } from '../core/events.js';

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function expandExecutorEnv(
  configured: Readonly<Record<string, string>>,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const expanded: Record<string, string> = {};
  for (const [key, value] of Object.entries(configured)) {
    expanded[key] = value.replace(ENV_REFERENCE, (_match, name: string) => {
      const replacement = inherited[name];
      if (replacement === undefined) {
        throw new ConfigError(`executor environment ${key} references unset variable ${name}`);
      }
      return replacement;
    });
  }
  return expanded;
}

function executableFor(type: ExecutorType, configured: string | null): string {
  if (configured !== null) return configured;
  return type === 'claude-code' ? 'claude' : type === 'codex' ? 'codex' : '';
}

async function isExecutable(command: string, configDir: string, pathValue: string): Promise<boolean> {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(configDir, command)]
    : pathValue.split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

/** Fails before an item is minted, so a missing shell alias cannot burn retry budgets. */
export async function assertExecutorCommandsAvailable(loaded: LoadedConfig): Promise<void> {
  const configDir = dirname(loaded.configPath);
  const checked = new Set<string>();
  for (const [id, instance] of Object.entries(loaded.config.executors)) {
    if (instance === undefined) continue;
    if (instance.type === 'stub') continue;
    const command = executableFor(instance.type, instance.bin);
    const env = { ...process.env, ...expandExecutorEnv(instance.env) };
    const pathValue = env['PATH'] ?? '';
    const key = `${command}\0${pathValue}`;
    if (checked.has(key)) continue;
    checked.add(key);
    if (!(await isExecutable(command, configDir, pathValue))) {
      throw new ConfigError(
        `executor "${id}" command "${command}" was not found or is not executable; shell aliases are not visible to Miengu. Configure a real executable with args/env (for claude-work: bin: claude and env: { CLAUDE_CONFIG_DIR: "\${HOME}/.claude-work" })`,
        { executorId: id, command },
      );
    }
  }
}
