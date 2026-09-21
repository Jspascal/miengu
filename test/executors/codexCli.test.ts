import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CodexCliExecutor,
  CODEX_CAPABILITIES,
  CODEX_TURN_EVENT_TYPES,
  CODEX_QUOTA_EVENT_TYPES,
  buildArgv,
  isFatalCodexAuthOutput,
  mapTelemetry,
} from '../../src/executors/codexCli.js';
import type { CodexCliOptions } from '../../src/executors/codexCli.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { emptyContextPack } from '../../src/wiki/contextpack.js';
import { AccountIdSchema, ExecutorInstanceIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';
import type { ExecutorInput } from '../../src/executors/executor.js';

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const id = ExecutorInstanceIdSchema.parse('cx-high');
const account = AccountIdSchema.parse('codex-personal');

let workdir: string;
let transcriptDir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'miengu-codex-workdir-'));
  transcriptDir = await mkdtemp(join(tmpdir(), 'miengu-codex-transcripts-'));
  delete process.env['FAKE_CODEX_MODE'];
  delete process.env['FAKE_CODEX_ARTIFACT_KEY'];
  // Never read or write the operator's ~/.codex from a test.
  process.env['MIENGU_HERMETIC'] = '1';
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  await rm(transcriptDir, { recursive: true, force: true });
  delete process.env['FAKE_CODEX_MODE'];
  delete process.env['FAKE_CODEX_ARTIFACT_KEY'];
  delete process.env['MIENGU_HERMETIC'];
});

function makeOptions(overrides: Partial<CodexCliOptions> = {}): CodexCliOptions {
  return {
    id,
    account,
    bin: FAKE_CODEX,
    argvPrefix: [],
    env: {},
    model: null,
    reasoningEffort: null,
    sandboxIntent: 'workspace-write',
    extraConfig: [],
    addDirs: [],
    sigtermGraceSeconds: 2,
    transcriptDir,
    clock: fixedClock(START),
    ids: createIdMinter(fixedRng('codex-seed')),
    logger: silentLogger,
    ...overrides,
  };
}

function makeInput(
  o: {
    signal?: AbortSignal;
    maxTurns?: number;
    maxWallSeconds?: number;
    outputSchemaPath?: string | null;
    finalMessagePath?: string | null;
  } = {},
): ExecutorInput {
  return {
    workdir,
    prompt: 'do the thing',
    contextPack: emptyContextPack(itemId, 'analysis'),
    budget: { maxTurns: o.maxTurns ?? 40, maxWallSeconds: o.maxWallSeconds ?? 30 },
    signal: o.signal ?? new AbortController().signal,
    outputSchemaPath: o.outputSchemaPath ?? null,
    finalMessagePath: o.finalMessagePath ?? null,
  };
}

describe('CodexCliExecutor', () => {
  it('rejects a transcript write failure instead of leaving the run pending', async () => {
    const file = join(workdir, 'not-a-directory');
    await writeFile(file, 'occupied');
    const executor = new CodexCliExecutor(makeOptions({ transcriptDir: file }));
    await expect(executor.run(makeInput())).rejects.toThrow('could not save transcript');
    expect(executor.lastRun).toBeNull();
  });

  it('streams replies before returning and isolates broken display listeners', async () => {
    const replies: string[] = [];
    const executor = new CodexCliExecutor(makeOptions({ onOutput: (output) => {
      expect(executor.lastRun).toBeNull();
      if (output.kind === 'reply') replies.push(output.text);
      throw new Error('display disconnected');
    } }));
    const result = await executor.run(makeInput());
    expect(result.status).toBe('completed');
    expect(replies.length).toBeGreaterThan(0);
  });

  it('surfaces a missing executable with its OS error', async () => {
    const executor = new CodexCliExecutor(makeOptions({ bin: join(workdir, 'missing') }));
    expect((await executor.run(makeInput())).status).toBe('crashed');
    expect(executor.lastRun?.stderrTail).toContain('ENOENT');
  });

  it('exposes the amended Executor identity and capabilities', () => {
    const executor = new CodexCliExecutor(makeOptions());
    expect(executor.id).toBe(id);
    expect(executor.type).toBe('codex');
    expect(executor.account).toBe(account);
    expect(executor.capabilities).toBe(CODEX_CAPABILITIES);
    // VERIFIED against `codex exec --help` 0.149.1 — this is the half of the §9.1b split
    // that Claude Code cannot do.
    expect(executor.capabilities.nativeStructuredOutput).toBe(true);
    expect(executor.capabilities.resumableSessions).toBe(true);
  });

  it('success: completed, and input tokens are NOT cache-summed (codex already includes them)', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    // S5: codex `input_tokens` ALREADY includes `cached_input_tokens`. Summing, as the Claude
    // Code adapter correctly does, would report 24_527 here and double-count the cache.
    expect(result.telemetry.inputTokens).toBe(18_383);
    expect(result.telemetry.cacheReadTokens).toBe(6144);
    expect(result.telemetry.cacheCreationTokens).toBe(0);
    expect(result.telemetry.outputTokens).toBe(5);
    expect(result.telemetry.inputTokens).not.toBe(18_383 + 6144);
  });

  it('success: records the thread_id as the session id, and counts turns', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const executor = new CodexCliExecutor(makeOptions());
    await executor.run(makeInput());

    // S5: `thread.started.thread_id` is the id `codex exec resume <id>` takes.
    expect(executor.lastRun?.sessionId).toBe('01a06e8b-8f90-7c61-b1ff-13b87efdcb9f');
    expect(executor.lastRun?.observedTurns).toBe(1);
    expect(executor.lastRun?.exitCode).toBe(0);
    expect(executor.lastRun?.quota).toBeNull();
  });

  it('artifact: finalMessage is read from the -o file, never scraped from the JSONL', async () => {
    process.env['FAKE_CODEX_MODE'] = 'artifact';
    const finalMessagePath = join(workdir, 'final-message.txt');
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput({ finalMessagePath }));

    expect(result.status).toBe('completed');
    expect(executor.lastRun?.finalMessage).toBe(JSON.stringify({ ok: true, count: 1 }));
  });

  it('artifact-invalid: still completed — schema validation is the agent layer, not the adapter', async () => {
    process.env['FAKE_CODEX_MODE'] = 'artifact-invalid';
    const finalMessagePath = join(workdir, 'final-message.txt');
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput({ finalMessagePath }));

    expect(result.status).toBe('completed');
    expect(executor.lastRun?.finalMessage).toBe(
      JSON.stringify({ ok: 'nope', count: 'not-a-number' }),
    );
  });

  it('finalMessage is null when no -o path was given', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const executor = new CodexCliExecutor(makeOptions());
    await executor.run(makeInput({ finalMessagePath: null }));

    expect(executor.lastRun?.finalMessage).toBeNull();
  });

  it('quota: quota_exhausted with failureKind quota, from the terminal error/turn.failed pair', async () => {
    process.env['FAKE_CODEX_MODE'] = 'quota';
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('quota_exhausted');
    expect(executor.lastRun?.failureKind).toBe('quota');
    expect(executor.lastRun?.quota?.account).toBe(account);
    expect(executor.lastRun?.quota?.source).toBe('provider-event');
    // S5 has NOT verified the provider's quota status string, so it is null rather than guessed.
    expect(executor.lastRun?.quota?.status).toBeNull();
    expect(executor.lastRun?.quota?.resetsAt).toBeNull();
  });

  it('nonzero: crashed, and a non-terminal item.completed error does NOT abort the run early', async () => {
    process.env['FAKE_CODEX_MODE'] = 'nonzero';
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput());

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.failureKind).toBe('nonzero-exit');
    expect(executor.lastRun?.exitCode).toBe(1);
    // S5 finding 3: the run emitted item.completed{item.type:'error'} and then a turn.started.
    // If that item had been treated as terminal, the turn would never have been counted.
    expect(executor.lastRun?.observedTurns).toBe(1);
    expect(executor.lastRun?.quota).toBeNull();
  });

  it('passes configured argv prefixes and environment without a shell', async () => {
    const executor = new CodexCliExecutor(makeOptions({
      argvPrefix: ['--configured-prefix'],
      env: { FAKE_CODEX_MODE: 'success' },
    }));
    const result = await executor.run(makeInput());

    expect(result.status).toBe('completed');
    expect(executor.lastRun?.commandLine.slice(0, 2)).toEqual([FAKE_CODEX, '--configured-prefix']);
  });

  it('hang: budget_wall and killed sigkill via the SIGTERM -> grace -> SIGKILL ladder', async () => {
    process.env['FAKE_CODEX_MODE'] = 'hang';
    const executor = new CodexCliExecutor(makeOptions({ sigtermGraceSeconds: 1 }));
    const result = await executor.run(makeInput({ maxWallSeconds: 1 }));

    expect(result.status).toBe('budget_wall');
    expect(executor.lastRun?.failureKind).toBe('timeout');
    expect(executor.lastRun?.killed).toBe('sigkill');
  });

  it('terminates a stuck non-interactive MCP auth challenge and classifies it as unavailable', async () => {
    process.env['FAKE_CODEX_MODE'] = 'auth-hang';
    const executor = new CodexCliExecutor(makeOptions({ sigtermGraceSeconds: 0.05 }));
    const result = await executor.run(makeInput({ maxWallSeconds: 30 }));

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.failureKind).toBe('auth');
    expect(executor.lastRun?.killed).toBe('sigkill');
    expect(executor.lastRun?.stderrTail).toContain('AuthRequiredError');
  });

  it('many-turns: budget_turns when observedTurns exceeds maxTurns', async () => {
    process.env['FAKE_CODEX_MODE'] = 'many-turns';
    const executor = new CodexCliExecutor(makeOptions({ sigtermGraceSeconds: 1 }));
    const result = await executor.run(makeInput({ maxTurns: 3 }));

    expect(result.status).toBe('budget_turns');
  });

  it('a pre-aborted signal yields crashed', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const controller = new AbortController();
    controller.abort();
    const executor = new CodexCliExecutor(makeOptions({ sigtermGraceSeconds: 1 }));
    const result = await executor.run(makeInput({ signal: controller.signal }));

    expect(result.status).toBe('crashed');
  });

  it('garbage: observedTurns is null and budget_turns is NOT reported — honest degradation', async () => {
    process.env['FAKE_CODEX_MODE'] = 'garbage';
    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput({ maxTurns: 1 }));

    // No turn event matched, so the cap was never enforceable. Reporting 0 would read as
    // "the cap held"; null says "unknown", which is what §9 requires of a field we cannot know.
    expect(executor.lastRun?.observedTurns).toBeNull();
    expect(result.status).not.toBe('budget_turns');
    expect(result.telemetry.turns).toBeNull();
  });

  it('writes the transcript verbatim', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const executor = new CodexCliExecutor(makeOptions());
    await executor.run(makeInput());

    const path = executor.lastRun?.transcriptPath;
    expect(path).not.toBeNull();
    expect(path).toContain(transcriptDir);
  });
});

describe('CodexCliExecutor argv', () => {
  const input = (o: Partial<ExecutorInput> = {}): ExecutorInput => ({
    workdir: '/tmp/wd',
    prompt: 'p',
    contextPack: emptyContextPack(itemId, 'analysis'),
    budget: { maxTurns: 40, maxWallSeconds: 30 },
    signal: new AbortController().signal,
    outputSchemaPath: null,
    finalMessagePath: null,
    ...o,
  });

  it('passes --output-schema only when a path is supplied', () => {
    const withSchema = buildArgv(makeOptions(), input({ outputSchemaPath: '/tmp/s.json' }), false);
    expect(withSchema).toContain('--output-schema');
    expect(withSchema).toContain('/tmp/s.json');

    const without = buildArgv(makeOptions(), input({ outputSchemaPath: null }), false);
    expect(without).not.toContain('--output-schema');
  });

  it('ships reasoning effort as -c model_reasoning_effort=, never as a flag', () => {
    const argv = buildArgv(makeOptions({ reasoningEffort: 'high' }), input(), false);
    const ci = argv.indexOf('-c');
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(argv[ci + 1]).toBe('model_reasoning_effort=high');
    // VERIFIED ABSENT from `codex exec --help` 0.149.1. Passing it would fail at run time.
    expect(argv).not.toContain('--reasoning-effort');
  });

  it('maps SandboxIntent 1:1 onto -s', () => {
    const argv = buildArgv(makeOptions({ sandboxIntent: 'read-only' }), input(), false);
    const si = argv.indexOf('-s');
    expect(si).toBeGreaterThanOrEqual(0);
    expect(argv[si + 1]).toBe('read-only');
  });

  it('reads the prompt from stdin via a trailing - positional', () => {
    const argv = buildArgv(makeOptions(), input(), false);
    expect(argv[argv.length - 1]).toBe('-');
  });

  it('never passes a sandbox-defeating or session-mutating flag', () => {
    const argv = buildArgv(
      makeOptions({ reasoningEffort: 'high', model: 'gpt-5.2-codex', addDirs: ['/tmp/x'] }),
      input({ outputSchemaPath: '/tmp/s.json', finalMessagePath: '/tmp/o.txt' }),
      true,
    );
    for (const forbidden of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '--approve-for-me',
      'danger-full-access',
      'resume',
      'fork',
      'review',
    ]) {
      expect(argv).not.toContain(forbidden);
    }
  });

  it('always isolates user config while adding --ephemeral only under MIENGU_HERMETIC', () => {
    expect(buildArgv(makeOptions(), input(), true)).toContain('--ephemeral');
    expect(buildArgv(makeOptions(), input(), true)).toContain('--ignore-user-config');
    expect(buildArgv(makeOptions(), input(), false)).not.toContain('--ephemeral');
    expect(buildArgv(makeOptions(), input(), false)).toContain('--ignore-user-config');
  });

  it('passes extraConfig overrides verbatim', () => {
    const argv = buildArgv(makeOptions({ extraConfig: ['foo.bar=1'] }), input(), false);
    expect(argv).toContain('foo.bar=1');
  });
});

describe('codex event-type constants (spike S5)', () => {
  it('counts turns on turn.started', () => {
    expect(CODEX_TURN_EVENT_TYPES).toContain('turn.started');
  });

  it('treats error and turn.failed as terminal, but NOT item.completed', () => {
    expect(CODEX_QUOTA_EVENT_TYPES).toContain('error');
    expect(CODEX_QUOTA_EVENT_TYPES).toContain('turn.failed');
    // S5 finding 3 — the whole point. An item.completed error is recoverable.
    expect(CODEX_QUOTA_EVENT_TYPES).not.toContain('item.completed');
  });
});

describe('codex fatal stderr detection', () => {
  it('matches a fatal MCP AuthRequired error without treating ordinary warnings as fatal', () => {
    expect(isFatalCodexAuthOutput(
      'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { scope: "x" })',
    )).toBe(true);
    expect(isFatalCodexAuthOutput('WARN rmcp: reconnecting after transport closed')).toBe(false);
  });
});

describe('codex mapTelemetry', () => {
  it('returns all-null for an unrecognised shape rather than inventing zeroes', () => {
    const t = mapTelemetry(null, 1.5);
    expect(t.inputTokens).toBeNull();
    expect(t.outputTokens).toBeNull();
    expect(t.cacheReadTokens).toBeNull();
    expect(t.cacheCreationTokens).toBeNull();
    expect(t.turns).toBeNull();
    expect(t.wallSeconds).toBe(1.5);
  });

  it('does not sum cached_input_tokens into inputTokens', () => {
    const t = mapTelemetry(
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
      1,
    );
    expect(t.inputTokens).toBe(100);
    expect(t.cacheReadTokens).toBe(40);
    expect(t.outputTokens).toBe(7);
  });
});

describe('codex output-schema is machine-checked by the fixture oracle', () => {
  it('rejects a schema that violates the structured-output subset', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    // additionalProperties missing => the fixture exits 3 before emitting any event.
    const badSchema = join(workdir, 'bad-schema.json');
    await writeFile(badSchema, JSON.stringify({ type: 'object', properties: {} }), 'utf8');

    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput({ outputSchemaPath: badSchema }));

    expect(result.status).toBe('crashed');
    expect(executor.lastRun?.exitCode).toBe(3);
  });

  it('accepts a schema that obeys the subset', async () => {
    process.env['FAKE_CODEX_MODE'] = 'success';
    const goodSchema = join(workdir, 'good-schema.json');
    await writeFile(
      goodSchema,
      JSON.stringify({
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      }),
      'utf8',
    );

    const executor = new CodexCliExecutor(makeOptions());
    const result = await executor.run(makeInput({ outputSchemaPath: goodSchema }));

    expect(result.status).toBe('completed');
  });
});
