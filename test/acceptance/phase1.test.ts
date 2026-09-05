import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { initCommand } from '../../src/cli/commands/init.js';
import { runCommand } from '../../src/cli/commands/run.js';
import { replayCommand, projectFromSeq1, projectAccelerated } from '../../src/cli/commands/replay.js';
import { EXIT } from '../../src/cli/exit.js';
import { EventLog, listItemIds, itemPaths } from '../../src/core/log.js';
import { systemClock } from '../../src/core/clock.js';
import { createIdMinter, systemRng } from '../../src/core/idgen.js';
import { silentLogger } from '../../src/logging.js';
import { stateHash } from '../../src/state/stateHash.js';
import { LogCorruptError } from '../../src/errors.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function readdirSafe(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * §11 Phase 1 acceptance criterion, carried into Phase 2: a work item advances through the
 * event-sourced pipeline, produces a complete event log, and `miengu replay` reconstructs
 * identical state from events alone. The scaffold's shipped default (item 18) now points every
 * role at a real vendor executor (`claude-code`/`codex`), which this hermetic test must not
 * invoke; the config is overwritten, after `init`, with a stub-only one, matching the pattern
 * `test/cli/run.test.ts` uses. A config-declared `stub` instance runs `StubExecutor`'s default
 * script, whose per-stage artifacts satisfy both the §4 contracts and the mechanical checks, so
 * the item still advances through all six role stages to `done` — the Phase 1 criterion is
 * unchanged by Phase 2, as `Phase2 delta.md` requires ("nothing here invalidates what was
 * built").
 */
describe('Phase 1 acceptance: end-to-end against a throwaway target repo', () => {
  it('runs a work item to completion, replays identically, and survives torn/corrupt logs correctly', async () => {
    const targetRepo = await mkdtemp(join(tmpdir(), 'miengu-accept-target-'));
    const workDir = await mkdtemp(join(tmpdir(), 'miengu-accept-work-'));
    try {
      await git(targetRepo, ['init', '--initial-branch=main']);
      await git(targetRepo, ['config', 'user.email', 'test@example.com']);
      await git(targetRepo, ['config', 'user.name', 'Test']);
      await writeFile(join(targetRepo, 'README.md'), 'hello\n');
      await git(targetRepo, ['add', 'README.md']);
      await git(targetRepo, ['commit', '-m', 'initial']);

      const commitCountBefore = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();
      const worktreeListBefore = (await git(targetRepo, ['worktree', 'list'])).trim().split('\n');
      expect(worktreeListBefore).toHaveLength(1);

      // 1. `miengu init --target <targetRepo>`
      await initCommand({ dir: workDir, target: targetRepo });
      const configPath = join(workDir, 'miengu.config.yaml');
      const rendered = await readFile(configPath, 'utf8');
      expect(rendered.length).toBeGreaterThan(0);

      // 2. overwrite the scaffolded (real-vendor) config with a stub-only one, snapshotEvery: 3
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

      // 3. write a small PRD and run it
      const prdFile = join(workDir, 'prd.md');
      await writeFile(prdFile, 'PRD: build a small thing.\n', 'utf8');

      const runResult = await runCommand({ prdFile, configPath });
      expect(runResult).toBe(EXIT.OK);

      const storeDir = join(workDir, '.miengu');
      const itemIds = await listItemIds(storeDir);
      expect(itemIds).toHaveLength(1);
      const itemId = itemIds[0];
      expect(itemId).toBeDefined();
      if (itemId === undefined) {
        return;
      }
      const paths = itemPaths(storeDir, itemId);

      // item reaches stage:'done', status:'completed' — BUILD_PROMPT §11's Phase 1 criterion,
      // unchanged by Phase 2. The stub's default script returns a contract-valid artifact per
      // role stage precisely so this property survives the introduction of §4 contracts.
      const finalState = await projectFromSeq1(storeDir, itemId);
      expect(finalState.stage).toBe('done');
      expect(finalState.status).toBe('completed');

      // events.jsonl has a contiguous seq starting at 1, first event WorkItemCreated,
      // last event RunFinished
      const rawEvents = await readFile(paths.eventsFile, 'utf8');
      const lines = rawEvents.trim().split('\n');
      const parsed = lines.map((line) => JSON.parse(line) as { seq: number; type: string });
      expect(parsed.map((e) => e.seq)).toEqual(parsed.map((_e, i) => i + 1));
      expect(parsed[0]?.type).toBe('WorkItemCreated');
      expect(parsed[parsed.length - 1]?.type).toBe('RunFinished');
      expect(parsed.some((e) => e.type === 'WorkItemCompleted')).toBe(true);

      // at least one snapshot exists
      const snapshotFiles = await readdirSafe(paths.snapshotsDir);
      expect(snapshotFiles.length).toBeGreaterThan(0);

      // a worktree was created and removed; the target repo is left pristine
      const commitCountAfter = (await git(targetRepo, ['rev-list', '--count', 'HEAD'])).trim();
      expect(commitCountAfter).toBe(commitCountBefore);
      const worktreeListAfter = (await git(targetRepo, ['worktree', 'list'])).trim().split('\n');
      expect(worktreeListAfter).toHaveLength(1);

      // 4. `miengu replay <item>`: exit 0, printed hashes match
      const replayResult = await replayCommand({ itemId, configPath, json: true });
      expect(replayResult).toBe(EXIT.OK);

      const scratch = await projectFromSeq1(storeDir, itemId);
      const accelerated = await projectAccelerated(storeDir, itemId);
      expect(stateHash(scratch)).toBe(stateHash(accelerated.state));

      // 5. truncate the last half-line of events.jsonl, reopen, assert truncatedBytes > 0,
      //    and that replay still succeeds against the shortened log
      const beforeTruncate = await readFile(paths.eventsFile);
      const lastNewline = beforeTruncate.lastIndexOf(10);
      const tornLength = Math.floor((lastNewline + beforeTruncate.length) / 2);
      await writeFile(paths.eventsFile, beforeTruncate.subarray(0, tornLength));

      const runId = createIdMinter(systemRng).runId();
      const { log, truncatedBytes } = await EventLog.open({
        storeDir,
        itemId,
        runId,
        clock: systemClock,
        ids: createIdMinter(systemRng),
        logger: silentLogger,
      });
      expect(truncatedBytes).toBeGreaterThan(0);
      await log.close();

      const replayAfterTruncate = await replayCommand({ itemId, configPath, json: true });
      expect(replayAfterTruncate).toBe(EXIT.OK);

      // 6. mangle a middle line; assert replay exits 4
      const afterTruncateRaw = await readFile(paths.eventsFile, 'utf8');
      const truncatedLines = afterTruncateRaw.trim().split('\n');
      expect(truncatedLines.length).toBeGreaterThan(2);
      const middleIndex = Math.floor(truncatedLines.length / 2);
      truncatedLines[middleIndex] = 'this is not valid JSON';
      await writeFile(paths.eventsFile, `${truncatedLines.join('\n')}\n`, 'utf8');

      await expect(replayCommand({ itemId, configPath, json: true })).rejects.toBeInstanceOf(
        LogCorruptError,
      );
      await expect(replayCommand({ itemId, configPath, json: true })).rejects.toMatchObject({
        exitCode: 4,
      });
    } finally {
      await rm(targetRepo, { recursive: true, force: true });
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
