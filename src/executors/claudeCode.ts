import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { decodeOutput, emitOutput } from './output.js';
import type { OutputListener } from './output.js';
import type { Clock, IsoTimestamp } from '../core/clock.js';
import type { SandboxIntent } from '../core/events.js';
import type { IdMinter } from '../core/idgen.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';
import type { Logger } from '../logging.js';
import type {
  Executor,
  ExecutorCapabilities,
  ExecutorInput,
  ExecutorResult,
  ExecutorStatus,
  ExecutorTelemetry,
  QuotaObservation,
  RawRunRecord,
  RawRunSource,
} from './executor.js';

export const DEFAULT_SIGTERM_GRACE_SECONDS = 10;

export type PermissionMode = 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';

export interface ClaudeCodeOptions {
  onOutput?: OutputListener | undefined;
  id: ExecutorInstanceId;
  account: AccountId;
  bin: string;
  argvPrefix: readonly string[];
  env: Readonly<Record<string, string>>;
  model: string | null;
  effort: string | null;
  sandboxIntent: SandboxIntent;
  /** Config escape hatch; null = derive from sandboxIntent (ASSUMPTION A3). */
  permissionModeOverride: PermissionMode | null;
  outputFormat: 'json' | 'stream-json';
  addDirs: readonly string[];
  maxBudgetUsd: number | null;
  sigtermGraceSeconds: number;
  transcriptDir: string | null;
  clock: Clock;
  ids: IdMinter;
  logger: Logger;
}

export const CLAUDE_CAPABILITIES: ExecutorCapabilities = {
  nativeStructuredOutput: false, // VERIFIED BY ABSENCE: `claude --help` has no --output-schema (2.1.260)
  resumableSessions: true, // --session-id <uuid>
  sandboxModes: ['read-only', 'workspace-write'],
};

export const RATE_LIMIT_ALLOWED_STATUSES = ['allowed', 'allowed_warning'] as const;

// Every field the CLI's result object might carry, all optional, passthrough so we never
// reject a shape we don't recognise — §9: unverifiable fields become `null`, never invented.
export const CLAUDE_RESULT_SHAPE = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    num_turns: z.unknown().optional(),
    api_error_status: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: z.unknown().optional(),
        output_tokens: z.unknown().optional(),
        cache_creation_input_tokens: z.unknown().optional(),
        cache_read_input_tokens: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    total_cost_usd: z.unknown().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const RATE_LIMIT_INFO_SHAPE = z
  .object({
    status: z.string().optional(),
    utilization: z.number().optional(),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
  })
  .passthrough();

// Heuristic: binding decision 4 — a machine-readable quota status now exists
// (rate_limit_event.rate_limit_info), so these regexes are DEMOTED to fallback (precedence
// tiers 3 and 4), consulted only when neither rate_limit_event nor api_error_status matched.
const QUOTA_USAGE_LIMIT = /usage limit/i;
// Heuristic: alternate wording observed for subscription/plan exhaustion errors.
const QUOTA_EXCEEDED = /quota exceeded/i;
// Heuristic: sustained load can surface as a rate limit that is really quota exhaustion.
const QUOTA_RATE_LIMIT = /rate limit exceeded/i;
// Heuristic: billing-related balance depletion phrasing.
const QUOTA_CREDIT_BALANCE = /credit balance is too low/i;

export const QUOTA_SIGNATURES: readonly RegExp[] = [
  QUOTA_USAGE_LIMIT,
  QUOTA_EXCEEDED,
  QUOTA_RATE_LIMIT,
  QUOTA_CREDIT_BALANCE,
];

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

export function mapTelemetry(raw: unknown, wallSeconds: number): ExecutorTelemetry {
  const parsed = CLAUDE_RESULT_SHAPE.safeParse(raw);
  const data = parsed.success ? parsed.data : {};
  const usage = data.usage;

  const cacheReadTokens =
    usage !== undefined && isNonNegativeInt(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : null;
  const cacheCreationTokens =
    usage !== undefined && isNonNegativeInt(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : null;
  const directInputTokens =
    usage !== undefined && isNonNegativeInt(usage.input_tokens) ? usage.input_tokens : null;

  // finding 3/row 5: `usage.input_tokens` alone under-reports by orders of magnitude — sum
  // in the present, valid cache figures. `null` only when all three are absent or ill-typed.
  const presentInputParts = [directInputTokens, cacheCreationTokens, cacheReadTokens].filter(
    (v): v is number => v !== null,
  );
  const inputTokens = presentInputParts.length > 0
    ? presentInputParts.reduce((sum, v) => sum + v, 0)
    : null;

  return {
    turns: isNonNegativeInt(data.num_turns) ? data.num_turns : null,
    inputTokens,
    outputTokens:
      usage !== undefined && isNonNegativeInt(usage.output_tokens) ? usage.output_tokens : null,
    cacheReadTokens,
    cacheCreationTokens,
    wallSeconds,
  };
}

function isRecordWithType(v: unknown): v is { type?: unknown } {
  return v !== null && typeof v === 'object';
}

/** finding row 4: the result line is selected by `type === 'result'`, last wins — never by
 *  "last line that parsed", which is not guaranteed to be the result now that
 *  `rate_limit_event` exists with no ordering promise. */
export function selectResultLine(lines: readonly unknown[]): unknown {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isRecordWithType(line) && line.type === 'result') {
      return line;
    }
  }
  return null;
}

/** finding row 2: the last `rate_limit_event.rate_limit_info` — the primary quota signal. */
export function selectRateLimitInfo(lines: readonly unknown[]): unknown {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isRecordWithType(line) && line.type === 'rate_limit_event') {
      const info = (line as { rate_limit_info?: unknown }).rate_limit_info;
      return info ?? null;
    }
  }
  return null;
}

function isoFromUnixSeconds(seconds: number): IsoTimestamp {
  return new Date(seconds * 1000).toISOString() as IsoTimestamp;
}

function buildRateLimitObservation(
  rateLimitInfoRaw: unknown,
  account: AccountId,
): QuotaObservation | null {
  if (rateLimitInfoRaw === null || rateLimitInfoRaw === undefined) {
    return null;
  }
  const parsed = RATE_LIMIT_INFO_SHAPE.safeParse(rateLimitInfoRaw);
  if (!parsed.success) {
    return null;
  }
  const data = parsed.data;
  return {
    account,
    source: 'rate-limit-event',
    status: data.status ?? null,
    utilization: data.utilization ?? null,
    windowKind: data.rateLimitType ?? null,
    resetsAt: data.resetsAt !== undefined ? isoFromUnixSeconds(data.resetsAt) : null,
  };
}

function textMatchesQuotaSignature(text: string): boolean {
  return QUOTA_SIGNATURES.some((re) => re.test(text));
}

/**
 * Quota detection precedence, first match wins (finding row 5). Gated on the run having
 * FAILED (binding decision "Quota detection is gated on the run having failed"): a clean
 * exit 0 + result/success + is_error !== true run is never quota_exhausted, whatever
 * `rate_limit_event` said.
 */
function computeDetectedQuota(o: {
  cleanSuccess: boolean;
  rateLimitObservation: QuotaObservation | null;
  resultLine: unknown;
  stderrTail: string;
  account: AccountId;
}): QuotaObservation | null {
  if (o.cleanSuccess) {
    return null;
  }
  if (
    o.rateLimitObservation !== null &&
    o.rateLimitObservation.status !== null &&
    !(RATE_LIMIT_ALLOWED_STATUSES as readonly string[]).includes(o.rateLimitObservation.status)
  ) {
    return o.rateLimitObservation;
  }
  const resultParsed = CLAUDE_RESULT_SHAPE.safeParse(o.resultLine);
  const apiErrorStatus = resultParsed.success ? resultParsed.data.api_error_status : undefined;
  if (apiErrorStatus === 429) {
    return {
      account: o.account,
      source: 'api-error-status',
      status: null,
      utilization: null,
      windowKind: null,
      resetsAt: null,
    };
  }
  if (textMatchesQuotaSignature(JSON.stringify(o.resultLine))) {
    return {
      account: o.account,
      source: 'stream-regex',
      status: null,
      utilization: null,
      windowKind: null,
      resetsAt: null,
    };
  }
  if (textMatchesQuotaSignature(o.stderrTail)) {
    return {
      account: o.account,
      source: 'stderr-regex',
      status: null,
      utilization: null,
      windowKind: null,
      resetsAt: null,
    };
  }
  return null;
}

function isGaveUp(raw: unknown): boolean {
  const parsed = CLAUDE_RESULT_SHAPE.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  return parsed.data.is_error === true || parsed.data.subtype !== 'success';
}

function isCleanSuccess(resultLine: unknown, exitCode: number | null): boolean {
  if (exitCode !== 0) {
    return false;
  }
  const parsed = CLAUDE_RESULT_SHAPE.safeParse(resultLine);
  return parsed.success && parsed.data.subtype === 'success' && parsed.data.is_error !== true;
}

function permissionModeFor(
  intent: SandboxIntent,
  override: PermissionMode | null,
): PermissionMode {
  if (override !== null) {
    return override;
  }
  return intent === 'workspace-write' ? 'acceptEdits' : 'plan'; // ASSUMPTION A3
}

function buildArgv(o: ClaudeCodeOptions, sessionId: string): string[] {
  return [
    o.bin,
    ...o.argvPrefix,
    '-p',
    '--output-format',
    o.outputFormat,
    ...(o.outputFormat === 'stream-json' ? ['--verbose'] : []),
    '--permission-mode',
    permissionModeFor(o.sandboxIntent, o.permissionModeOverride),
    '--session-id',
    sessionId,
    ...(o.model !== null ? ['--model', o.model] : []),
    ...(o.effort !== null ? ['--effort', o.effort] : []),
    ...o.addDirs.flatMap((d) => ['--add-dir', d]),
    ...(o.maxBudgetUsd !== null ? ['--max-budget-usd', String(o.maxBudgetUsd)] : []),
  ];
}

async function writeTranscript(
  dir: string | null,
  sessionId: string,
  content: string,
): Promise<string | null> {
  if (dir === null) {
    return null;
  }
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.ndjson`);
  await writeFile(path, content, 'utf8');
  return path;
}

export class ClaudeCodeExecutor implements Executor, RawRunSource {
  readonly id: ExecutorInstanceId;
  readonly type = 'claude-code';
  readonly account: AccountId;
  readonly capabilities: ExecutorCapabilities = CLAUDE_CAPABILITIES;
  lastRun: RawRunRecord | null = null;

  private readonly options: ClaudeCodeOptions;

  constructor(o: ClaudeCodeOptions) {
    this.id = o.id;
    this.account = o.account;
    this.options = o;
  }

  async run(i: ExecutorInput): Promise<ExecutorResult> {
    this.lastRun = null;
    const sessionId = this.options.ids.sessionUuid();
    const argv = buildArgv(this.options, sessionId);
    const startedAt = this.options.clock.now();
    const startMonotonic = this.options.clock.monotonicMs();
    const account = this.options.account;

    const result = await new Promise<{
      status: ExecutorStatus;
      telemetry: ExecutorTelemetry;
      lastRun: RawRunRecord;
    }>((resolve, reject) => {
      let settled = false;
      let killedMode: RawRunRecord['killed'] = 'none';
      let turnCapTriggered = false;
      let wallTimeoutTriggered = false;
      let abortTriggered = false;
      let spawnErrorOccurred = false;
      let observedTurns = 0;
      let stdoutLineBuffer = '';
      let fullStdout = '';
      const parsedLines: unknown[] = [];
      const messageIds = new Set<string>();
      let stderrTail = '';
      let graceTimer: NodeJS.Timeout | null = null;

      const child = spawn(this.options.bin, argv.slice(1), {
        cwd: i.workdir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...this.options.env },
      });

      const sendGroupSignal = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) {
          return;
        }
        try {
          process.kill(-child.pid, sig);
        } catch {
          // the process group is already gone
        }
      };

      const triggerKill = (): void => {
        if (killedMode !== 'none') {
          return;
        }
        killedMode = 'sigterm';
        sendGroupSignal('SIGTERM');
        graceTimer = setTimeout(() => {
          killedMode = 'sigkill';
          sendGroupSignal('SIGKILL');
        }, this.options.sigtermGraceSeconds * 1000);
      };

      const wallTimer = setTimeout(
        () => {
          wallTimeoutTriggered = true;
          triggerKill();
        },
        i.budget.maxWallSeconds * 1000,
      );

      const onAbort = (): void => {
        abortTriggered = true;
        triggerKill();
      };
      if (i.signal.aborted) {
        onAbort();
      } else {
        i.signal.addEventListener('abort', onAbort);
      }

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          return;
        }
        try {
          const parsed: unknown = JSON.parse(trimmed);
          parsedLines.push(parsed);
          for (const output of decodeOutput(parsed)) emitOutput(this.options.onOutput, { executor: this.id, ...output });
          if (isRecordWithType(parsed) && parsed.type === 'assistant') {
            const messageId = (parsed as { message?: { id?: string } }).message?.id;
            if (messageId !== undefined && messageIds.has(messageId)) return;
            if (messageId !== undefined) messageIds.add(messageId);
            observedTurns += 1;
            if (observedTurns > i.budget.maxTurns) {
              turnCapTriggered = true;
              triggerKill();
            }
          }
        } catch {
          emitOutput(this.options.onOutput, { executor: this.id, kind: 'activity', text: trimmed });
          // not a JSON line; still captured verbatim in the transcript below
        }
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        fullStdout += text;
        stdoutLineBuffer += text;
        let newlineIndex = stdoutLineBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          processLine(stdoutLineBuffer.slice(0, newlineIndex));
          stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutLineBuffer.indexOf('\n');
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text: string) => {
        emitOutput(this.options.onOutput, { executor: this.id, kind: 'error', text });
        stderrTail += text;
        if (stderrTail.length > 4096) {
          stderrTail = stderrTail.slice(-4096);
        }
      });

      child.on('error', (error) => {
        emitOutput(this.options.onOutput, { executor: this.id, kind: 'error', text: error.message });
        spawnErrorOccurred = true;
        stderrTail = `${stderrTail}${stderrTail.length > 0 ? '\n' : ''}${error.message}`.slice(-4096);
      });

      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        i.signal.removeEventListener('abort', onAbort);
        clearTimeout(wallTimer);
        if (graceTimer !== null) {
          clearTimeout(graceTimer);
        }

        if (stdoutLineBuffer.length > 0) {
          processLine(stdoutLineBuffer);
          stdoutLineBuffer = '';
        }

        // finding row 4: select by `type === 'result'`, last wins. `lastParsedLine` is
        // deleted — it is not guaranteed to be the result now that `rate_limit_event`
        // exists with no ordering promise. Fall back to the whole-stdout parse only when
        // no line carries `type: 'result'` (the `--output-format json` path).
        let finalResultRaw = selectResultLine(parsedLines);
        if (finalResultRaw === null) {
          const wholeTrimmed = fullStdout.trim();
          if (wholeTrimmed.length > 0) {
            try {
              finalResultRaw = JSON.parse(wholeTrimmed);
            } catch {
              finalResultRaw = null;
            }
          }
        }

        const rateLimitInfoRaw = selectRateLimitInfo(parsedLines);
        const rateLimitObservation = buildRateLimitObservation(rateLimitInfoRaw, account);
        const cleanSuccess = isCleanSuccess(finalResultRaw, code);
        const detectedQuota = computeDetectedQuota({
          cleanSuccess,
          rateLimitObservation,
          resultLine: finalResultRaw,
          stderrTail,
          account,
        });
        // finding row 2, point 4: recorded on every run, success or not — utilization is
        // useful before it is fatal.
        const quotaForRecord = detectedQuota ?? rateLimitObservation;

        let status: ExecutorStatus;
        let failureKind: RawRunRecord['failureKind'] = null;

        if (turnCapTriggered) {
          status = 'budget_turns';
        } else if (wallTimeoutTriggered) {
          status = 'budget_wall';
          failureKind = 'timeout';
        } else if (abortTriggered) {
          status = 'crashed';
        } else if (detectedQuota !== null) {
          status = 'quota_exhausted';
          failureKind = 'quota';
        } else if (spawnErrorOccurred || code !== 0) {
          status = 'crashed';
          failureKind = 'nonzero-exit';
        } else if (finalResultRaw === null) {
          status = 'crashed';
          failureKind = 'unparseable';
        } else if (isGaveUp(finalResultRaw)) {
          status = 'gave_up';
        } else {
          status = 'completed';
        }

        const finishedAt = this.options.clock.now();
        const wallSeconds = (this.options.clock.monotonicMs() - startMonotonic) / 1000;
        const telemetry = mapTelemetry(finalResultRaw, wallSeconds);

        const resultParsed = CLAUDE_RESULT_SHAPE.safeParse(finalResultRaw);
        const finalMessage =
          resultParsed.success && resultParsed.data.result !== undefined
            ? resultParsed.data.result
            : null;

        void writeTranscript(this.options.transcriptDir, sessionId, fullStdout).then(
          (transcriptPath) => {
            resolve({
              status,
              telemetry,
              lastRun: {
                commandLine: argv,
                exitCode: code,
                signal,
                killed: killedMode,
                startedAt,
                finishedAt,
                observedTurns,
                failureKind,
                stderrTail,
                sessionId,
                transcriptPath,
                rawResult: finalResultRaw,
                finalMessage,
                quota: quotaForRecord,
              },
            });
          },
          (error: unknown) => reject(new Error(`claude: could not save transcript: ${String(error)}`)),
        );
      });

      child.stdin.on('error', () => {});
      child.stdin.write(i.prompt);
      child.stdin.end();
    });

    this.lastRun = result.lastRun;
    return { status: result.status, telemetry: result.telemetry };
  }
}
