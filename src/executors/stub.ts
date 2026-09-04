import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Clock } from '../core/clock.js';
import type { IdMinter } from '../core/idgen.js';
import type {
  Executor,
  ExecutorRunInput,
  ExecutorRunResult,
  ExecutorStatus,
  ExecutorTelemetry,
  RawRunRecord,
  RawRunSource,
} from './executor.js';

export interface StubScriptStep {
  readonly status: ExecutorStatus;
  readonly telemetry: ExecutorTelemetry;
  readonly writeFiles?: Record<string, string>;
  readonly delayMs?: number;
}

export interface StubScript {
  readonly steps: readonly StubScriptStep[];
}

const DEFAULT_SCRIPT: StubScript = {
  steps: [
    {
      status: 'completed',
      telemetry: { turns: 1, inputTokens: null, outputTokens: null, wallSeconds: 0 },
    },
  ],
};

export class StubExecutor implements Executor, RawRunSource {
  readonly id = 'stub';
  lastRun: RawRunRecord | null = null;

  private readonly script: StubScript;
  private readonly isDefaultScript: boolean;
  private readonly clock: Clock;
  private readonly ids: IdMinter;
  private stepIndex = 0;

  constructor(o: { script?: StubScript; clock: Clock; ids: IdMinter }) {
    this.script = o.script ?? DEFAULT_SCRIPT;
    this.isDefaultScript = o.script === undefined;
    this.clock = o.clock;
    this.ids = o.ids;
  }

  async run(i: ExecutorRunInput): Promise<ExecutorRunResult> {
    const startedAt = this.clock.now();
    const sessionId = this.ids.sessionUuid();

    if (i.signal.aborted) {
      const finishedAt = this.clock.now();
      const telemetry: ExecutorTelemetry = {
        turns: null,
        inputTokens: null,
        outputTokens: null,
        wallSeconds: 0,
      };
      this.lastRun = {
        commandLine: [],
        exitCode: null,
        signal: null,
        killed: 'none',
        startedAt,
        finishedAt,
        observedTurns: null,
        failureKind: null,
        stderrTail: '',
        sessionId,
        transcriptPath: null,
        rawResult: null,
      };
      return { status: 'crashed', telemetry };
    }

    const step = this.script.steps[Math.min(this.stepIndex, this.script.steps.length - 1)];
    this.stepIndex += 1;
    if (step === undefined) {
      throw new Error('StubExecutor: script has no steps');
    }

    let status: ExecutorStatus = step.status;
    if (step.delayMs !== undefined && step.delayMs / 1000 > i.budget.maxWallSeconds) {
      status = 'budget_wall';
    }

    if (step.writeFiles !== undefined) {
      for (const [relativePath, content] of Object.entries(step.writeFiles)) {
        const target = join(i.workdir, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
    }
    if (this.isDefaultScript) {
      const target = join(i.workdir, '.miengu-stub', `${i.contextPack.stage}.txt`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `stub stage: ${i.contextPack.stage}\n`, 'utf8');
    }

    const finishedAt = this.clock.now();
    this.lastRun = {
      commandLine: [],
      exitCode: 0,
      signal: null,
      killed: 'none',
      startedAt,
      finishedAt,
      observedTurns: step.telemetry.turns,
      failureKind: null,
      stderrTail: '',
      sessionId,
      transcriptPath: null,
      rawResult: null,
    };

    return { status, telemetry: step.telemetry };
  }
}
