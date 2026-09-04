import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../errors.js';
import { sha256Canonical } from '../core/hash.js';
import { CONFIG_FILENAME, MienguConfigSchema } from './schema.js';
import type { MienguConfig } from './schema.js';

export interface LoadedConfig {
  readonly config: MienguConfig;
  readonly configHash: string;
  readonly configPath: string;
  readonly storeDir: string;
  readonly targetRepo: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findConfigPath(explicitPath: string | undefined, cwd: string): Promise<{
  configPath: string | null;
  searched: string[];
}> {
  const searched: string[] = [];

  if (explicitPath !== undefined) {
    const resolved = resolve(cwd, explicitPath);
    searched.push(resolved);
    return { configPath: (await fileExists(resolved)) ? resolved : null, searched };
  }

  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    searched.push(candidate);
    if (await fileExists(candidate)) {
      return { configPath: candidate, searched };
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return { configPath: null, searched };
    }
    dir = parent;
  }
}

export async function loadConfig(
  explicitPath?: string,
  cwd: string = process.cwd(),
): Promise<LoadedConfig> {
  const { configPath, searched } = await findConfigPath(explicitPath, cwd);

  if (configPath === null) {
    throw new ConfigError(
      [
        'miengu config not found. Searched:',
        ...searched,
        'Run `miengu init` to create one.',
      ].join('\n'),
      { searched },
    );
  }

  const raw = await readFile(configPath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = MienguConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`invalid miengu config at ${configPath}:\n${issues}`, {
      configPath,
      issues: result.error.issues,
    });
  }

  const config = result.data;
  const configHash = sha256Canonical(config);
  const configDir = dirname(configPath);
  const storeDir = resolve(configDir, config.store.dir);
  const targetRepo = resolve(configDir, config.target.repo);

  return { config, configHash, configPath, storeDir, targetRepo };
}
