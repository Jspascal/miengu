#!/usr/bin/env node
import { Command } from 'commander';
import { WorkItemIdSchema } from '../core/ids.js';
import { initCommand } from './commands/init.js';
import { runCommand, resumeCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';
import { replayCommand } from './commands/replay.js';
import { reportCommand } from './commands/report.js';
import { decideCommand } from './commands/decide.js';
import { wikiRenderCommand } from './commands/wikiRender.js';
import { EXIT, exitCodeFor } from './exit.js';

const program = new Command();
program.name('miengu').exitOverride((err) => {
  if (err.exitCode === 0) {
    throw new ProcessExit(EXIT.OK);
  }
  throw new ProcessExit(EXIT.USAGE);
});

// commander's `exitOverride` throws a `CommanderError`, not something we want to surface
// through `exitCodeFor`. This local marker lets the top-level catch below distinguish a
// usage-error exit from a genuine `MienguError`.
class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`process exit: ${String(code)}`);
  }
}

program
  .command('init')
  .argument('[dir]', 'directory to write miengu.config.yaml into (default cwd)')
  .option('--target <path>', 'target repository path')
  .option('--force', 'overwrite an existing config file')
  .action(async (dir: string | undefined, opts: { target?: string; force?: boolean }) => {
    process.exitCode = await initCommand({ dir, target: opts.target, force: opts.force });
  });

program
  .command('run')
  .argument('<prd-file>', 'path to the PRD file')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--retain-workspace', 'do not remove the worktree on exit')
  .option('--new', 'explicitly create a new item even when this PRD has an unfinished item')
  .option('--backlog', 'also resume other ready work items', false)
  .option('--no-backlog', 'run only the selected item; skip the backlog scan entirely')
  .option('--no-tui', 'use a plain live feed instead of the terminal dashboard')
  .option('--json', 'print machine-readable output')
  .action(
    async (
      prdFile: string,
      opts: { config?: string; retainWorkspace?: boolean; backlog?: boolean; json?: boolean; tui?: boolean; new?: boolean },
    ) => {
      process.exitCode = await runCommand({
        prdFile,
        configPath: opts.config,
        retainWorkspace: opts.retainWorkspace,
        noBacklog: opts.backlog !== true,
        newItem: opts.new,
        json: opts.json,
        tui: opts.tui,
      });
    },
  );

program.command('resume')
  .argument('<item>', 'existing work item id; opens its unanswered questions and continues it')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--no-tui', 'use plain output')
  .option('--json', 'print machine-readable output')
  .option('--retain-workspace', 'keep the worktree on exit')
  .action(async (item: string, opts: { config?: string; tui?: boolean; json?: boolean; retainWorkspace?: boolean }) => {
    process.exitCode = await resumeCommand({ resumeItem: WorkItemIdSchema.parse(item), configPath: opts.config, tui: opts.tui, json: opts.json, retainWorkspace: opts.retainWorkspace, noBacklog: true });
  });

program
  .command('status')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { config?: string; json?: boolean }) => {
    process.exitCode = await statusCommand({ configPath: opts.config, json: opts.json });
  });

program
  .command('replay')
  .argument('<item>', 'work item id')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--json', 'print machine-readable output')
  .action(async (item: string, opts: { config?: string; json?: boolean }) => {
    process.exitCode = await replayCommand({
      itemId: WorkItemIdSchema.parse(item),
      configPath: opts.config,
      json: opts.json,
    });
  });

program
  .command('report')
  .description('the batch review report')
  .option('--since <date>', 'report only items updated since this ISO-8601 or YYYY-MM-DD date')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { since?: string; config?: string; json?: boolean }) => {
    process.exitCode = await reportCommand({
      since: opts.since,
      configPath: opts.config,
      json: opts.json,
    });
  });

program
  .command('decide')
  .argument('<checkpoint>', 'checkpoint id')
  .argument('<decision>', 'accept|reject')
  .option('--reason <text>', 'reason for the decision')
  .option('--item <id>', 'disambiguate a checkpoint id that exists in more than one item')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--json', 'print machine-readable output')
  .action(
    async (
      checkpoint: string,
      decision: string,
      opts: { reason?: string; item?: string; config?: string; json?: boolean },
    ) => {
      process.exitCode = await decideCommand({
        checkpoint,
        decision,
        reason: opts.reason,
        item: opts.item,
        configPath: opts.config,
        json: opts.json,
      });
    },
  );

const wikiCommand = program.command('wiki').description('operate on the human-readable wiki view');

wikiCommand
  .command('render')
  .description('regenerate the human view from the log')
  .option('--config <path>', 'path to miengu.config.yaml')
  .option('--json', 'print machine-readable output')
  .action(async (opts: { config?: string; json?: boolean }) => {
    process.exitCode = await wikiRenderCommand({ configPath: opts.config, json: opts.json });
  });

// A bare `miengu wiki` names no subcommand to run, so nothing happened: print help and exit
// `EXIT.USAGE` (2) rather than silently doing nothing or exiting 0.
wikiCommand.action(() => {
  wikiCommand.outputHelp();
  process.exitCode = EXIT.USAGE;
});

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof ProcessExit) {
      process.exitCode = err.code;
      return;
    }
    // Report before exiting. §4's failure modes specify messages that name the file, line and
    // reason; an operator who gets only a bare exit code cannot act on any of them.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`miengu: ${message}\n`);
    process.exitCode = exitCodeFor(err);
  }
}

// Never `process.exit()` mid-flight: a mid-flight exit would truncate a pending fsync, which
// loses the tail of the event log that the whole design treats as the source of truth. Setting
// `process.exitCode` lets Node's own event loop drain naturally.
await main();
