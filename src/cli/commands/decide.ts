import { loadConfig } from '../../config/load.js';
import { EventLog, listItemIds } from '../../core/log.js';
import { systemClock } from '../../core/clock.js';
import { createIdMinter, systemRng } from '../../core/idgen.js';
import { CheckpointIdSchema, WorkItemIdSchema } from '../../core/ids.js';
import type { CheckpointId, WorkItemId } from '../../core/ids.js';
import { StoreError } from '../../errors.js';
import { createLogger } from '../../logging.js';
import type { MienguEvent } from '../../core/events.js';
import { project } from '../../state/projector.js';
import { EXIT } from '../exit.js';
import { projectAccelerated } from './replay.js';

export interface DecideCommandOptions {
  readonly checkpoint: string;
  readonly decision: string;
  readonly reason?: string | undefined;
  readonly item?: string | undefined;
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

const DECISION_WORDS = new Set(['accept', 'reject']);

function findLatestEvent(
  events: readonly MienguEvent[],
  predicate: (e: MienguEvent) => boolean,
): MienguEvent | null {
  let found: MienguEvent | null = null;
  for (const event of events) {
    if (predicate(event)) {
      found = event;
    }
  }
  return found;
}

/**
 * Implements binding decision 16: appends and nothing else. It never resumes an item, never
 * runs a stage, never writes a snapshot, never renders a wiki. It takes the owning item's
 * write lock, appends one `CheckpointDecided{by:'human'}`, and releases in a `finally`. It
 * refuses an unknown, already-decided or auto-approved checkpoint without appending, and a
 * malformed checkpoint id or decision word before any store read.
 */
export async function decideCommand(options: DecideCommandOptions): Promise<number> {
  const checkpointParsed = CheckpointIdSchema.safeParse(options.checkpoint);
  if (!checkpointParsed.success) {
    process.stderr.write(`miengu decide: invalid checkpoint id "${options.checkpoint}"\n`);
    return EXIT.USAGE;
  }
  const checkpoint: CheckpointId = checkpointParsed.data;

  if (!DECISION_WORDS.has(options.decision)) {
    process.stderr.write(
      `miengu decide: invalid decision "${options.decision}": expected "accept" or "reject"\n`,
    );
    return EXIT.USAGE;
  }
  const decision = options.decision as 'accept' | 'reject';

  let requestedItem: WorkItemId | undefined;
  if (options.item !== undefined) {
    const itemParsed = WorkItemIdSchema.safeParse(options.item);
    if (!itemParsed.success) {
      process.stderr.write(`miengu decide: invalid --item "${options.item}"\n`);
      return EXIT.USAGE;
    }
    requestedItem = itemParsed.data;
  }

  const loaded = await loadConfig(options.configPath);
  const itemIds = await listItemIds(loaded.storeDir);

  const owningItems: WorkItemId[] = [];
  for (const itemId of itemIds) {
    if (requestedItem !== undefined && itemId !== requestedItem) {
      continue;
    }
    let projection;
    try {
      projection = await projectAccelerated(loaded.storeDir, itemId);
    } catch {
      // A corrupt item cannot own this checkpoint any more usefully than an unknown one;
      // it is simply skipped, matching `status`'s per-item isolation.
      continue;
    }
    if (projection.state.checkpoints[checkpoint] !== undefined) {
      owningItems.push(itemId);
    }
  }

  if (owningItems.length === 0) {
    throw new StoreError(`unknown checkpoint: ${checkpoint}`, { checkpoint });
  }
  if (owningItems.length > 1) {
    process.stderr.write(
      `miengu decide: checkpoint "${checkpoint}" is ambiguous across items: ${owningItems.join(', ')} — pass --item to disambiguate\n`,
    );
    return EXIT.USAGE;
  }
  const itemId = owningItems[0];
  if (itemId === undefined) {
    throw new StoreError(`unknown checkpoint: ${checkpoint}`, { checkpoint });
  }

  const clock = systemClock;
  const ids = createIdMinter(systemRng);
  const logger = createLogger({ level: loaded.config.log.level });
  const runId = ids.runId();

  const { log } = await EventLog.open({
    storeDir: loaded.storeDir,
    itemId,
    runId,
    clock,
    ids,
    logger,
  });

  try {
    const events = await log.readAll();
    const record = project(events).checkpoints[checkpoint];
    if (record === undefined) {
      throw new StoreError(`unknown checkpoint: ${checkpoint}`, { checkpoint, itemId });
    }

    if (record.status === 'auto-approved') {
      const autoApprovedEvent = findLatestEvent(
        events,
        (e) => e.type === 'AutoApproved' && e.data.checkpoint === checkpoint,
      );
      process.stderr.write(
        `miengu decide: checkpoint "${checkpoint}" was already auto-approved (${autoApprovedEvent?.event_id ?? 'unknown event'}); a later decision cannot un-happen it\n`,
      );
      return EXIT.USAGE;
    }
    if (record.status !== 'open') {
      const decidedEvent = findLatestEvent(
        events,
        (e) => e.type === 'CheckpointDecided' && e.data.checkpoint === checkpoint,
      );
      const decidedData = decidedEvent !== null && decidedEvent.type === 'CheckpointDecided' ? decidedEvent.data : null;
      process.stderr.write(
        `miengu decide: checkpoint "${checkpoint}" was already decided (${decidedData?.decision ?? record.status} by ${decidedEvent?.actor.kind ?? 'unknown'} at ${decidedEvent?.ts ?? 'unknown'})\n`,
      );
      return EXIT.USAGE;
    }

    const reason = options.reason ?? null;
    const appended = await log.append({
      type: 'CheckpointDecided',
      data: { checkpoint, decision, by: 'human', reason },
      actor: { kind: 'human', id: null },
      causationId: log.lastEventId,
    });

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          item: itemId,
          checkpoint,
          decision,
          by: 'human',
          reason,
          seq: appended.seq,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `checkpoint ${checkpoint}\nitem       ${itemId}\ndecision   ${decision}\nby         human\nreason     ${reason ?? ''}\nseq        ${String(appended.seq)}\n`,
      );
    }

    return EXIT.OK;
  } finally {
    await log.close();
  }
}
