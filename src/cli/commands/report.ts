import { loadConfig } from '../../config/load.js';
import { stat } from 'node:fs/promises';
import { IsoTimestampSchema } from '../../core/clock.js';
import type { IsoTimestamp } from '../../core/clock.js';
import { itemPaths, listItemIds } from '../../core/log.js';
import type { WorkItemId } from '../../core/ids.js';
import { buildBatchReport, renderBatchReport } from '../../report/batch.js';
import type { BatchReportItemInput } from '../../report/batch.js';
import { EXIT } from '../exit.js';
import { readEventsReadOnly } from './replay.js';

async function attachmentAvailability(items: readonly BatchReportItemInput[]): Promise<ReadonlyMap<import('../../core/ids.js').EventId, boolean>> {
  const availability = new Map<import('../../core/ids.js').EventId, boolean>();
  for (const item of items) {
    for (const event of item.events) {
      const ref = event.type === 'BrownfieldEvidenceRecorded' || event.type === 'BrownfieldPredicateEvaluated'
        ? event.data.evidence
        : null;
      if (ref === null) continue;
      try {
        const info = await stat(ref.path);
        availability.set(event.event_id, info.isFile() && info.size === ref.bytes);
      } catch {
        availability.set(event.event_id, false);
      }
    }
  }
  return availability;
}

export interface ReportCommandOptions {
  readonly since?: string | undefined;
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

const RE_BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** §7: a full ISO-8601 timestamp, or a bare `YYYY-MM-DD` widened to `T00:00:00.000Z`. Returns
 *  `null` for neither form; the caller turns that into `EXIT.USAGE` (2) with no output written
 *  (decision 21/§6). */
function parseSince(value: string): IsoTimestamp | null {
  const direct = IsoTimestampSchema.safeParse(value);
  if (direct.success) {
    return direct.data;
  }
  if (RE_BARE_DATE.test(value)) {
    const widened = IsoTimestampSchema.safeParse(`${value}T00:00:00.000Z`);
    if (widened.success) {
      return widened.data;
    }
  }
  return null;
}

/**
 * `loadConfig` -> `listItemIds` -> per-item read-only event load -> `buildBatchReport`. Reads
 * `locale`, never `wiki.language` (decision 17). A corrupt item is isolated and reported;
 * other items still contribute (§6). A blocked checkpoint never changes the exit code
 * (decision 21). Never acquires the write lock, mutates state, or resolves a checkpoint.
 */
export async function reportCommand(options: ReportCommandOptions): Promise<number> {
  let since: IsoTimestamp | null = null;
  if (options.since !== undefined) {
    since = parseSince(options.since);
    if (since === null) {
      process.stderr.write(
        `miengu report: invalid --since value "${options.since}": expected an ISO-8601 timestamp (e.g. 2024-01-01T00:00:00.000Z) or a bare YYYY-MM-DD date\n`,
      );
      return EXIT.USAGE;
    }
  }

  const loaded = await loadConfig(options.configPath);
  const itemIds = await listItemIds(loaded.storeDir);

  const items: BatchReportItemInput[] = [];
  const corrupt: { readonly itemId: WorkItemId; readonly error: string }[] = [];

  for (const itemId of itemIds) {
    try {
      const paths = itemPaths(loaded.storeDir, itemId);
      const events = await readEventsReadOnly(paths.eventsFile, itemId);
      items.push({ itemId, events });
    } catch (err) {
      corrupt.push({ itemId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const report = buildBatchReport({
    locale: loaded.config.locale,
    since,
    items,
    corrupt,
    attachmentAvailability: await attachmentAvailability(items),
  });

  const anyCorrupt = corrupt.length > 0;

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return anyCorrupt ? EXIT.STORE : EXIT.OK;
  }

  process.stdout.write(`${renderBatchReport(report, loaded.config.locale)}\n`);
  return anyCorrupt ? EXIT.STORE : EXIT.OK;
}
