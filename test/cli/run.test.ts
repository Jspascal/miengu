import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * A stub-only config, declared exactly like `test/executors/registry.test.ts`'s fixture:
 * every role bound to a `type: stub` instance. Unlike Phase 1's single-executor `stub`, a
 * config-declared stub instance always runs `StubExecutor`'s DEFAULT script, whose per-stage
 * artifacts satisfy both the §4 contracts and the mechanical checks — so a stub-only CLI run
 * advances through all six role stages to `done`, exactly as BUILD_PROMPT §11's Phase 1
 * criterion requires, while exercising the full CLI machinery (registry construction,
 * workspace, lock, budget, snapshot, lock-release-on-every-path) without a vendor binary.
 */
function stubOnlyConfigYaml(repo: string): string {
  return [
    'target:',
    `  repo: ${repo}`,
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
  ].join('\n');
}

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
  await writeFile(configPath, stubOnlyConfigYaml(targetRepo), 'utf8');
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
    expect(raw).toContain('WorkItemCompleted');
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

  it('creates the item support directories, including brownfield evidence', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    await runCommand({ prdFile, configPath });

    const storeDir = join(workDir, '.miengu');
    const [itemId] = await listItemIds(storeDir);
    expect(itemId).toBeDefined();
    if (itemId === undefined) {
      return;
    }
    const itemDir = itemPaths(storeDir, itemId).itemDir;
    const { stat } = await import('node:fs/promises');
    await expect(stat(join(itemDir, 'prompts'))).resolves.toBeDefined();
    await expect(stat(join(itemDir, 'schemas'))).resolves.toBeDefined();
    await expect(stat(join(itemDir, 'messages'))).resolves.toBeDefined();
    await expect(stat(join(itemDir, 'frozen-tests'))).resolves.toBeDefined();
    await expect(stat(join(itemDir, 'brownfield'))).resolves.toBeDefined();
  });

  it('isolates a valid-but-empty sibling log as unusable instead of crashing the brownfield store scan', async () => {
    // A sibling item directory that was created (empty events.jsonl) but never had a
    // WorkItemCreated appended is a valid empty log. deriveStoreClaimSets cannot project an
    // item with no WorkItemCreated event, so run.ts's readStore must classify it as
    // corrupt/unusable rather than hand it to the store-wide claim projection.
    const storeDir = join(workDir, '.miengu');
    const emptySibling = join(storeDir, 'items', 'wi-empty-abc123');
    await mkdir(emptySibling, { recursive: true });
    await writeFile(join(emptySibling, 'events.jsonl'), '', 'utf8');

    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    const result = await runCommand({ prdFile, configPath });
    expect(result).toBe(EXIT.OK);

    // The valid new item still ran to completion; the empty sibling did not displace it.
    const itemIds = await listItemIds(storeDir);
    expect(itemIds).toContain('wi-empty-abc123');
    const realItem = itemIds.find((id) => id !== 'wi-empty-abc123');
    expect(realItem).toBeDefined();
    if (realItem !== undefined) {
      const raw = await readFile(itemPaths(storeDir, realItem).eventsFile, 'utf8');
      expect(raw).toContain('WorkItemCompleted');
    }
  });

  it('a config whose reviewer role names an executor lacking read-only fails before any StageEntered is appended', async () => {
    vi.resetModules();
    vi.doMock('../../src/executors/stub.js', () => {
      class NoReadOnlyStubExecutor {
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
          throw new Error('NoReadOnlyStubExecutor.run must not be called by this test');
        }
      }
      return { StubExecutor: NoReadOnlyStubExecutor };
    });

    const { runCommand: freshRunCommand } = await import('../../src/cli/commands/run.js');
    const { ConfigError: FreshConfigError } = await import('../../src/errors.js');

    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');

    // Every role in `stubOnlyConfigYaml` is `type: stub`, including the reviewer (read-only).
    // With `read-only` stripped from the mocked stub's capabilities, registry construction
    // fails on the reviewer role — before `runItem`, and therefore before any `StageEntered`,
    // is ever appended.
    await expect(freshRunCommand({ prdFile, configPath })).rejects.toBeInstanceOf(FreshConfigError);

    const storeDir = join(workDir, '.miengu');
    const itemIds = await listItemIds(storeDir);
    expect(itemIds).toHaveLength(1);
    const itemId = itemIds[0];
    expect(itemId).toBeDefined();
    if (itemId !== undefined) {
      const paths = itemPaths(storeDir, itemId);
      const raw = await readFile(paths.eventsFile, 'utf8');
      expect(raw).toContain('RunStarted');
      expect(raw).not.toContain('StageEntered');
    }

    vi.doUnmock('../../src/executors/stub.js');
    vi.resetModules();
  });
});
