import { loadConfig } from '../../config/load.js';
import { listItemIds } from '../../core/log.js';
import type { WorkItemId } from '../../core/ids.js';
import { EXIT } from '../exit.js';
import { projectAccelerated } from './replay.js';

export interface StatusCommandOptions {
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

interface StatusRow {
  readonly itemId: WorkItemId;
  readonly corrupt: boolean;
  readonly error: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  readonly attemptsOnStage: number | null;
  readonly parkReason: string | null;
  readonly updatedAt: string | null;
}

async function buildRow(storeDir: string, itemId: WorkItemId): Promise<StatusRow> {
  try {
    const { state } = await projectAccelerated(storeDir, itemId);
    return {
      itemId,
      corrupt: false,
      error: null,
      stage: state.stage,
      status: state.status,
      attemptsOnStage: state.attempts[state.stage],
      parkReason: state.park?.reason ?? null,
      updatedAt: state.updatedAt,
    };
  } catch (err) {
    return {
      itemId,
      corrupt: true,
      error: err instanceof Error ? err.message : String(err),
      stage: null,
      status: null,
      attemptsOnStage: null,
      parkReason: null,
      updatedAt: null,
    };
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Enumerates `.miengu/items/*` and, for each, opens read-only (no lock): `latestValid` + tail
 * events. One corrupt item is reported as `CORRUPT` with its error and does not fail the whole
 * command; the command exits `EXIT.STORE` (4) at the end if any item was corrupt.
 */
export async function statusCommand(options: StatusCommandOptions): Promise<number> {
  const loaded = await loadConfig(options.configPath);
  const itemIds = await listItemIds(loaded.storeDir);

  const rows: StatusRow[] = [];
  for (const itemId of itemIds) {
    rows.push(await buildRow(loaded.storeDir, itemId));
  }

  const anyCorrupt = rows.some((row) => row.corrupt);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return anyCorrupt ? EXIT.STORE : EXIT.OK;
  }

  const header = `${pad('ITEM', 24)}${pad('STAGE', 16)}${pad('STATUS', 12)}${pad('ATTEMPTS', 10)}${pad('PARK', 20)}UPDATED`;
  const lines = [header];
  for (const row of rows) {
    if (row.corrupt) {
      lines.push(`${pad(row.itemId, 24)}${pad('CORRUPT', 16)}${row.error ?? ''}`);
      continue;
    }
    lines.push(
      `${pad(row.itemId, 24)}${pad(row.stage ?? '', 16)}${pad(row.status ?? '', 12)}${pad(String(row.attemptsOnStage ?? ''), 10)}${pad(row.parkReason ?? '', 20)}${row.updatedAt ?? ''}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  return anyCorrupt ? EXIT.STORE : EXIT.OK;
}
