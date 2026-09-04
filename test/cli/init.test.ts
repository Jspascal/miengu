import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { initCommand } from '../../src/cli/commands/init.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { ConfigError } from '../../src/errors.js';
import { EXIT } from '../../src/cli/exit.js';

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('initCommand', () => {
  it('writes miengu.config.yaml into dir (default cwd) with the given target', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-init-'));
    try {
      const result = await initCommand({ dir, target: '/abs/path/to/target' });
      expect(result).toBe(EXIT.OK);

      const configPath = join(dir, 'miengu.config.yaml');
      const contents = await readFile(configPath, 'utf8');
      const parsed = MienguConfigSchema.parse(parseYaml(contents));
      expect(parsed.target.repo).toBe('/abs/path/to/target');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing config file without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-init-'));
    try {
      await initCommand({ dir, target: '/abs/path/to/target' });
      await expect(initCommand({ dir, target: '/other/target' })).rejects.toBeInstanceOf(
        ConfigError,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('overwrites an existing config file with --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-init-'));
    try {
      await initCommand({ dir, target: '/abs/path/to/target' });
      const result = await initCommand({ dir, target: '/new/target', force: true });
      expect(result).toBe(EXIT.OK);

      const configPath = join(dir, 'miengu.config.yaml');
      const contents = await readFile(configPath, 'utf8');
      const parsed = MienguConfigSchema.parse(parseYaml(contents));
      expect(parsed.target.repo).toBe('/new/target');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never writes into the target repo and never creates a .miengu store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-init-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'miengu-init-target-'));
    try {
      await initCommand({ dir, target: targetDir });
      expect(await pathExists(join(targetDir, 'miengu.config.yaml'))).toBe(false);
      expect(await pathExists(join(dir, '.miengu'))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it('defaults the target repo to the scaffold placeholder when --target is omitted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'miengu-init-'));
    try {
      await initCommand({ dir });
      const contents = await readFile(join(dir, 'miengu.config.yaml'), 'utf8');
      const parsed = MienguConfigSchema.parse(parseYaml(contents));
      expect(parsed.target.repo).toBe('../some-project');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
