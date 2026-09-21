import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeCodeExecutor,
  CLAUDE_CAPABILITIES,
  CLAUDE_RESULT_SHAPE,
  mapTelemetry,
  selectResultLine,
  selectRateLimitInfo,
  QUOTA_SIGNATURES,
  RATE_LIMIT_ALLOWED_STATUSES,
} from '../../src/executors/claudeCode.js';
import type { ClaudeCodeOptions } from '../../src/executors/claudeCode.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { emptyContextPack } from '../../src/wiki/contextpack.js';
import { AccountIdSchema, ExecutorInstanceIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';
import type { ExecutorInput } from '../../src/executors/executor.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const id = ExecutorInstanceIdSchema.parse('cc-sonnet');
const account = AccountIdSchema.parse('claude-personal');

let workdir: string;
let transcriptDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'miengu-claude-workdir-'));
  transcriptDir = await mkdtemp(join(tmpdir(), 'miengu-claude-transcripts-'));
  delete process.env['FAKE_CLAUDE_MODE'];
  delete process.env['FAKE_CLAUDE_ARTIFACT_KEY'];
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  await rm(transcriptDir, { recursive: true, force: true });
  delete process.env['FAKE_CLAUDE_MODE'];
  delete process.env['FAKE_CLAUDE_ARTIFACT_KEY'];
});

function makeOptions(overrides: Partial<ClaudeCodeOptions> = {}): ClaudeCodeOptions {
  return {
    id,
    account,
    bin: FAKE_CLAUDE,
    argvPrefix: [],
    env: {},
    model: null,
    effort: null,
    sandboxIntent: 'workspace-write',
    permissionModeOverride: null,
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
): ExecutorInput {
  return {
    workdir,
    prompt: 'do the thing',
    contextPack: emptyContextPack(itemId, 'implementation'),
    budget: { maxTurns: o.maxTurns ?? 40, maxWallSeconds: o.maxWallSeconds ?? 30 },
    signal: o.signal ?? new AbortController().signal,
    outputSchemaPath: null,
    finalMessagePath: null,
  };
}

describe('ClaudeCodeExecutor', () => {
  it('counts multiple blocks of the same assistant message as one turn', async () => {
    const executor = new ClaudeCodeExecutor(makeOptions({ env: { FAKE_CLAUDE_MODE: 'split-message' } }));
    expect((await executor.run(makeInput({ maxTurns: 1 }))).status).toBe('completed');
    expect(executor.lastRun?.observedTurns).toBe(1);
  });
  it('rejects a transcript write failure instead of leaving the run pending', async () => {
    const file = join(workdir, 'not-a-directory');
    await writeFile(file, 'occupied');
    const executor = new ClaudeCodeExecutor(makeOptions({ transcriptDir: file }));
    await expect(executor.run(makeInput())).rejects.toThrow('could not save transcript');
    expect(executor.lastRun).toBeNull();
  });

  it('streams replies before returning and isolates broken display listeners', async () => {
    const replies: string[] = [];
    const executor = new ClaudeCodeExecutor(makeOptions({ onOutput: (output) => {
      expect(executor.lastRun).toBeNull();
      if (output.kind === 'reply') replies.push(output.text);
      throw new Error('display disconnected');
    } }));
    const result = await executor.run(makeInput());
    expect(result.status).toBe('completed');
    expect(replies.length).toBeGreaterThan(0);
  });

  it('surfaces a missing executable with its OS error', async () => {
    const executor = new ClaudeCodeExecutor(makeOptions({ bin: join(workdir, 'missing') }));
    expect((await executor.run(makeInput())).status).toBe('crashed');
    expect(executor.lastRun?.stderrTail).toContain('ENOENT');
  });

  it('exposes the amended Executor identity and capabilities', () => {
    const executor = new ClaudeCodeExecutor(makeOptions());
    expect(executor.id).toBe(id);
    expect(executor.type).toBe('claude-code');
    expect(executor.account).toBe(account);
    expect(executor.capabilities).toBe(CLAUDE_CAPABILITIES);
    expect(executor.capabilities.nativeStructuredOutput).toBe(false);
  });

  it('success: completed with telemetry mapped from the CLI result, tokens summed with cache', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    expect(result.telemetry.turns).toBe(2);
    expect(result.telemetry.inputTokens).toBe(21_482);
    expect(result.telemetry.cacheReadTokens).toBe(8144);
    expect(result.telemetry.cacheCreationTokens).toBe(13_336);
    expect(result.telemetry.outputTokens).toBe(4);
    expect(typeof result.telemetry.wallSeconds).toBe('number');

    expect(executor.lastRun?.exitCode).toBe(0);
    expect(executor.lastRun?.failureKind).toBeNull();
    expect(executor.lastRun?.transcriptPath).not.toBeNull();
    const transcript = await readFile(executor.lastRun?.transcriptPath ?? '', 'utf8');
    expect(transcript).toContain('"type":"assistant"');
  });

  it('success: status stays completed despite the rate_limit_event (the gating rule)', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
  });

  it('success: lastRun.quota is populated with the observed utilization and a converted resetsAt', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    await executor.run(makeInput());

    expect(executor.lastRun?.quota).not.toBeNull();
    expect(executor.lastRun?.quota?.utilization).toBe(0.91);
    expect(executor.lastRun?.quota?.resetsAt).toBe(new Date(1_788_545_400 * 1000).toISOString());
  });

  it('the three leading system/* lines do not become turns', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    // two assistant lines emitted -> turns must be 2, not 5 (3 system + 2 assistant)
    expect(result.telemetry.turns).toBe(2);
  });

  it('error-result: gave_up', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'error-result';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('gave_up');
    expect(executor.lastRun?.failureKind).toBeNull();
  });

  it('quota (regex-only): quota_exhausted with quota.source one of the two regex sources', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'quota';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('quota_exhausted');
    expect(executor.lastRun?.failureKind).toBe('quota');
    expect(['stream-regex', 'stderr-regex']).toContain(executor.lastRun?.quota?.source);
  });

  it('rate-limited: quota_exhausted with quota.source rate-limit-event and a non-null resetsAt', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'rate-limited';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('quota_exhausted');
    expect(executor.lastRun?.failureKind).toBe('quota');
    expect(executor.lastRun?.quota?.source).toBe('rate-limit-event');
    expect(executor.lastRun?.quota?.resetsAt).not.toBeNull();
  });

  it('api-429: quota_exhausted with quota.source api-error-status', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'api-429';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('quota_exhausted');
    expect(executor.lastRun?.failureKind).toBe('quota');
    expect(executor.lastRun?.quota?.source).toBe('api-error-status');
  });

  it('a stream where rate_limit_event is emitted after result still selects the result line', async () => {
    const lines: unknown[] = [
      { type: 'assistant' },
      { type: 'result', subtype: 'success', is_error: false },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
    ];
    const selected = selectResultLine(lines);
    expect(selected).toEqual({ type: 'result', subtype: 'success', is_error: false });
  });

  it('artifact: lastRun.finalMessage is the JSON string', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'artifact';
    const executor = new ClaudeCodeExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    expect(executor.lastRun?.finalMessage).not.toBeNull();
    expect(() => JSON.parse(executor.lastRun?.finalMessage ?? '')).not.toThrow();
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

  it('passes configured argv prefixes and environment without a shell', async () => {
    const executor = new ClaudeCodeExecutor(makeOptions({
      argvPrefix: ['--configured-prefix'],
      env: { FAKE_CLAUDE_MODE: 'success' },
    }));
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    expect(executor.lastRun?.commandLine.slice(0, 2)).toEqual([FAKE_CLAUDE, '--configured-prefix']);
  });

  it('captures the actionable spawn error when the executable is missing', async () => {
    const executor = new ClaudeCodeExecutor(makeOptions({ bin: '/missing/miengu-claude' }));
    const result = await executor.run(makeInput());

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.stderrTail).toMatch(/spawn \/missing\/miengu-claude ENOENT/);
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
    expect(argv).not.toContain('--output-schema');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('--model');
    expect(argv).toContain('--add-dir');
    expect(argv).toContain('--max-budget-usd');
  });

  it('outputSchemaPath is ignored: never inlined into argv', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions());
    await executor.run({ ...makeInput(), outputSchemaPath: '/tmp/schema.json' });

    const argv = executor.lastRun?.commandLine ?? [];
    expect(argv).not.toContain('--output-schema');
    expect(argv).not.toContain('/tmp/schema.json');
  });

  it('sandboxIntent read-only puts --permission-mode plan in argv', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions({ sandboxIntent: 'read-only' }));
    await executor.run(makeInput());

    const argv = executor.lastRun?.commandLine ?? [];
    const idx = argv.indexOf('--permission-mode');
    expect(argv[idx + 1]).toBe('plan');
  });

  it('sandboxIntent workspace-write puts --permission-mode acceptEdits in argv', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions({ sandboxIntent: 'workspace-write' }));
    await executor.run(makeInput());

    const argv = executor.lastRun?.commandLine ?? [];
    const idx = argv.indexOf('--permission-mode');
    expect(argv[idx + 1]).toBe('acceptEdits');
  });

  it('effort is passed as --effort', async () => {
    process.env['FAKE_CLAUDE_MODE'] = 'success';
    const executor = new ClaudeCodeExecutor(makeOptions({ effort: 'high' }));
    await executor.run(makeInput());

    const argv = executor.lastRun?.commandLine ?? [];
    const idx = argv.indexOf('--effort');
    expect(argv[idx + 1]).toBe('high');
  });
});

describe('mapTelemetry', () => {
  it('maps a well-formed result object, summing cache tokens into inputTokens', () => {
    const telemetry = mapTelemetry(
      {
        num_turns: 4,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 13_336,
          cache_read_input_tokens: 8144,
          output_tokens: 4,
        },
      },
      1.5,
    );
    expect(telemetry).toEqual({
      turns: 4,
      inputTokens: 21_482,
      outputTokens: 4,
      cacheReadTokens: 8144,
      cacheCreationTokens: 13_336,
      wallSeconds: 1.5,
    });
  });

  it('never invents a value: everything unverifiable becomes null', () => {
    expect(mapTelemetry(null, 0)).toEqual({
      turns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      wallSeconds: 0,
    });
    expect(mapTelemetry({ num_turns: -1 }, 0).turns).toBeNull();
    expect(mapTelemetry({ num_turns: 1.5 }, 0).turns).toBeNull();
  });

  it('sums whichever of the three input-token sources are present and valid', () => {
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
    expect(telemetry.inputTokens).toBe(3010);
    expect(telemetry.cacheReadTokens).toBe(1000);
    expect(telemetry.cacheCreationTokens).toBe(2000);
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

describe('RATE_LIMIT_ALLOWED_STATUSES', () => {
  it('is an allow-list, not a block-list', () => {
    expect(RATE_LIMIT_ALLOWED_STATUSES).toEqual(['allowed', 'allowed_warning']);
  });
});

describe('selectRateLimitInfo', () => {
  it('returns the last rate_limit_event.rate_limit_info', () => {
    const lines = [
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', utilization: 0.1 } },
      { type: 'assistant' },
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.9 } },
    ];
    expect(selectRateLimitInfo(lines)).toEqual({ status: 'allowed_warning', utilization: 0.9 });
  });

  it('returns null when no rate_limit_event line exists', () => {
    expect(selectRateLimitInfo([{ type: 'assistant' }, { type: 'result' }])).toBeNull();
  });
});
