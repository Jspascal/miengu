import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Clock } from '../core/clock.js';
import type { SandboxIntent } from '../core/events.js';
import type { IdMinter } from '../core/idgen.js';
import type { AccountId, ExecutorInstanceId } from '../core/ids.js';
import type { Logger } from '../logging.js';
import { QUOTA_SIGNATURES } from './claudeCode.js';
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

export interface CodexCliOptions {
  id: ExecutorInstanceId;
  account: AccountId;
  bin: string;
  argvPrefix: readonly string[];
  env: Readonly<Record<string, string>>;
  model: string | null;
  /** Shipped as `-c model_reasoning_effort=<v>`. There is NO reasoning-effort flag — see §16.4. */
  reasoningEffort: string | null;
  sandboxIntent: SandboxIntent;
  /** Additional `-c key=value` overrides, passed verbatim. */
  extraConfig: readonly string[];
  addDirs: readonly string[];
  sigtermGraceSeconds: number;
  transcriptDir: string | null;
  clock: Clock;
  ids: IdMinter;
  logger: Logger;
}

export const CODEX_CAPABILITIES: ExecutorCapabilities = {
  nativeStructuredOutput: true, // VERIFIED: `codex exec --output-schema <FILE>` (0.149.1)
  resumableSessions: true, // `codex exec resume <id>` — declared, NOT used in Phase 2
  sandboxModes: ['read-only', 'workspace-write'],
};

/**
 * Event `type` values that mark one agent turn.
 *
 * `T1` as of spike **S5** (`docs/002-executor-findings.md`, captures at
 * `docs/captures/s5-codex-success.jsonl`): a success run emits exactly
 * `thread.started -> turn.started -> item.completed -> turn.completed`. Turns are counted on
 * `turn.started` because it is the only event guaranteed to precede the work of a turn; a run
 * killed mid-turn still has its turn counted.
 */
export const CODEX_TURN_EVENT_TYPES: readonly string[] = ['turn.started'];

/**
 * Event `type` values that are TERMINAL failures and may carry a quota signal.
 *
 * `T1` as of spike **S5** (capture at `docs/captures/s5-codex-failure.jsonl`): a failing run
 * emits `error` and `turn.failed`, both carrying a JSON-encoded `message`. Deliberately EXCLUDES
 * `item.completed`: S5 finding 3 recorded an `item.completed` whose `item.type === 'error'`
 * appearing mid-run, after which the turn proceeded normally. Treating that as terminal would
 * abort recoverable runs.
 */
export const CODEX_QUOTA_EVENT_TYPES: readonly string[] = ['error', 'turn.failed'];

/** A non-interactive `codex exec` cannot answer an MCP OAuth challenge and may stay alive forever. */
export function isFatalCodexAuthOutput(text: string): boolean {
  return /worker quit with fatal:[\s\S]*AuthRequired\(AuthRequiredError/i.test(text);
}

/** `thread.started.thread_id` — the id `codex exec resume <id>` takes. */
function selectThreadId(lines: readonly unknown[]): string | null {
  for (const line of lines) {
    if (line !== null && typeof line === 'object') {
      const rec = line as { type?: unknown; thread_id?: unknown };
      if (rec.type === 'thread.started' && typeof rec.thread_id === 'string') {
        return rec.thread_id;
      }
    }
  }
  return null;
}

/** The last `turn.completed`, which carries `usage`. */
function selectTurnCompleted(lines: readonly unknown[]): unknown {
  let found: unknown = null;
  for (const line of lines) {
    if (line !== null && typeof line === 'object' && (line as { type?: unknown }).type === 'turn.completed') {
      found = line;
    }
  }
  return found;
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Codex `usage.input_tokens` ALREADY INCLUDES `cached_input_tokens` (S5, telemetry section).
 * This is the opposite of Claude Code, whose `input_tokens` EXCLUDES cache and must have it
 * summed in. Summing here would double-count — the two adapters deliberately do not share a
 * telemetry mapping.
 */
export function mapTelemetry(turnCompleted: unknown, wallSeconds: number): ExecutorTelemetry {
  const usage =
    turnCompleted !== null && typeof turnCompleted === 'object'
      ? ((turnCompleted as { usage?: unknown }).usage ?? null)
      : null;
  if (usage === null || typeof usage !== 'object') {
    return {
      turns: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      wallSeconds,
    };
  }
  const u = usage as Record<string, unknown>;
  return {
    turns: null, // codex reports no turn total; the adapter's own count is on RawRunRecord
    inputTokens: isNonNegativeInt(u['input_tokens']) ? u['input_tokens'] : null,
    outputTokens: isNonNegativeInt(u['output_tokens']) ? u['output_tokens'] : null,
    cacheReadTokens: isNonNegativeInt(u['cached_input_tokens']) ? u['cached_input_tokens'] : null,
    cacheCreationTokens: isNonNegativeInt(u['cache_write_input_tokens'])
      ? u['cache_write_input_tokens']
      : null,
    wallSeconds,
  };
}

/** The terminal failure line, if any. */
function selectTerminalFailure(lines: readonly unknown[]): unknown {
  for (const line of lines) {
    if (
      line !== null &&
      typeof line === 'object' &&
      CODEX_QUOTA_EVENT_TYPES.includes(String((line as { type?: unknown }).type))
    ) {
      return line;
    }
  }
  return null;
}

/**
 * Quota detection, gated on the run having FAILED — identical policy to `claudeCode.ts`.
 * A clean exit-0 run is never `quota_exhausted`, whatever its text happened to contain.
 *
 * S5 verified the failure SHAPE (`error` / `turn.failed`, JSON-encoded `message` carrying
 * `status` and `error.type`) but NOT the `status`/`error.type` values at genuine quota
 * exhaustion — that is the still-`PENDING` half of S3/S5. Detection therefore matches
 * `QUOTA_SIGNATURES` against the serialised text rather than asserting a vocabulary.
 */
function detectQuota(
  lines: readonly unknown[],
  stderrTail: string,
  account: AccountId,
  failed: boolean,
): QuotaObservation | null {
  if (!failed) {
    return null;
  }
  const terminal = selectTerminalFailure(lines);
  if (terminal !== null && QUOTA_SIGNATURES.some((re) => re.test(JSON.stringify(terminal)))) {
    return {
      account,
      source: 'provider-event',
      status: null, // S5: the provider's quota status string is not yet verified
      utilization: null,
      windowKind: null,
      resetsAt: null,
    };
  }
  const allText = `${JSON.stringify(lines)} ${stderrTail}`;
  if (QUOTA_SIGNATURES.some((re) => re.test(allText))) {
    return {
      account,
      source: 'stream-regex',
      status: null,
      utilization: null,
      windowKind: null,
      resetsAt: null,
    };
  }
  return null;
}

export function buildArgv(o: CodexCliOptions, i: ExecutorInput, hermetic: boolean): string[] {
  return [
    o.bin,
    ...o.argvPrefix,
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-C',
    i.workdir,
    '-s',
    o.sandboxIntent, // 1:1 with SandboxIntent — codex speaks this dialect natively
    ...(hermetic ? ['--ephemeral'] : []),
    // A supervisor run must not inherit unrelated interactive MCP servers from the
    // operator's config. Provider authentication still comes from CODEX_HOME.
    '--ignore-user-config',
    ...(o.model !== null ? ['-m', o.model] : []),
    // §16.4 + docs/002-executor-findings.md: codex has NO reasoning-effort flag.
    ...(o.reasoningEffort !== null ? ['-c', `model_reasoning_effort=${o.reasoningEffort}`] : []),
    ...o.extraConfig.flatMap((kv) => ['-c', kv]),
    ...o.addDirs.flatMap((d) => ['--add-dir', d]),
    ...(i.outputSchemaPath !== null ? ['--output-schema', i.outputSchemaPath] : []),
    ...(i.finalMessagePath !== null ? ['-o', i.finalMessagePath] : []),
    '-', // read the prompt from stdin
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

/**
 * `--output-last-message` exists precisely so the final message is not guesswork; the JSONL is
 * never scraped for it. Missing or empty reads back as `null`.
 */
async function readFinalMessage(path: string | null): Promise<string | null> {
  if (path === null) {
    return null;
  }
  try {
    const text = await readFile(path, 'utf8');
    return text.length === 0 ? null : text;
  } catch {
    return null;
  }
}

export class CodexCliExecutor implements Executor, RawRunSource {
  readonly id: ExecutorInstanceId;
  readonly type = 'codex';
  readonly account: AccountId;
  readonly capabilities: ExecutorCapabilities = CODEX_CAPABILITIES;
  lastRun: RawRunRecord | null = null;

  private readonly options: CodexCliOptions;

  constructor(o: CodexCliOptions) {
    this.id = o.id;
    this.account = o.account;
    this.options = o;
  }

  async run(i: ExecutorInput): Promise<ExecutorResult> {
    const sessionId = this.options.ids.sessionUuid();
    const hermetic = process.env['MIENGU_HERMETIC'] === '1';
    const argv = buildArgv(this.options, i, hermetic);
    const startedAt = this.options.clock.now();
    const startMonotonic = this.options.clock.monotonicMs();
    const account = this.options.account;

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
      let authFailureTriggered = false;
      let observedTurns = 0;
      let sawTurnEvent = false;
      let stdoutLineBuffer = '';
      let fullStdout = '';
      const parsedLines: unknown[] = [];
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

      const triggerKill = (graceSeconds = this.options.sigtermGraceSeconds): void => {
        if (killedMode !== 'none') {
          return;
        }
        killedMode = 'sigterm';
        sendGroupSignal('SIGTERM');
        graceTimer = setTimeout(() => {
          killedMode = 'sigkill';
          sendGroupSignal('SIGKILL');
        }, graceSeconds * 1000);
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
          if (parsed !== null && typeof parsed === 'object') {
            const type = String((parsed as { type?: unknown }).type);
            if (CODEX_TURN_EVENT_TYPES.includes(type)) {
              sawTurnEvent = true;
              observedTurns += 1;
              if (observedTurns > i.budget.maxTurns) {
                turnCapTriggered = true;
                triggerKill();
              }
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

      // S5: codex writes failures to STDOUT, not stderr — stderr was empty even on a failing
      // run. Captured anyway so a spawn-level failure is not lost.
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail += chunk.toString('utf8');
        if (stderrTail.length > 4096) {
          stderrTail = stderrTail.slice(-4096);
        }
        if (!authFailureTriggered && isFatalCodexAuthOutput(stderrTail)) {
          authFailureTriggered = true;
          triggerKill(Math.min(1, this.options.sigtermGraceSeconds));
        }
      });

      child.on('error', (error) => {
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

        const terminalFailure = selectTerminalFailure(parsedLines);
        const failed = spawnErrorOccurred || code !== 0 || terminalFailure !== null;
        const detectedQuota = detectQuota(parsedLines, stderrTail, account, failed);
        const threadId = selectThreadId(parsedLines);
        const turnCompleted = selectTurnCompleted(parsedLines);

        // Honest degradation: if no turn event matched across the whole run, the cap was never
        // enforceable. Report `null` rather than a zero that would read as "the cap held".
        if (!sawTurnEvent) {
          this.options.logger.warn(
            { executorId: this.options.id, spike: 'S5' },
            'codex: no turn event matched CODEX_TURN_EVENT_TYPES; observedTurns is null and the turn cap was not enforced (wall timer still applies)',
          );
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
        } else if (authFailureTriggered) {
          status = 'crashed';
          failureKind = 'auth';
        } else if (detectedQuota !== null) {
          status = 'quota_exhausted';
          failureKind = 'quota';
        } else if (spawnErrorOccurred || code !== 0) {
          status = 'crashed';
          failureKind = 'nonzero-exit';
        } else if (terminalFailure !== null) {
          status = 'gave_up';
        } else if (turnCompleted === null) {
          status = 'crashed';
          failureKind = 'unparseable';
        } else {
          status = 'completed';
        }

        const finishedAt = this.options.clock.now();
        const wallSeconds = (this.options.clock.monotonicMs() - startMonotonic) / 1000;
        const telemetry = mapTelemetry(turnCompleted, wallSeconds);

        void Promise.all([
          writeTranscript(this.options.transcriptDir, sessionId, fullStdout),
          readFinalMessage(i.finalMessagePath),
        ]).then(([transcriptPath, finalMessage]) => {
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
              observedTurns: sawTurnEvent ? observedTurns : null,
              failureKind,
              stderrTail,
              sessionId: threadId ?? sessionId,
              transcriptPath,
              rawResult: turnCompleted ?? terminalFailure,
              finalMessage,
              quota: detectedQuota,
            },
          });
        });
      });

      // A pre-aborted signal can kill the process group (triggerKill, above) before this
      // write runs, closing the pipe out from under us; the resulting EPIPE lands on
      // 'error' asynchronously and must be swallowed rather than crashing as unhandled.
      child.stdin.on('error', () => {});
      child.stdin.write(i.prompt);
      child.stdin.end();
    });

    this.lastRun = result.lastRun;
    return { status: result.status, telemetry: result.telemetry };
  }
}
