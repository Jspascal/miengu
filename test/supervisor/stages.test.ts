import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubPrompt, runStubStage } from '../../src/supervisor/stages.js';
import type { StageRunContext } from '../../src/supervisor/stages.js';
import { StubExecutor } from '../../src/executors/stub.js';
import type { StubScript } from '../../src/executors/stub.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { WorkItemIdSchema } from '../../src/core/ids.js';
import { sha256Canonical } from '../../src/core/hash.js';

const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-example-abc123');

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'miengu-stages-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function makeContext(script?: StubScript, signal?: AbortSignal): StageRunContext {
  return {
    executor: new StubExecutor({
      ...(script !== undefined ? { script } : {}),
      clock: fixedClock(START),
      ids: createIdMinter(fixedRng('stages-test')),
    }),
    itemId,
    workdir,
    budget: { maxTurns: 40, maxWallSeconds: 1800 },
    signal: signal ?? new AbortController().signal,
  };
}

describe('buildStubPrompt', () => {
  it('builds a canned, stage-scoped prompt', () => {
    expect(buildStubPrompt('intake')).toBe('miengu stub stage: intake');
    expect(buildStubPrompt('review')).toBe('miengu stub stage: review');
  });
});

describe('runStubStage', () => {
  it('maps a completed executor run to a completed StageOutcome with a stub artifact', async () => {
    const ctx = makeContext();
    const outcome = await runStubStage('intake', ctx);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') {
      throw new Error('expected completed outcome');
    }
    const expectedBody = { stage: 'intake' as const, executorStatus: 'completed' as const };
    expect(outcome.artifact).toEqual({
      kind: 'stub',
      sha256: sha256Canonical(expectedBody),
      body: expectedBody,
    });
    expect(outcome.executorResult.status).toBe('completed');
  });

  const failureCases: Array<{
    status: 'gave_up' | 'budget_turns' | 'budget_wall' | 'crashed';
    reason: 'executor-gave-up' | 'budget-turns' | 'budget-wall' | 'executor-crashed';
  }> = [
    { status: 'gave_up', reason: 'executor-gave-up' },
    { status: 'budget_turns', reason: 'budget-turns' },
    { status: 'budget_wall', reason: 'budget-wall' },
    { status: 'crashed', reason: 'executor-crashed' },
  ];

  for (const { status, reason } of failureCases) {
    it(`maps executor status "${status}" to StageFailureReason "${reason}"`, async () => {
      const script: StubScript = {
        steps: [
          {
            status,
            telemetry: { turns: null, inputTokens: null, outputTokens: null, wallSeconds: 1 },
          },
        ],
      };
      const ctx = makeContext(script);
      const outcome = await runStubStage('implementation', ctx);

      expect(outcome.kind).toBe('failed');
      if (outcome.kind !== 'failed') {
        throw new Error('expected failed outcome');
      }
      expect(outcome.reason).toBe(reason);
      expect(outcome.executorResult.status).toBe(status);
    });
  }
});
