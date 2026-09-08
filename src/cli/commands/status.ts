import { loadConfig } from '../../config/load.js';
import { listItemIds } from '../../core/log.js';
import type { AccountId, WorkItemId } from '../../core/ids.js';
import { EXIT } from '../exit.js';
import { projectAccelerated } from './replay.js';

export interface StatusCommandOptions {
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

interface StatusPark {
  readonly reason: string;
  readonly detail: string;
  readonly account: AccountId | null;
  readonly resetsAt: string | null;
}

interface StatusRow {
  readonly itemId: WorkItemId;
  readonly corrupt: boolean;
  readonly error: string | null;
  readonly stage: string | null;
  readonly status: string | null;
  readonly attemptsOnStage: number | null;
  readonly currentTaskId: string | null;
  readonly activeCauseId: string | null;
  readonly activeCauseLevel: string | null;
  readonly causalAttempts: Record<string, number> | null;
  readonly park: StatusPark | null;
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
      currentTaskId: state.tasks?.currentTaskId ?? null,
      activeCauseId: state.activeCauseId,
      activeCauseLevel: state.activeCauseId === null ? null : (state.causes[state.activeCauseId]?.level ?? null),
      causalAttempts: state.activeCauseId === null ? null : (state.causes[state.activeCauseId]?.attempts ?? null),
      park:
        state.park === null
          ? null
          : {
              reason: state.park.reason,
              detail: state.park.detail,
              account: state.park.account,
              resetsAt: state.park.resetsAt,
            },
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
      currentTaskId: null,
      activeCauseId: null,
      activeCauseLevel: null,
      causalAttempts: null,
      park: null,
      updatedAt: null,
    };
  }
}

/** §17.2: a quota park names the account, e.g. "waiting on claude-personal window", instead
 *  of a bare reason. Every other park reason renders as in Phase 1. */
function renderPark(park: StatusPark | null): string {
  if (park === null) {
    return '';
  }
  if (park.reason === 'provider-quota' && park.account !== null) {
    const resets = park.resetsAt !== null ? ` (resets ${park.resetsAt})` : '';
    return `waiting on ${park.account} window${resets}`;
  }
  return park.reason;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderCausalAttempts(attempts: Record<string, number> | null): string {
  return attempts === null ? '' : Object.entries(attempts).map(([bucket, count]) => `${bucket}=${String(count)}`).join(',');
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

  const header = `${pad('ITEM', 24)}${pad('STAGE', 16)}${pad('STATUS', 12)}${pad('ATTEMPTS', 10)}${pad('TASK', 18)}${pad('CAUSE', 18)}${pad('CAUSE ATTEMPTS', 64)}${pad('PARK', 20)}UPDATED`;
  const lines = [header];
  for (const row of rows) {
    if (row.corrupt) {
      lines.push(`${pad(row.itemId, 24)}${pad('CORRUPT', 16)}${row.error ?? ''}`);
      continue;
    }
    lines.push(
      `${pad(row.itemId, 24)}${pad(row.stage ?? '', 16)}${pad(row.status ?? '', 12)}${pad(String(row.attemptsOnStage ?? ''), 10)}${pad(row.currentTaskId ?? '', 18)}${pad(row.activeCauseId === null ? '' : `${row.activeCauseId}:${row.activeCauseLevel ?? ''}`, 18)}${pad(renderCausalAttempts(row.causalAttempts), 64)}${pad(renderPark(row.park), 20)}${row.updatedAt ?? ''}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  return anyCorrupt ? EXIT.STORE : EXIT.OK;
}
