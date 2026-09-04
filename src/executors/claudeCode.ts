import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Clock } from '../core/clock.js';
import type { IdMinter } from '../core/idgen.js';
import type { Logger } from '../logging.js';
import type {
  Executor,
  ExecutorRunInput,
  ExecutorRunResult,
  ExecutorStatus,
  ExecutorTelemetry,
  RawRunRecord,
  RawRunSource,
} from './executor.js';

export const DEFAULT_SIGTERM_GRACE_SECONDS = 10;

export interface ClaudeCodeOptions {
  bin: string;
  model: string | null;
  permissionMode: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'manual' | 'dontAsk' | 'plan';
  outputFormat: 'json' | 'stream-json';
  addDirs: readonly string[];
  maxBudgetUsd: number | null;
  sigtermGraceSeconds: number;
  transcriptDir: string | null;
  clock: Clock;
  ids: IdMinter;
  logger: Logger;
}

// Every field the CLI's result object might carry, all optional, passthrough so we never
// reject a shape we don't recognise — §9: unverifiable fields become `null`, never invented.
export const CLAUDE_RESULT_SHAPE = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    num_turns: z.unknown().optional(),
    usage: z
      .object({
        input_tokens: z.unknown().optional(),
        output_tokens: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    total_cost_usd: z.unknown().optional(),
    result: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

// Heuristic: binding decision 4 — `claude` v2.1.247 has no machine-readable quota status,
// so quota exhaustion can only be detected by matching error text the CLI happens to emit.
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
  return {
    turns: isNonNegativeInt(data.num_turns) ? data.num_turns : null,
    inputTokens: usage !== undefined && isNonNegativeInt(usage.input_tokens)
      ? usage.input_tokens
      : null,
    outputTokens: usage !== undefined && isNonNegativeInt(usage.output_tokens)
      ? usage.output_tokens
      : null,
    wallSeconds,
  };
}

function matchesQuotaSignature(raw: unknown, stderrTail: string): boolean {
  const text = `${JSON.stringify(raw)} ${stderrTail}`;
  return QUOTA_SIGNATURES.some((re) => re.test(text));
}

function isGaveUp(raw: unknown): boolean {
  const parsed = CLAUDE_RESULT_SHAPE.safeParse(raw);
  if (!parsed.success) {
    return false;
  }
  return parsed.data.is_error === true || parsed.data.subtype !== 'success';
}

function buildArgv(o: ClaudeCodeOptions, sessionId: string): string[] {
  return [
    o.bin,
    '-p',
    '--output-format',
    o.outputFormat,
    ...(o.outputFormat === 'stream-json' ? ['--verbose'] : []),
    '--permission-mode',
    o.permissionMode,
    '--session-id',
    sessionId,
    ...(o.model !== null ? ['--model', o.model] : []),
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
  readonly id = 'claude-code';
  lastRun: RawRunRecord | null = null;

  private readonly options: ClaudeCodeOptions;

  constructor(o: ClaudeCodeOptions) {
    this.options = o;
  }

  async run(i: ExecutorRunInput): Promise<ExecutorRunResult> {
    const sessionId = this.options.ids.sessionUuid();
    const argv = buildArgv(this.options, sessionId);
    const startedAt = this.options.clock.now();
    const startMonotonic = this.options.clock.monotonicMs();

    const result = await new Promise<{
      status: ExecutorStatus;
      telemetry: ExecutorTelemetry;
      lastRun: RawRunRecord;
    }>((resolve) => {
      let settled = false;
      let killedMode: RawRunRecord['killed'] = 'none';
      let turnCapTriggered = false;
      let wallTimeoutTriggered = false;
      let abortTriggered = false;
      let spawnErrorOccurred = false;
      let observedTurns = 0;
      let stdoutLineBuffer = '';
      let fullStdout = '';
      let lastParsedLine: unknown = null;
      let stderrTail = '';
      let graceTimer: NodeJS.Timeout | null = null;

      const child = spawn(this.options.bin, argv.slice(1), {
        cwd: i.workdir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
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
          lastParsedLine = parsed;
          if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as { type?: unknown }).type === 'assistant'
          ) {
            observedTurns += 1;
            if (observedTurns > i.budget.maxTurns) {
              turnCapTriggered = true;
              triggerKill();
            }
          }
        } catch {
          // not a JSON line; still captured verbatim in the transcript below
        }
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        fullStdout += text;
        stdoutLineBuffer += text;
        let newlineIndex = stdoutLineBuffer.indexOf('\n');
        while (newlineIndex >= 0) {
          processLine(stdoutLineBuffer.slice(0, newlineIndex));
          stdoutLineBuffer = stdoutLineBuffer.slice(newlineIndex + 1);
          newlineIndex = stdoutLineBuffer.indexOf('\n');
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail += chunk.toString('utf8');
        if (stderrTail.length > 4096) {
          stderrTail = stderrTail.slice(-4096);
        }
      });

      child.on('error', () => {
        spawnErrorOccurred = true;
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

        let finalResultRaw: unknown = null;
        const wholeTrimmed = fullStdout.trim();
        if (wholeTrimmed.length > 0) {
          try {
            finalResultRaw = JSON.parse(wholeTrimmed);
          } catch {
            finalResultRaw = lastParsedLine;
          }
        }

        let status: ExecutorStatus;
        let failureKind: RawRunRecord['failureKind'] = null;

        if (turnCapTriggered) {
          status = 'budget_turns';
        } else if (wallTimeoutTriggered) {
          status = 'budget_wall';
          failureKind = 'timeout';
        } else if (abortTriggered) {
          status = 'crashed';
        } else if (spawnErrorOccurred || code !== 0) {
          status = 'crashed';
          failureKind = 'nonzero-exit';
        } else if (finalResultRaw === null) {
          status = 'crashed';
          failureKind = 'unparseable';
        } else if (matchesQuotaSignature(finalResultRaw, stderrTail)) {
          status = 'crashed';
          failureKind = 'quota';
        } else if (isGaveUp(finalResultRaw)) {
          status = 'gave_up';
        } else {
          status = 'completed';
        }

        const finishedAt = this.options.clock.now();
        const wallSeconds = (this.options.clock.monotonicMs() - startMonotonic) / 1000;
        const telemetry = mapTelemetry(finalResultRaw, wallSeconds);

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
              },
            });
          },
        );
      });

      child.stdin.write(i.prompt);
      child.stdin.end();
    });

    this.lastRun = result.lastRun;
    return { status: result.status, telemetry: result.telemetry };
  }
}
