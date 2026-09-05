import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../../errors.js';
import { renderConfigTemplate } from '../../config/scaffold.js';
import { CONFIG_FILENAME, MienguConfigSchema } from '../../config/schema.js';
import { validateConfig } from '../../config/validate.js';
import { EXIT } from '../exit.js';

export interface InitCommandOptions {
  readonly dir?: string | undefined;
  readonly target?: string | undefined;
  readonly force?: boolean | undefined;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `miengu.config.yaml` into `dir` (default cwd) from `renderConfigTemplate`. Refuses to
 * overwrite an existing file without `--force`. Never writes into `target.repo`, never creates
 * a `.miengu/` store, never runs git.
 */
export async function initCommand(options: InitCommandOptions): Promise<number> {
  const targetDir = resolve(options.dir ?? '.');
  const configPath = join(targetDir, CONFIG_FILENAME);

  if (options.force !== true && (await fileExists(configPath))) {
    throw new ConfigError(
      `config file already exists: ${configPath} (use --force to overwrite)`,
      { configPath },
    );
  }

  const targetRepo = options.target ?? '../some-project';
  const rendered = renderConfigTemplate({ targetRepo });

  // Validate what we are about to write before touching the filesystem.
  validateConfig(MienguConfigSchema.parse(parseYaml(rendered)));

  await mkdir(targetDir, { recursive: true });
  await writeFile(configPath, rendered, 'utf8');

  // Validate what was actually written, by re-parsing it from disk.
  const written = await readFile(configPath, 'utf8');
  validateConfig(MienguConfigSchema.parse(parseYaml(written)));

  return EXIT.OK;
}
