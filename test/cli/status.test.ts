import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { EXIT } from '../../src/cli/exit.js';
import { listItemIds, itemPaths } from '../../src/core/log.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

let targetRepo: string;
let workDir: string;
let configPath: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-cli-status-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);

  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-status-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(
    configPath,
    [
      'target:',
      `  repo: ${targetRepo}`,
      'executor:',
      '  id: stub',
      'store:',
      '  dir: .miengu',
      '  snapshotEvery: 3',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(targetRepo, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

describe('statusCommand', () => {
  it('reports a completed item, exit 0', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    await runCommand({ prdFile, configPath });

    const result = await statusCommand({ configPath, json: true });
    expect(result).toBe(EXIT.OK);
  });

  it('does not acquire the write lock', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    await runCommand({ prdFile, configPath });

    const storeDir = join(workDir, '.miengu');
    const [itemId] = await listItemIds(storeDir);
    expect(itemId).toBeDefined();
    if (itemId === undefined) {
      return;
    }
    const paths = itemPaths(storeDir, itemId);

    await statusCommand({ configPath, json: true });

    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it('reports one corrupt item as CORRUPT without failing the whole command, exit 4', async () => {
    const prdFileA = join(workDir, 'prd-a.md');
    await writeFile(prdFileA, 'Build thing A.\n', 'utf8');
    await runCommand({ prdFile: prdFileA, configPath });

    const prdFileB = join(workDir, 'prd-b.md');
    await writeFile(prdFileB, 'Build thing B.\n', 'utf8');
    await runCommand({ prdFile: prdFileB, configPath });

    const storeDir = join(workDir, '.miengu');
    const itemIds = await listItemIds(storeDir);
    expect(itemIds).toHaveLength(2);
    const corruptItemId = itemIds[0];
    expect(corruptItemId).toBeDefined();
    if (corruptItemId === undefined) {
      return;
    }
    const paths = itemPaths(storeDir, corruptItemId);
    await appendFile(paths.eventsFile, 'not json at all\n', 'utf8');

    const result = await statusCommand({ configPath, json: true });
    expect(result).toBe(EXIT.STORE);
  });
});
