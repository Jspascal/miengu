import { loadConfig } from '../../config/load.js';
import { itemPaths, listItemIds } from '../../core/log.js';
import type { AccountId, WorkItemId } from '../../core/ids.js';
import { epochSeconds, systemClock } from '../../core/clock.js';
import { policyFromConfig } from '../../supervisor/nextStage.js';
import { gatePolicyAt } from '../../supervisor/checkpointPolicy.js';
import { planBacklog } from '../../supervisor/backlog.js';
import type { BacklogCandidate, BacklogEntry } from '../../supervisor/backlog.js';
import type { WorkItemState } from '../../state/workitem.js';
import { EXIT } from '../exit.js';
import { projectAccelerated, readEventsReadOnly } from './replay.js';

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

interface StatusBacklog {
  readonly ready: boolean;
  readonly blocker: string | null;
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
  readonly resumable: boolean | null;
  readonly openBlockingCheckpoints: number | null;
  readonly blastRadiusDeclared: boolean | null;
  readonly backlog: StatusBacklog | null;
  readonly updatedAt: string | null;
}

function countOpenBlocking(state: WorkItemState): number {
  let count = 0;
  for (const cp of Object.values(state.checkpoints)) {
    if (cp.blocking && cp.status === 'open') {
      count += 1;
    }
  }
  return count;
}

function countRejectedBlocking(state: WorkItemState): number {
  let count = 0;
  for (const cp of Object.values(state.checkpoints)) {
    if (cp.blocking && cp.status === 'rejected') {
      count += 1;
    }
  }
  return count;
}

/**
 * Enumerates `.miengu/items/*` and, for each, opens read-only (no lock): `latestValid` + tail
 * events. One corrupt item is reported as `CORRUPT` with its error and does not fail the whole
 * command; the command exits `EXIT.STORE` (4) at the end if any item was corrupt.
 *
 * `backlog` is derived through the same `planBacklog` the `run` drain uses (one clearance
 * rule, one implementation): every non-corrupt item's `BacklogCandidate` is built here and
 * classified in a single batched call, exactly as `run.ts`'s drain does before it runs.
 */
export async function statusCommand(options: StatusCommandOptions): Promise<number> {
  const loaded = await loadConfig(options.configPath);
  const itemIds = await listItemIds(loaded.storeDir);
  const policy = policyFromConfig(loaded.config);
  const clock = systemClock;

  const states = new Map<WorkItemId, { readonly state: WorkItemState; readonly blastRadiusDeclared: boolean }>();
  const corrupt = new Map<WorkItemId, string>();

  for (const itemId of itemIds) {
    try {
      const { state } = await projectAccelerated(loaded.storeDir, itemId);
      const events = await readEventsReadOnly(itemPaths(loaded.storeDir, itemId).eventsFile, itemId);
      const blastRadius = gatePolicyAt(events, state.seq).blastRadius;
      const blastRadiusDeclared =
        blastRadius.migrationOrSchemaPaths.length > 0 ||
        blastRadius.sensitivePaths.length > 0 ||
        blastRadius.externalContractPaths.length > 0 ||
        blastRadius.protectedPaths.length > 0 ||
        blastRadius.dependencyManifestPaths.length > 0;
      states.set(itemId, { state, blastRadiusDeclared });
    } catch (err) {
      corrupt.set(itemId, err instanceof Error ? err.message : String(err));
    }
  }

  const candidates: BacklogCandidate[] = [];
  for (const [itemId, { state }] of states) {
    candidates.push({
      itemId,
      status: state.status,
      parkReason: state.park?.reason ?? null,
      parkSince: state.park?.since ?? null,
      resumable: state.park?.resumable ?? false,
      parkAccount: state.park?.account ?? null,
      quotaWindowCleared:
        state.park === null || state.park.resetsAt === null
          ? true
          : epochSeconds(state.park.resetsAt) <= epochSeconds(clock.now()),
      openBlockingCheckpoints: countOpenBlocking(state),
      rejectedBlockingCheckpoints: countRejectedBlocking(state),
      nextStageAccount: policy.stageAccounts[state.stage],
    });
  }
  const entryByItem = new Map<WorkItemId, BacklogEntry>(planBacklog(candidates).map((e) => [e.itemId, e]));

  const rows: StatusRow[] = [];
  for (const itemId of itemIds) {
    const projected = states.get(itemId);
    if (projected === undefined) {
      rows.push({
        itemId,
        corrupt: true,
        error: corrupt.get(itemId) ?? '',
        stage: null,
        status: null,
        attemptsOnStage: null,
        currentTaskId: null,
        activeCauseId: null,
        activeCauseLevel: null,
        causalAttempts: null,
        park: null,
        resumable: null,
        openBlockingCheckpoints: null,
        blastRadiusDeclared: null,
        backlog: null,
        updatedAt: null,
      });
      continue;
    }
    const { state, blastRadiusDeclared } = projected;
    const entry = entryByItem.get(itemId) ?? null;
    rows.push({
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
      resumable: state.park?.resumable ?? null,
      openBlockingCheckpoints: countOpenBlocking(state),
      blastRadiusDeclared,
      backlog: entry === null ? null : { ready: entry.ready, blocker: entry.blocker },
      updatedAt: state.updatedAt,
    });
  }

  const anyCorrupt = rows.some((row) => row.corrupt);

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return anyCorrupt ? EXIT.STORE : EXIT.OK;
  }

  const header = `${pad('ITEM', 24)}${pad('STAGE', 16)}${pad('STATUS', 12)}${pad('ATTEMPTS', 10)}${pad('TASK', 18)}${pad('CAUSE', 18)}${pad('CAUSE ATTEMPTS', 64)}${pad('PARK', 20)}${pad('BACKLOG', 24)}UPDATED`;
  const lines = [header];
  for (const row of rows) {
    if (row.corrupt) {
      lines.push(`${pad(row.itemId, 24)}${pad('CORRUPT', 16)}${row.error ?? ''}`);
      continue;
    }
    lines.push(
      `${pad(row.itemId, 24)}${pad(row.stage ?? '', 16)}${pad(row.status ?? '', 12)}${pad(String(row.attemptsOnStage ?? ''), 10)}${pad(row.currentTaskId ?? '', 18)}${pad(row.activeCauseId === null ? '' : `${row.activeCauseId}:${row.activeCauseLevel ?? ''}`, 18)}${pad(renderCausalAttempts(row.causalAttempts), 64)}${pad(renderPark(row.park), 20)}${pad(renderBacklog(row.backlog), 24)}${row.updatedAt ?? ''}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);

  return anyCorrupt ? EXIT.STORE : EXIT.OK;
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

function renderBacklog(backlog: StatusBacklog | null): string {
  if (backlog === null) {
    return '';
  }
  return backlog.ready ? 'ready' : (backlog.blocker ?? '');
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderCausalAttempts(attempts: Record<string, number> | null): string {
  return attempts === null ? '' : Object.entries(attempts).map(([bucket, count]) => `${bucket}=${String(count)}`).join(',');
}
