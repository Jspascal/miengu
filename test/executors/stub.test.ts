import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { emptyContextPack } from '../../src/wiki/contextpack.js';
import { AccountIdSchema, ExecutorInstanceIdSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import type { ExecutorInput, QuotaObservation } from '../../src/executors/executor.js';

const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const id = ExecutorInstanceIdSchema.parse('stub-coder');
const account = AccountIdSchema.parse('stub-account');

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'miengu-stub-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeInput(o: { signal?: AbortSignal; maxWallSeconds?: number } = {}): ExecutorInput {
  return {
    workdir,
    prompt: 'miengu stub stage: intake',
    contextPack: emptyContextPack(itemId, 'intake'),
    budget: { maxTurns: 40, maxWallSeconds: o.maxWallSeconds ?? 1800 },
    signal: o.signal ?? new AbortController().signal,
    outputSchemaPath: null,
    finalMessagePath: null,
  };
}

describe('StubExecutor', () => {
  it('exposes the amended Executor identity and capabilities', () => {
    const executor = new StubExecutor({
      id,
      account,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-identity')),
    });
    expect(executor.id).toBe(id);
    expect(executor.type).toBe('stub');
    expect(executor.account).toBe(account);
    expect(executor.capabilities).toEqual({
      nativeStructuredOutput: false,
      resumableSessions: false,
      sandboxModes: ['read-only', 'workspace-write'],
    });
  });

  it('default script: completes, reports turns:1 and null tokens, writes .miengu-stub/<stage>.txt', async () => {
    const executor = new StubExecutor({
      id,
      account,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-a')),
    });

    const result = await executor.run(makeInput());
    expect(result).toEqual({
      status: 'completed',
      telemetry: {
        turns: 1,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        wallSeconds: 0,
      },
    });

    const written = await readFile(join(workdir, '.miengu-stub', 'intake.txt'), 'utf8');
    expect(written).toContain('intake');

    expect(executor.lastRun).not.toBeNull();
    expect(executor.lastRun?.commandLine).toEqual([]);
    expect(executor.lastRun?.startedAt).toBe(START);
  });

  it('honours a custom script and writeFiles, and does not write the default stub file', async () => {
    const script: StubScript = {
      steps: [
        {
          status: 'completed',
          telemetry: {
            turns: 3,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 2,
          },
          writeFiles: { 'src/thing.txt': 'hello from the stub\n' },
        },
      ],
    };
    const executor = new StubExecutor({
      id,
      account,
      script,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-b')),
    });

    const result = await executor.run(makeInput());
    expect(result.status).toBe('completed');
    expect(result.telemetry).toEqual({
      turns: 3,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      wallSeconds: 2,
    });

    const written = await readFile(join(workdir, 'src', 'thing.txt'), 'utf8');
    expect(written).toBe('hello from the stub\n');

    await expect(access(join(workdir, '.miengu-stub', 'intake.txt'))).rejects.toThrow();
  });

  it('advances through scripted steps in order and clamps on the last step once exhausted', async () => {
    const script: StubScript = {
      steps: [
        {
          status: 'crashed',
          telemetry: {
            turns: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 1,
          },
        },
        {
          status: 'completed',
          telemetry: {
            turns: 2,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 1,
          },
        },
      ],
    };
    const executor = new StubExecutor({
      id,
      account,
      script,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-c')),
    });

    const first = await executor.run(makeInput());
    expect(first.status).toBe('crashed');
    const second = await executor.run(makeInput());
    expect(second.status).toBe('completed');
    const third = await executor.run(makeInput());
    expect(third.status).toBe('completed');
  });

  it('resolves crashed when the signal is already aborted, without touching the workdir', async () => {
    const controller = new AbortController();
    controller.abort();
    const executor = new StubExecutor({
      id,
      account,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-d')),
    });

    const result = await executor.run(makeInput({ signal: controller.signal }));
    expect(result).toEqual({
      status: 'crashed',
      telemetry: {
        turns: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        wallSeconds: 0,
      },
    });
    await expect(access(join(workdir, '.miengu-stub', 'intake.txt'))).rejects.toThrow();
  });

  it('returns budget_wall when a scripted delayMs exceeds maxWallSeconds, without sleeping', async () => {
    const script: StubScript = {
      steps: [
        {
          status: 'completed',
          telemetry: {
            turns: 1,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 600,
          },
          delayMs: 600_000,
        },
      ],
    };
    const executor = new StubExecutor({
      id,
      account,
      script,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-e')),
    });

    const startedAtWallClock = Date.now();
    const result = await executor.run(makeInput({ maxWallSeconds: 5 }));
    const elapsedMs = Date.now() - startedAtWallClock;

    expect(result.status).toBe('budget_wall');
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('a scripted quota_exhausted step returns that status and populates lastRun.quota', async () => {
    const quota: QuotaObservation = {
      account,
      source: 'rate-limit-event',
      status: 'blocked',
      utilization: 1,
      windowKind: 'five_hour',
      resetsAt: null,
    };
    const script: StubScript = {
      steps: [
        {
          status: 'quota_exhausted',
          telemetry: {
            turns: 1,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 1,
          },
          quota,
        },
      ],
    };
    const executor = new StubExecutor({
      id,
      account,
      script,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-f')),
    });

    const result = await executor.run(makeInput());
    expect(result.status).toBe('quota_exhausted');
    expect(executor.lastRun?.quota).toEqual(quota);
  });

  it('finalMessage round-trips onto lastRun', async () => {
    const script: StubScript = {
      steps: [
        {
          status: 'completed',
          telemetry: {
            turns: 1,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            wallSeconds: 1,
          },
          finalMessage: '{"ok":true}',
        },
      ],
    };
    const executor = new StubExecutor({
      id,
      account,
      script,
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('seed-g')),
    });

    await executor.run(makeInput());
    expect(executor.lastRun?.finalMessage).toBe('{"ok":true}');
  });
});
