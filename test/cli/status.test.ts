import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runCommand } from '../../src/cli/commands/run.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { EXIT } from '../../src/cli/exit.js';
import { EventLog, listItemIds, itemPaths } from '../../src/core/log.js';
import { slugify } from '../../src/core/ids.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { loadConfig } from '../../src/config/load.js';

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

/** Builds an item's log directly (`WorkItemCreated` -> `RunStarted` -> optional fixture
 *  events -> `WorkItemParked`), bypassing `runCommand` entirely — the same convention
 *  `test/cli/run.backlog.test.ts`'s `makeParkedItem` uses: `status` reads the store alone,
 *  so it cannot distinguish a hand-built parked item from one a real run parked. */
async function makeParkedItem(o: {
  readonly title: string;
  readonly seed: string;
  readonly reason: 'operator-abort' | 'awaiting-human';
  readonly resumable: boolean;
  readonly beforePark?: (log: EventLog) => Promise<void>;
}): Promise<WorkItemId> {
  const loaded = await loadConfig(configPath);
  const ids = createIdMinter(fixedRng(o.seed));
  const slug = slugify(o.title);
  const itemId = ids.workItemId(slug);
  const runId = ids.runId();
  const clock = fixedClock('2024-01-01T00:00:00.000Z');
  const storeDir = join(workDir, '.miengu');

  const { log } = await EventLog.create({ storeDir, itemId, runId, clock, ids, logger: silentLogger });
  try {
    await log.append({
      type: 'WorkItemCreated',
      data: {
        title: o.title,
        slug,
        source: { kind: 'prd-file', path: `${o.title}.md`, sha256: 'a'.repeat(64), bytes: 1 },
        config_hash: loaded.configHash,
      },
      actor: { kind: 'human', id: null },
      causationId: null,
    });
    await log.append({
      type: 'RunStarted',
      data: { miengu_version: '0.1.0', node_version: process.version, config_hash: loaded.configHash, config: loaded.config },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
    if (o.beforePark !== undefined) {
      await o.beforePark(log);
    }
    await log.append({
      type: 'WorkItemParked',
      data: { reason: o.reason, detail: o.reason === 'operator-abort' ? 'sigint' : 'blocked', resumable: o.resumable, account: null, resets_at: null },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
  } finally {
    await log.close();
  }
  return itemId;
}

describe('statusCommand', () => {
  it('reports an item, exit 0', async () => {
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

  it('renders active causal attempt counters in text status', async () => {
    const prdFile = join(workDir, 'prd.md');
    await writeFile(prdFile, 'Build a thing.\n', 'utf8');
    await runCommand({ prdFile, configPath });
    const storeDir = join(workDir, '.miengu');
    const [itemId] = await listItemIds(storeDir);
    expect(itemId).toBeDefined();
    if (itemId === undefined) return;
    const ids = createIdMinter(fixedRng('status-causal-attempts'));
    const { log } = await EventLog.open({
      storeDir,
      itemId,
      runId: ids.runId(),
      clock: fixedClock('2024-01-01T00:00:00.000Z'),
      ids,
      logger: silentLogger,
    });
    try {
      const cause = await log.append({
        type: 'FailureCauseOpened',
        data: {
          trigger_event_id: log.lastEventId!, parent_cause_id: null, kind: 'agent-output', task_id: null,
          initial_level: 'reviewer', affects: { req_ids: [], component_ids: [], task_ids: [] }, summary: 'status fixture',
        },
        actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId,
      });
      await log.append({
        type: 'FailureAttempted',
        data: { cause_id: cause.event_id, task_id: null, level: 'reviewer', bucket: 'reviewer', attempt: 1, limit: 2, handler_stage: 'review' },
        actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId,
      });
    } finally {
      await log.close();
    }
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      expect(await statusCommand({ configPath })).toBe(EXIT.OK);
    } finally {
      write.mockRestore();
    }
    expect(output).toContain('CAUSE ATTEMPTS');
    expect(output).toContain('reviewer=1');
  });

  it('--json: a backlog-ready parked item reports resumable, zero open blocking checkpoints, blastRadiusDeclared false, and backlog.ready true with a null blocker', async () => {
    const itemId = await makeParkedItem({
      title: 'ready-item',
      seed: 'status-backlog-ready',
      reason: 'operator-abort',
      resumable: true,
    });

    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    let result: number;
    try {
      result = await statusCommand({ configPath, json: true });
    } finally {
      write.mockRestore();
    }
    expect(result).toBe(EXIT.OK);

    const rows = JSON.parse(output.trim()) as {
      itemId: string;
      resumable: boolean | null;
      openBlockingCheckpoints: number | null;
      blastRadiusDeclared: boolean | null;
      backlog: { ready: boolean; blocker: string | null } | null;
    }[];
    const row = rows.find((r) => r.itemId === itemId);
    expect(row).toBeDefined();
    expect(row?.resumable).toBe(true);
    expect(row?.openBlockingCheckpoints).toBe(0);
    expect(row?.blastRadiusDeclared).toBe(false);
    expect(row?.backlog).toEqual({ ready: true, blocker: null });
  });

  it('--json and text: a parked item blocked on an open blocking checkpoint reports resumable, a non-zero openBlockingCheckpoints, and backlog.ready false with a non-null blocker; the text BACKLOG column names it', async () => {
    const itemId = await makeParkedItem({
      title: 'blocked-item',
      seed: 'status-backlog-blocked',
      reason: 'awaiting-human',
      resumable: true,
      beforePark: async (log) => {
        await log.append({
          type: 'CheckpointRaised',
          data: {
            checkpoint: 'cp-blocked-item-1',
            kind: 'irreversible',
            stage: 'architecture',
            summary: 'irreversible decision',
            blocking: true,
            sla_seconds: null,
            default_decision: null,
          },
          actor: { kind: 'supervisor', id: null },
          causationId: log.lastEventId,
        });
      },
    });

    let jsonOutput = '';
    const jsonWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      jsonOutput += String(chunk);
      return true;
    });
    let jsonResult: number;
    try {
      jsonResult = await statusCommand({ configPath, json: true });
    } finally {
      jsonWrite.mockRestore();
    }
    expect(jsonResult).toBe(EXIT.OK);

    const rows = JSON.parse(jsonOutput.trim()) as {
      itemId: string;
      resumable: boolean | null;
      openBlockingCheckpoints: number | null;
      backlog: { ready: boolean; blocker: string | null } | null;
    }[];
    const row = rows.find((r) => r.itemId === itemId);
    expect(row).toBeDefined();
    expect(row?.resumable).toBe(true);
    expect(row?.openBlockingCheckpoints).toBe(1);
    expect(row?.backlog).toEqual({ ready: false, blocker: 'blocking-checkpoint-open' });

    let textOutput = '';
    const textWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      textOutput += String(chunk);
      return true;
    });
    try {
      expect(await statusCommand({ configPath })).toBe(EXIT.OK);
    } finally {
      textWrite.mockRestore();
    }
    expect(textOutput).toContain('BACKLOG');
    const itemLine = textOutput.split('\n').find((line) => line.startsWith(itemId));
    expect(itemLine).toContain('blocking-checkpoint-open');
  });
});
