import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../core/hash.js';
import type { CauseId, OracleSweepId, TaskId } from '../core/ids.js';
import type { OracleKind, OracleScope, OracleResultStatus } from '../core/events.js';
import type { AppendFn } from '../agents/agent.js';
import type { OracleResultState } from '../state/workitem.js';

const ORACLE_ORDER = ['build', 'typecheck', 'lint', 'test'] as const satisfies readonly OracleKind[];
const SIGTERM_GRACE_MS = 1_000;

export interface OracleRunnerInput {
  readonly scope: OracleScope;
  readonly taskId: TaskId | null;
  readonly workdir: string;
  readonly commands: Readonly<Record<OracleKind, string | null>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly evidenceDir: string;
  readonly append: AppendFn;
  readonly causeId: CauseId | null;
}

export interface OracleRunnerResult {
  readonly sweepId: OracleSweepId;
  readonly outcome: 'passed' | 'failed' | 'aborted';
  readonly failedKind: OracleKind | null;
  readonly results: readonly OracleResultState[];
}

interface CommandResult {
  readonly status: OracleResultStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly durationMs: number;
}

async function writeEvidence(evidenceDir: string, stream: 'stdout' | 'stderr', body: Buffer): Promise<{
  readonly sha256: string;
  readonly path: string;
  readonly bytes: number;
}> {
  const sha256 = sha256Hex(body);
  const path = join(evidenceDir, `${sha256}.${stream}`);
  await mkdir(evidenceDir, { recursive: true });
  try {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err: unknown) {
    if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') {
      throw err;
    }
    const existing = await readFile(path);
    if (!existing.equals(body) || sha256Hex(existing) !== sha256) {
      throw new Error(`content-addressed evidence mismatch: ${path}`);
    }
  }
  return { sha256, path, bytes: body.byteLength };
}

function oracleActor(kind: OracleKind): { readonly kind: 'oracle'; readonly id: string } {
  return { kind: 'oracle', id: kind };
}

async function runCommand(command: string, input: OracleRunnerInput): Promise<CommandResult> {
  if (input.signal.aborted) {
    return { status: 'aborted', exitCode: null, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), durationMs: 0 };
  }

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, {
      cwd: input.workdir,
      env: process.env,
      shell: true,
      // With shell commands, killing only the shell leaves background grandchildren alive
      // (and frequently keeps their stdout pipe open forever). A detached POSIX child is
      // its own process group, which gives the timeout ladder one precise kill target.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let aborted = false;
    let spawnError = false;
    let settled = false;
    let killSent = false;
    let deferredClose: { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null } | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      input.signal.removeEventListener('abort', abort);
      const status: OracleResultStatus = aborted ? 'aborted'
        : timedOut ? 'timed-out'
        : spawnError ? 'spawn-error'
        : exitCode === 0 ? 'passed'
        : 'failed';
      resolve({
        status,
        exitCode,
        signal: timedOut && killSent ? 'SIGKILL' : signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      // `close` reports the shell, not every member of its detached process group. Keep the
      // grace timer alive when the shell exits on TERM: a descendant can have closed stdio
      // and would otherwise survive because `finish` cancelled the pending group SIGKILL.
      if ((timedOut || aborted) && !killSent) {
        deferredClose = { exitCode, signal };
        return;
      }
      settle(exitCode, signal);
    };

    const signalGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        // The process may win the race to exit; close/error will settle the result.
      }
    };
    const terminate = (isAbort: boolean): void => {
      if (settled) return;
      aborted = aborted || isAbort;
      timedOut = timedOut || !isAbort;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => {
        killSent = true;
        signalGroup('SIGKILL');
        if (deferredClose !== null) {
          settle(deferredClose.exitCode, deferredClose.signal);
          return;
        }
        // A shell can keep Node's `close` event pending even after every process in the
        // group has been signalled (notably with an orphaned, closed-stdio descendant).
        // The terminal group kill is the decisive observation here; do not let an unrelated
        // pipe-close race keep the oracle sweep or supervisor loop alive.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle(null, 'SIGKILL');
      }, SIGTERM_GRACE_MS);
    };
    const abort = (): void => terminate(true);

    child.stdout?.on('data', (data: Buffer) => stdout.push(Buffer.from(data)));
    child.stderr?.on('data', (data: Buffer) => stderr.push(Buffer.from(data)));
    child.on('error', () => {
      spawnError = true;
      finish(null, null);
    });
    child.on('close', finish);
    input.signal.addEventListener('abort', abort, { once: true });
    timeoutTimer = setTimeout(() => terminate(false), input.timeoutMs);
  });
}

export async function runOracleSweep(input: OracleRunnerInput): Promise<OracleRunnerResult> {
  const declared = ORACLE_ORDER.map((kind) => {
    const command = input.commands[kind];
    return { kind, command, sha256: command === null ? null : sha256Hex(command) };
  });
  const started = await input.append({
    type: 'OracleSweepStarted',
    data: { scope: input.scope, task_id: input.taskId, cause_id: input.causeId, commands: declared },
    actor: oracleActor('build'),
  });
  const sweepId: OracleSweepId = started.eventId;
  const results: OracleResultState[] = [];
  let failedKind: OracleKind | null = null;
  let outcome: 'passed' | 'failed' | 'aborted' = 'passed';

  for (const kind of ORACLE_ORDER) {
    const command = input.commands[kind];
    if (command === null) continue;
    if (input.signal.aborted) {
      outcome = 'aborted';
      break;
    }
    const execution = await runCommand(command, input);
    const [stdout, stderr] = await Promise.all([
      writeEvidence(input.evidenceDir, 'stdout', execution.stdout),
      writeEvidence(input.evidenceDir, 'stderr', execution.stderr),
    ]);
    const event = await input.append({
      type: 'OracleResultRecorded',
      data: {
        sweep_id: sweepId, scope: input.scope, task_id: input.taskId, kind, command,
        command_sha256: sha256Hex(command), status: execution.status, exit_code: execution.exitCode,
        signal: execution.signal, duration_ms: execution.durationMs, stdout, stderr,
      },
      actor: oracleActor(kind),
    });
    results.push({
      eventId: event.eventId, kind, status: execution.status, command, commandSha256: sha256Hex(command),
      exitCode: execution.exitCode, signal: execution.signal, durationMs: execution.durationMs, stdout, stderr,
    });
    if (execution.status === 'aborted') {
      outcome = 'aborted';
      break;
    }
    if (execution.status !== 'passed') {
      outcome = 'failed';
      failedKind = kind;
      break;
    }
  }

  await input.append({
    type: 'OracleSweepCompleted',
    data: {
      sweep_id: sweepId, scope: input.scope, task_id: input.taskId, outcome, failed_kind: failedKind,
      result_event_ids: results.map((result) => result.eventId),
    },
    actor: oracleActor(failedKind ?? 'build'),
  });
  return { sweepId, outcome, failedKind, results };
}
