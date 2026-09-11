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
      return event.data.blocking
        ? `${prefix} waiting for decision ${event.data.checkpoint}: ${compact(event.data.summary)}`
        : null;
    case 'BudgetExhausted':
      return `${prefix} ! budget exhausted (${event.data.limit_kind}): ${compact(event.data.detail)}`;
    case 'FailureAttempted':
      return `${prefix} retrying ${event.data.handler_stage} (${String(event.data.attempt)}/${String(event.data.limit)})`;
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

export function writeProgressEvent(event: MienguEvent): void {
  const line = formatProgressEvent(event);
  if (line !== null) {
    process.stderr.write(`miengu: ${line}\n`);
  }
}
