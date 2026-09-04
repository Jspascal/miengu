import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { EXIT } from '../../src/cli/exit.js';
import { listItemIds, itemPaths } from '../../src/core/log.js';
import { ConfigError } from '../../src/errors.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

let targetRepo: string;
let workDir: string;
let configPath: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-cli-run-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);

  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-run-work-'));
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

describe('runCommand', () => {
  it('creates exactly one work item and runs it to completion, exit 0', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    const result = await runCommand({ prdFile, configPath });
    expect(result).toBe(EXIT.OK);

    const storeDir = join(workDir, '.miengu');
    const itemIds = await listItemIds(storeDir);
    expect(itemIds).toHaveLength(1);

    const itemId = itemIds[0];
    expect(itemId).toBeDefined();
    if (itemId === undefined) {
      return;
    }
    const paths = itemPaths(storeDir, itemId);
    const raw = await readFile(paths.eventsFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines[0] ? JSON.parse(lines[0]).type : undefined).toBe('WorkItemCreated');
    expect(JSON.parse(lines[lines.length - 1] ?? '{}').type).toBe('RunFinished');
  });

  it('does not leave the lock file held after a successful run', async () => {
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
    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it('throws ConfigError when the config file cannot be found', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    const missingConfig = join(workDir, 'does-not-exist.yaml');

    await expect(runCommand({ prdFile, configPath: missingConfig })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});
