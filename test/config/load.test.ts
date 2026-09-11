import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { ConfigError } from '../../src/errors.js';
import { CONFIG_TEMPLATE } from '../../src/config/scaffold.js';

describe('loadConfig', () => {
  it('finds the config by walking upward from a nested cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      const nested = join(root, 'a', 'b', 'c');
      await mkdir(nested, { recursive: true });
      await writeFile(join(root, 'miengu.config.yaml'), CONFIG_TEMPLATE, 'utf8');

      const loaded = await loadConfig(undefined, nested);
      expect(loaded.configPath).toBe(join(root, 'miengu.config.yaml'));
      expect(loaded.config.target.repo).toBe('../some-project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves storeDir and targetRepo to absolute paths without mutating config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      await writeFile(join(root, 'miengu.config.yaml'), CONFIG_TEMPLATE, 'utf8');

      const loaded = await loadConfig(undefined, root);
      expect(loaded.config.target.repo).toBe('../some-project');
      expect(loaded.config.store.dir).toBe('.miengu');
      expect(loaded.storeDir).toBe(join(root, '.miengu'));
      expect(loaded.targetRepo).toBe(join(root, '..', 'some-project'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces a stable configHash independent of key order in the YAML source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      await writeFile(join(root, 'miengu.config.yaml'), CONFIG_TEMPLATE, 'utf8');
      const loadedA = await loadConfig(undefined, root);

      const reordered = 'locale: fr\n' + CONFIG_TEMPLATE.replace('locale: fr\n', '');
      await writeFile(join(root, 'miengu.config.yaml'), reordered, 'utf8');
      const loadedB = await loadConfig(undefined, root);

      expect(loadedA.configHash).toBe(loadedB.configHash);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a config that parses but fails V5 with exit code 3', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      const badTiers = CONFIG_TEMPLATE.replace('cc-sonnet: 2', 'cc-sonnet: 3').replace(
        'cc-opus:   3',
        'cc-opus:   1',
      );
      await writeFile(join(root, 'miengu.config.yaml'), badTiers, 'utf8');

      await expect(loadConfig(undefined, root)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).exitCode).toBe(3);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces a byte-identical configHash for a fixture config, unaffected by adding validateConfig', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      await writeFile(join(root, 'miengu.config.yaml'), CONFIG_TEMPLATE, 'utf8');
      const loaded = await loadConfig(undefined, root);
      expect(loaded.configHash).toBe(
        '37dbca0342fbe1bed23a9f19c56d1b215ad842605f4fcd412dd20d360cbc3058',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws ConfigError listing every path searched when not found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      const nested = join(root, 'x', 'y');
      await mkdir(nested, { recursive: true });

      await expect(loadConfig(undefined, nested)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ConfigError);
        const message = (error as ConfigError).message;
        expect(message).toContain(join(nested, 'miengu.config.yaml'));
        expect(message).toContain(join(root, 'miengu.config.yaml'));
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws ConfigError naming the explicit path when it does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      const explicit = join(root, 'does-not-exist.yaml');
      await expect(loadConfig(explicit, root)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain(explicit);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws ConfigError with one issue path per line on schema failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-load-'));
    try {
      await writeFile(join(root, 'miengu.config.yaml'), 'oracles:\n  bogus: true\n', 'utf8');
      await expect(loadConfig(undefined, root)).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(ConfigError);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
