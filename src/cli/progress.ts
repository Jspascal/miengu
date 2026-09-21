import type { MienguEvent } from '../core/events.js';

function compact(text: string, max = 240): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`;
}

/** Converts durable lifecycle events into a small operator-facing live feed. */
export function formatProgressEvent(event: MienguEvent): string | null {
  const prefix = `[${event.item_id}]`;
  switch (event.type) {
    case 'WorkItemCreated':
      return `${prefix} started ${event.data.title}`;
    case 'WorkItemResumed':
      return `${prefix} resumed after ${event.data.previous_reason}`;
    case 'StageEntered':
      return `${prefix} -> ${event.data.stage} (attempt ${String(event.data.attempt)})`;
    case 'ExecutorInvoked':
      return `${prefix} running ${event.data.role ?? event.data.stage} with ${event.data.executor_id}`;
    case 'ExecutorReturned':
      return event.data.status === 'completed'
        ? null
        : `${prefix} executor ${event.data.executor_id} returned ${event.data.status}`;
    case 'ArtifactValidationFailed':
      return `${prefix} ! ${event.data.stage} output invalid (attempt ${String(event.data.validation_attempt)}): ${compact(event.data.errors.join('; '))}`;
    case 'StageCompleted':
      return `${prefix} ok ${event.data.stage}`;
    case 'StageFailed':
      return `${prefix} x ${event.data.stage} failed (${event.data.reason}): ${compact(event.data.detail)}`;
    case 'CheckpointRaised':
      return null;
    case 'BudgetExhausted':
      return `${prefix} ! budget exhausted (${event.data.limit_kind}): ${compact(event.data.detail)}`;
    case 'FailureAttempted':
      return `${prefix} ${event.data.level} remediation attempt recorded (${String(event.data.attempt)}/${String(event.data.limit)})`;
    case 'EscalationAdvanced':
      return `${prefix} escalating ${event.data.from_level} -> ${event.data.to_level}: ${compact(event.data.reason)}`;
    case 'OracleResultRecorded':
      return event.data.status === 'passed'
        ? null
        : `${prefix} x ${event.data.kind} check ${event.data.status}${event.data.exit_code === null ? '' : ` (exit ${String(event.data.exit_code)})`}`;
    case 'WorkItemParked':
      return `${prefix} paused (${event.data.reason}): ${compact(event.data.detail)}${event.data.resumable ? ' [resumable]' : ''}`;
    case 'WorkItemFailed':
      return `${prefix} failed (${event.data.reason}): ${compact(event.data.detail)}`;
    case 'WorkItemCompleted':
      return `${prefix} completed`;
    case 'RunFinished':
      return `${prefix} run finished: ${event.data.outcome}`;
    default:
      return null;
  }
}

export type ProgressLineWriter = (line: string) => void;

/** Buffers consecutive blocking checkpoints so one architecture result cannot flood the terminal. */
export function createProgressReporter(
  write: ProgressLineWriter = (line) => process.stderr.write(`${line}\n`),
  heartbeatMs = 30_000,
): ((event: MienguEvent) => void) & { close(): void } {
  let blocking: string[] = [];
  let item = '';
  let heartbeat: NodeJS.Timeout | null = null;

  const stopHeartbeat = (): void => {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
  };

  const startHeartbeat = (event: Extract<MienguEvent, { type: 'ExecutorInvoked' }>): void => {
    stopHeartbeat();
    const started = Date.now();
    const role = event.data.role ?? event.data.stage;
    heartbeat = setInterval(() => {
      const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
      write(`miengu: [${event.item_id}] still running ${role} with ${event.data.executor_id} (${String(elapsed)}s elapsed)`);
    }, heartbeatMs);
    heartbeat.unref();
  };

  const flush = (): void => {
    if (blocking.length === 0) return;
    const range = blocking.length === 1
      ? blocking[0]
      : `${blocking[0]} ... ${blocking[blocking.length - 1]}`;
    write(
      `miengu: [${item}] ${String(blocking.length)} blocking checkpoint${blocking.length === 1 ? '' : 's'} raised (${range}); run \`miengu report\` for details`,
    );
    blocking = [];
  };

  const report = (event: MienguEvent): void => {
    if (event.type === 'CheckpointRaised' && event.data.blocking) {
      item = event.item_id;
      blocking.push(event.data.checkpoint);
      return;
    }
    if (event.type === 'ExecutorReturned' || event.type === 'RunFinished' || event.type === 'WorkItemParked' || event.type === 'WorkItemFailed') {
      stopHeartbeat();
    }
    flush();
    const line = formatProgressEvent(event);
    if (line !== null) write(`miengu: ${line}`);
    if (event.type === 'ExecutorInvoked') startHeartbeat(event);
  };
  return Object.assign(report, { close: () => { stopHeartbeat(); flush(); } });
}
