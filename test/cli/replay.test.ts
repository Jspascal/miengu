import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { replayCommand } from '../../src/cli/commands/replay.js';
import { EXIT } from '../../src/cli/exit.js';
import { listItemIds, itemPaths } from '../../src/core/log.js';
import type { WorkItemId } from '../../src/core/ids.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

let targetRepo: string;
let workDir: string;
let configPath: string;

beforeEach(async () => {
  targetRepo = await mkdtemp(join(tmpdir(), 'miengu-cli-replay-target-'));
  await git(targetRepo, ['init', '--initial-branch=main']);
  await git(targetRepo, ['config', 'user.email', 'test@example.com']);
  await git(targetRepo, ['config', 'user.name', 'Test']);
  await writeFile(join(targetRepo, 'README.md'), 'hello\n');
  await git(targetRepo, ['add', 'README.md']);
  await git(targetRepo, ['commit', '-m', 'initial']);

  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-replay-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(
    configPath,
    [
      'target:',
      `  repo: ${targetRepo}`,
      'accounts:',
      '  stub-account: {}',
      'executors:',
      '  stub-analyst: { type: stub, account: stub-account }',
      '  stub-architect: { type: stub, account: stub-account }',
      '  stub-planner: { type: stub, account: stub-account }',
      '  stub-testauthor: { type: stub, account: stub-account }',
      '  stub-coder: { type: stub, account: stub-account }',
      '  stub-reviewer: { type: stub, account: stub-account }',
      'tiers:',
      '  stub-analyst: 1',
      '  stub-architect: 1',
      '  stub-planner: 1',
      '  stub-testauthor: 1',
      '  stub-coder: 1',
      '  stub-reviewer: 1',
      'roles:',
      '  analyst: { executor: stub-analyst, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  architect: { executor: stub-architect, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  planner: { executor: stub-planner, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  testAuthor: { executor: stub-testauthor, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  coder: { executor: stub-coder, maxTurns: 8, contextBudgetTokens: 40000 }',
      '  reviewer: { executor: stub-reviewer, maxTurns: 8, contextBudgetTokens: 40000 }',
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

async function runOneItem(): Promise<WorkItemId> {
  const prdFile = join(workDir, 'prd.md');
  await writeFile(prdFile, 'Build a thing.\n', 'utf8');
  await runCommand({ prdFile, configPath });
  const storeDir = join(workDir, '.miengu');
  const [itemId] = await listItemIds(storeDir);
  if (itemId === undefined) {
    throw new Error('expected exactly one item after runCommand');
  }
  return itemId;
}

describe('replayCommand', () => {
  it('exits 0 and the two hashes match for a healthy log', async () => {
    const itemId = await runOneItem();
    const result = await replayCommand({ itemId, configPath, json: true });
    expect(result).toBe(EXIT.OK);
  });

  it('does not acquire the write lock', async () => {
    const itemId = await runOneItem();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    await replayCommand({ itemId, configPath, json: true });

    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });

  it('does not write any event or snapshot into the item directory', async () => {
    const itemId = await runOneItem();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);
    const before = await readFile(paths.eventsFile, 'utf8');

    await replayCommand({ itemId, configPath, json: true });

    const after = await readFile(paths.eventsFile, 'utf8');
    expect(after).toBe(before);
  });

  it('succeeds against a log with a torn final line, truncated in memory only', async () => {
    const itemId = await runOneItem();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile);
    const torn = raw.subarray(0, raw.length - 10);
    await writeFile(paths.eventsFile, torn);

    const result = await replayCommand({ itemId, configPath, json: true });
    expect(result).toBe(EXIT.OK);
  });

  it('exits 4 when a complete middle line is corrupted', async () => {
    const itemId = await runOneItem();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    const middleIndex = Math.floor(lines.length / 2);
    lines[middleIndex] = 'not valid json for this line';
    await writeFile(paths.eventsFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(replayCommand({ itemId, configPath, json: true })).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it('exits 4 against a log carrying a v1 schema_version line (the clean break, observable)', async () => {
    const itemId = await runOneItem();
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    const raw = await readFile(paths.eventsFile, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThan(2);
    const firstLine = JSON.parse(lines[0] ?? '{}') as { schema_version: number };
    expect(firstLine.schema_version).toBe(2);
    firstLine.schema_version = 1;
    lines[0] = JSON.stringify(firstLine);
    await writeFile(paths.eventsFile, `${lines.join('\n')}\n`, 'utf8');

    await expect(replayCommand({ itemId, configPath, json: true })).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});
