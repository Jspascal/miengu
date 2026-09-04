import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeCodeExecutor,
  CLAUDE_RESULT_SHAPE,
  mapTelemetry,
  QUOTA_SIGNATURES,
} from '../../src/executors/claudeCode.js';
import type { ClaudeCodeOptions } from '../../src/executors/claudeCode.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { emptyContextPack } from '../../src/wiki/contextpack.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';
import type { ExecutorRunInput } from '../../src/executors/executor.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');

let workdir: string;
let transcriptDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'miengu-claude-workdir-'));
  transcriptDir = await mkdtemp(join(tmpdir(), 'miengu-claude-transcripts-'));
  delete process.env['FAKE_CLAUDE_MODE'];
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  await rm(transcriptDir, { recursive: true, force: true });
  delete process.env['FAKE_CLAUDE_MODE'];
});

function makeOptions(overrides: Partial<ClaudeCodeOptions> = {}): ClaudeCodeOptions {
  return {
    bin: FAKE_CLAUDE,
    model: null,
    permissionMode: 'acceptEdits',
    outputFormat: 'stream-json',
    addDirs: [],
    maxBudgetUsd: null,
    sigtermGraceSeconds: 2,
    transcriptDir,
    clock: fixedClock(START),
    ids: createIdMinter(fixedRng('claude-seed')),
    logger: silentLogger,
    ...overrides,
  };
}

function makeInput(
  o: { signal?: AbortSignal; maxTurns?: number; maxWallSeconds?: number } = {},
): ExecutorRunInput {
  return {
    workdir,
    prompt: 'do the thing',
    contextPack: emptyContextPack(itemId, 'implementation'),
    budget: { maxTurns: o.maxTurns ?? 40, maxWallSeconds: o.maxWallSeconds ?? 30 },
    signal: o.signal ?? new AbortController().signal,
  };
}

describe('ClaudeCodeExecutor', () => {
  it('success: completed with telemetry mapped from the CLI result', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    expect(result.telemetry.turns).toBe(2);
    expect(result.telemetry.inputTokens).toBe(120);
    expect(result.telemetry.outputTokens).toBe(80);
    expect(typeof result.telemetry.wallSeconds).toBe('number');

    expect(executor.lastRun?.exitCode).toBe(0);
    expect(executor.lastRun?.failureKind).toBeNull();
    expect(executor.lastRun?.transcriptPath).not.toBeNull();
    const transcript = await readFile(executor.lastRun?.transcriptPath ?? '', 'utf8');
    expect(transcript).toContain('"type":"assistant"');
  });

  it('error-result: gave_up', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'error-result';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('gave_up');
    expect(executor.lastRun?.failureKind).toBeNull();
  });

  it('quota: crashed with failureKind quota', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'quota';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.failureKind).toBe('quota');
  });

  it('garbage: crashed with unparseable, all telemetry except wallSeconds null', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'garbage';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.failureKind).toBe('unparseable');
    expect(result.telemetry.turns).toBeNull();
    expect(result.telemetry.inputTokens).toBeNull();
    expect(result.telemetry.outputTokens).toBeNull();
    expect(typeof result.telemetry.wallSeconds).toBe('number');
  });

  it('nonzero: crashed with nonzero-exit, stderr tail captured', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'nonzero';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.failureKind).toBe('nonzero-exit');
    expect(executor.lastRun?.exitCode).toBe(2);
    expect(executor.lastRun?.stderrTail).toContain('fatal:');
  });

  it('hang: budget_wall and killed sigkill via the SIGTERM -> grace -> SIGKILL ladder', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'hang';
    const executor = new ClaudeCodeExecutor(makeOptions({ sigtermGraceSeconds: 2 }));
    const result = await executor.run(makeInput({ maxWallSeconds: 1 }));

    expect(result.status).toBe('budget_wall');
    expect(executor.lastRun?.failureKind).toBe('timeout');
    expect(executor.lastRun?.killed).toBe('sigkill');
  }, 12_000);

  it('many-turns: budget_turns when observedTurns exceeds maxTurns', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'many-turns';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput({ maxTurns: 5 }));

    expect(result.status).toBe('budget_turns');
    expect(executor.lastRun?.failureKind).toBeNull();
  }, 15_000);

  it('a pre-aborted AbortSignal produces crashed', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const controller = new AbortController();
    controller.abort();
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput({ signal: controller.signal }));

    expect(result.status).toBe('crashed');
  });

  it('the assembled argv never contains a forbidden flag', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(
      makeOptions({ model: 'claude-x', maxBudgetUsd: 5, addDirs: ['../other'] }),
    );
    await executor.run(makeInput());

    const argv = executor.lastRun?.commandLine ?? [];
    expect(argv).not.toContain('--worktree');
    expect(argv).not.toContain('-w');
    expect(argv).not.toContain('--continue');
    expect(argv).not.toContain('-c');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('-r');
    expect(argv).not.toContain('--dangerously-skip-permissions');
    expect(argv).not.toContain('--max-turns');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('--model');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('--max-budget-usd');
  });
});

describe('mapTelemetry', () => {
  it('maps a well-formed result object', () => {
    const telemetry = mapTelemetry(
      { num_turns: 4, usage: { input_tokens: 10, output_tokens: 20 } },
      1.5,
    );
    expect(telemetry).toEqual({ turns: 4, inputTokens: 10, outputTokens: 20, wallSeconds: 1.5 });
  });

  it('never invents a value: everything unverifiable becomes null', () => {
    expect(mapTelemetry(null, 0)).toEqual({
      turns: null,
      inputTokens: null,
      outputTokens: null,
      wallSeconds: 0,
    });
    expect(mapTelemetry({ num_turns: -1 }, 0).turns).toBeNull();
    expect(mapTelemetry({ num_turns: 1.5 }, 0).turns).toBeNull();
  });

  it('does not sum cache token fields into inputTokens', () => {
    const telemetry = mapTelemetry(
      {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 2000,
        },
      },
      0,
    );
    expect(telemetry.inputTokens).toBe(10);
    expect(telemetry.outputTokens).toBe(5);
  });
});

describe('CLAUDE_RESULT_SHAPE', () => {
  it('accepts an empty object and passes through unrecognised keys', () => {
    const parsed = CLAUDE_RESULT_SHAPE.safeParse({ unexpected_field: 'x' });
    expect(parsed.success).toBe(true);
  });
});

describe('QUOTA_SIGNATURES', () => {
  it('matches known quota exhaustion phrasing', () => {
    const text = 'You have exceeded your usage limit for this billing period.';
    expect(QUOTA_SIGNATURES.some((re) => re.test(text))).toBe(true);
  });

  it('does not match unrelated error text', () => {
    const text = 'a network error occurred';
    expect(QUOTA_SIGNATURES.some((re) => re.test(text))).toBe(false);
  });
});
