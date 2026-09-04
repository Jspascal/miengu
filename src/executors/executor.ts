import type { IsoTimestamp } from '../core/clock.js';
import type { ContextPack } from '../wiki/contextpack.js';

// §9 of BUILD_PROMPT.md. Shape is frozen. Extend via RawRunSource, never here.
export interface Executor {
  readonly id: string;
  run(input: {
    workdir: string;
    prompt: string;
    contextPack: ContextPack;
    budget: { maxTurns: number; maxWallSeconds: number };
    signal: AbortSignal;
  }): Promise<{
    status: 'completed' | 'gave_up' | 'budget_turns' | 'budget_wall' | 'crashed';
    telemetry: {
      turns: number | null;
      inputTokens: number | null;
      outputTokens: number | null;
      wallSeconds: number;
    };
  }>;
}

export type ExecutorStatus = 'completed' | 'gave_up' | 'budget_turns' | 'budget_wall' | 'crashed';

export interface ExecutorTelemetry {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  wallSeconds: number;
}

export interface ExecutorRunInput {
  workdir: string;
  prompt: string;
  contextPack: ContextPack;
  budget: { maxTurns: number; maxWallSeconds: number };
  signal: AbortSignal;
}

export interface ExecutorRunResult {
  status: ExecutorStatus;
  telemetry: ExecutorTelemetry;
}

export interface RawRunRecord {
  readonly commandLine: readonly string[];
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly killed: 'none' | 'sigterm' | 'sigkill';
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly observedTurns: number | null;
  readonly failureKind: 'quota' | 'auth' | 'timeout' | 'unparseable' | 'nonzero-exit' | null;
  readonly stderrTail: string;
  readonly sessionId: string | null;
  readonly transcriptPath: string | null;
  readonly rawResult: unknown;
}

/** Side channel for detail §9's return shape cannot carry. */
export interface RawRunSource {
  readonly lastRun: RawRunRecord | null;
}
