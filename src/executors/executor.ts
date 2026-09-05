import type { IsoTimestamp } from '../core/clock.js';
import type { ExecutorStatus, ExecutorType, QuotaSource, SandboxIntent } from '../core/events.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';
import type { ContextPack } from '../wiki/contextpack.js';
import { ConfigError } from '../errors.js';

export type { ExecutorStatus };

// Amended in Phase 2 per Phase2 delta.md §9.1 / §9.1b / §17.5, which supersede BUILD_PROMPT.md §9's shape.
export interface ExecutorCapabilities {
  readonly nativeStructuredOutput: boolean;
  readonly resumableSessions: boolean;
  readonly sandboxModes: readonly SandboxIntent[];
}

export interface ExecutorInput {
  readonly workdir: string;
  readonly prompt: string;
  readonly contextPack: ContextPack;
  readonly budget: { readonly maxTurns: number; readonly maxWallSeconds: number };
  readonly signal: AbortSignal;
  /** §9.1b native path. Written to a temp file and passed to --output-schema when the
   *  executor advertises nativeStructuredOutput. IGNORED, never inlined, when it does not. */
  readonly outputSchemaPath: string | null;
  /** Where the adapter may write the final agent message (codex -o). Adapters that read the
   *  message off the stream ignore it. */
  readonly finalMessagePath: string | null;
}

export interface ExecutorResult {
  readonly status: ExecutorStatus;
  readonly telemetry: ExecutorTelemetry;
}

export interface Executor {
  readonly id: ExecutorInstanceId;
  readonly type: ExecutorType;
  readonly account: AccountId;
  readonly capabilities: ExecutorCapabilities;
  run(input: ExecutorInput): Promise<ExecutorResult>;
}

export interface ExecutorTelemetry {
  turns: number | null;
  inputTokens: number | null; // input_tokens + cache_creation + cache_read (the TRUE input)
  outputTokens: number | null;
  cacheReadTokens: number | null; // NEW — breakdown, so the sum above is auditable
  cacheCreationTokens: number | null; // NEW
  wallSeconds: number;
}

export interface QuotaObservation {
  readonly account: AccountId;
  readonly source: QuotaSource;
  readonly status: string | null; // the provider's own status string, VERBATIM
  readonly utilization: number | null;
  readonly windowKind: string | null; // 'five_hour' | 'seven_day' | provider term
  readonly resetsAt: IsoTimestamp | null;
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
  readonly finalMessage: string | null; // NEW — the provider-agnostic artifact seam
  readonly quota: QuotaObservation | null; // NEW
}

/** Side channel for detail §9's return shape cannot carry. */
export interface RawRunSource {
  readonly lastRun: RawRunRecord | null;
}

/** §17.5. Throws AT CONSTRUCTION, never at run time. */
export function assertSandboxSupported(
  id: ExecutorInstanceId,
  type: ExecutorType,
  caps: ExecutorCapabilities,
  intent: SandboxIntent,
): void {
  if (!caps.sandboxModes.includes(intent)) {
    throw new ConfigError(
      `executor "${id}" (type "${type}") does not support sandbox intent "${intent}"`,
      { id, type, intent, sandboxModes: caps.sandboxModes },
    );
  }
}
