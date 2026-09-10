import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { assertNever } from '../../core/events.js';
import type { RunOutcome, Stage } from '../../core/events.js';
import { sha256File } from '../../core/hash.js';
import { itemPaths } from '../../core/log.js';
import { EventLog, listItemIds } from '../../core/log.js';
import { epochSeconds, systemClock } from '../../core/clock.js';
import type { Clock } from '../../core/clock.js';
import { createIdMinter, systemRng } from '../../core/idgen.js';
import type { IdMinter } from '../../core/idgen.js';
import { slugify } from '../../core/ids.js';
import type { AccountId, RunId, WorkItemId } from '../../core/ids.js';
import { LockHeldError, LogCorruptError, StoreError } from '../../errors.js';
import type { Logger } from '../../logging.js';
import { createLogger } from '../../logging.js';
import { loadConfig } from '../../config/load.js';
import type { LoadedConfig } from '../../config/load.js';
import { createSnapshotStore } from '../../core/snapshot.js';
import { PROJECTION_VERSION, WorkItemStateSchema } from '../../state/workitem.js';
import type { WorkItemState } from '../../state/workitem.js';
import { applyEvent } from '../../state/projector.js';
import { stateHash } from '../../state/stateHash.js';
import { buildExecutorRegistry } from '../../executors/registry.js';
import { createWorkspaceProvider } from '../../executors/isolation.js';
import { policyFromConfig } from '../../supervisor/nextStage.js';
import { runItem } from '../../supervisor/loop.js';
import type { RunItemDeps, RunItemResult } from '../../supervisor/loop.js';
import { blockedByAccount, planBacklog } from '../../supervisor/backlog.js';
import type { BacklogBlocker, BacklogCandidate, BacklogEntry } from '../../supervisor/backlog.js';
import { EXIT } from '../exit.js';
import { projectAccelerated } from './replay.js';

const MIENGU_VERSION = '0.1.0';

export interface RunCommandOptions {
  readonly prdFile: string;
  readonly configPath?: string | undefined;
  readonly retainWorkspace?: boolean | undefined;
  readonly noBacklog?: boolean | undefined;
  readonly json?: boolean | undefined;
}

interface BacklogResultRow {
  readonly item: WorkItemId;
  readonly ready: boolean;
  readonly blocker: BacklogBlocker | null;
  readonly outcome: RunOutcome | null;
  readonly stage: Stage | null;
  readonly status: WorkItemState['status'] | null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function mintItemId(storeDir: string, slug: ReturnType<typeof slugify>, ids: IdMinter): Promise<WorkItemId> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = ids.workItemId(slug);
    const paths = itemPaths(storeDir, candidate);
    if (!(await pathExists(paths.itemDir))) {
      return candidate;
    }
  }
  throw new StoreError('failed to mint a unique work item id after 5 attempts', { slug });
}

function exitCodeForOutcome(outcome: RunItemResult['outcome']): number {
  switch (outcome) {
    case 'completed':
      return EXIT.OK;
    case 'parked':
      return EXIT.PARKED;
    case 'failed':
    case 'aborted':
      return EXIT.INTERNAL;
    default:
      return assertNever(outcome);
  }
}

/**
 * Runs one already-logged item (its `WorkItemCreated`/`RunStarted` or
 * `WorkItemResumed` is already appended by the caller) to completion or park: constructs the
 * executor registry, workspace provider and snapshot store, then drives `runItem`. Shared by
 * the new item and every drained backlog item so the two never diverge in behaviour.
 */
async function runOneItem(o: {
  readonly loaded: LoadedConfig;
  readonly itemId: WorkItemId;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly retainWorkspace: boolean;
}): Promise<RunItemResult> {
  const { loaded, itemId, log, clock, ids, logger, signal, retainWorkspace } = o;
  const paths = itemPaths(loaded.storeDir, itemId);

  const promptsDir = join(paths.itemDir, 'prompts');
  const schemasDir = join(paths.itemDir, 'schemas');
  const messagesDir = join(paths.itemDir, 'messages');
  const frozenTestsDir = join(paths.itemDir, 'frozen-tests');
  const oraclesDir = paths.oraclesDir;
  await Promise.all([
    mkdir(promptsDir, { recursive: true }),
    mkdir(schemasDir, { recursive: true }),
    mkdir(messagesDir, { recursive: true }),
    mkdir(frozenTestsDir, { recursive: true }),
    mkdir(oraclesDir, { recursive: true }),
  ]);

  const executors = buildExecutorRegistry({
    config: loaded.config,
    paths: { transcriptsDir: paths.transcriptsDir, messagesDir },
    clock,
    ids,
    logger,
  });
  const workspace = createWorkspaceProvider(loaded.config.target.mode);
  const snapshots = createSnapshotStore<WorkItemState>({
    dir: paths.snapshotsDir,
    itemId,
    projectionVersion: PROJECTION_VERSION,
    hashState: stateHash,
    parseState: (v) => WorkItemStateSchema.parse(v),
    logger,
  });
  const policy = policyFromConfig(loaded.config);

  const deps: RunItemDeps = {
    log,
    snapshots,
    config: loaded.config,
    policy,
    executors,
    workspace,
    targetRepo: loaded.targetRepo,
    workspacesDir: paths.workspacesDir,
    promptsDir,
    schemasDir,
    messagesDir,
    frozenTestsDir,
    oraclesDir,
    clock,
    ids,
    logger,
    signal,
    retainWorkspace,
  };

  let result = await runItem(deps);

  if (signal.aborted) {
    const abortEvent = await log.append({
      type: 'WorkItemParked',
      data: {
        reason: 'operator-abort',
        detail: 'received SIGINT',
        resumable: true,
        account: null,
        resets_at: null,
      },
      actor: { kind: 'human', id: null },
      causationId: log.lastEventId,
    });
    result = { outcome: 'parked', finalState: applyEvent(result.finalState, abortEvent) };
  }

  return result;
}

function sortBacklogEntries(entries: readonly BacklogEntry[]): BacklogEntry[] {
  return entries.slice().sort((a, b) => {
    const aSince = a.parkSince ?? '';
    const bSince = b.parkSince ?? '';
    if (aSince < bSince) return -1;
    if (aSince > bSince) return 1;
    if (a.itemId < b.itemId) return -1;
    if (a.itemId > b.itemId) return 1;
    return 0;
  });
}

/**
 * Binding decisions 13/14/15: scans every item but the new one, derives readiness at scan
 * time (no persisted queue), gates provider quota per account for the whole drain, and never
 * resumes an item with a rejected blocking checkpoint. Each item's log is opened and closed
 * strictly serially — never two logs open at once. The whole invocation shares one `RunId`.
 */
async function drainBacklog(o: {
  readonly loaded: LoadedConfig;
  readonly runId: RunId;
  readonly newItemId: WorkItemId;
  readonly newItemResult: RunItemResult;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly logger: Logger;
  readonly retainWorkspace: boolean;
  readonly signal: AbortSignal;
}): Promise<BacklogResultRow[]> {
  const { loaded, runId, newItemId, newItemResult, clock, ids, logger, retainWorkspace, signal } = o;
  const policy = policyFromConfig(loaded.config);
  const itemIds = await listItemIds(loaded.storeDir);

  const states = new Map<WorkItemId, WorkItemState>();
  const corruptIds: WorkItemId[] = [];
  for (const id of itemIds) {
    if (id === newItemId) {
      continue;
    }
    try {
      const { state } = await projectAccelerated(loaded.storeDir, id);
      states.set(id, state);
    } catch {
      corruptIds.push(id);
    }
  }

  const quotaCleared = (park: WorkItemState['park']): boolean =>
    park === null || park.resetsAt === null || epochSeconds(park.resetsAt) <= epochSeconds(clock.now());

  const blockedAccounts = new Set<AccountId>();
  for (const state of states.values()) {
    if (state.park !== null && state.park.reason === 'provider-quota' && state.park.account !== null) {
      if (!quotaCleared(state.park)) {
        blockedAccounts.add(state.park.account);
      }
    }
  }
  if (
    newItemResult.outcome === 'parked' &&
    newItemResult.finalState.park !== null &&
    newItemResult.finalState.park.reason === 'provider-quota' &&
    newItemResult.finalState.park.account !== null
  ) {
    blockedAccounts.add(newItemResult.finalState.park.account);
  }

  const candidates: BacklogCandidate[] = [];
  for (const [id, state] of states) {
    let openBlocking = 0;
    let rejectedBlocking = 0;
    for (const cp of Object.values(state.checkpoints)) {
      if (!cp.blocking) continue;
      if (cp.status === 'open') openBlocking += 1;
      if (cp.status === 'rejected') rejectedBlocking += 1;
    }
    candidates.push({
      itemId: id,
      status: state.status,
      parkReason: state.park?.reason ?? null,
      parkSince: state.park?.since ?? null,
      resumable: state.park?.resumable ?? false,
      parkAccount: state.park?.account ?? null,
      quotaWindowCleared: quotaCleared(state.park),
      openBlockingCheckpoints: openBlocking,
      rejectedBlockingCheckpoints: rejectedBlocking,
      nextStageAccount: policy.stageAccounts[state.stage],
    });
  }

  const planned = planBacklog(candidates);
  const corruptEntries: BacklogEntry[] = corruptIds.map((id) => ({
    itemId: id,
    ready: false,
    blocker: 'corrupt',
    parkSince: null,
    parkReason: null,
    nextStageAccount: null,
  }));
  const allEntries = sortBacklogEntries([...planned, ...corruptEntries]);

  const rows: BacklogResultRow[] = [];
  for (const entry of allEntries) {
    const state = states.get(entry.itemId) ?? null;

    if (!entry.ready) {
      rows.push({
        item: entry.itemId,
        ready: false,
        blocker: entry.blocker,
        outcome: null,
        stage: state?.stage ?? null,
        status: state?.status ?? null,
      });
      continue;
    }

    if (blockedByAccount(entry, blockedAccounts)) {
      rows.push({
        item: entry.itemId,
        ready: false,
        blocker: 'account-blocked-this-run',
        outcome: null,
        stage: state?.stage ?? null,
        status: state?.status ?? null,
      });
      continue;
    }

    const park = state?.park ?? null;
    const previousReason = park?.reason ?? entry.parkReason;
    if (previousReason === null || previousReason === undefined) {
      // planBacklog only marks `ready` a candidate whose `status === 'parked'` (every other
      // status returns a blocker), so a ready entry always has a park reason. Defensive only.
      rows.push({
        item: entry.itemId,
        ready: false,
        blocker: 'not-parked',
        outcome: null,
        stage: state?.stage ?? null,
        status: state?.status ?? null,
      });
      continue;
    }

    let log: EventLog;
    try {
      ({ log } = await EventLog.open({ storeDir: loaded.storeDir, itemId: entry.itemId, runId, clock, ids, logger }));
    } catch (err) {
      if (err instanceof LockHeldError) {
        rows.push({
          item: entry.itemId,
          ready: false,
          blocker: 'lock-held',
          outcome: null,
          stage: state?.stage ?? null,
          status: state?.status ?? null,
        });
        continue;
      }
      if (err instanceof LogCorruptError || err instanceof StoreError) {
        rows.push({
          item: entry.itemId,
          ready: false,
          blocker: 'corrupt',
          outcome: null,
          stage: state?.stage ?? null,
          status: state?.status ?? null,
        });
        continue;
      }
      throw err;
    }

    try {
      await log.append({
        type: 'RunStarted',
        data: {
          miengu_version: MIENGU_VERSION,
          node_version: process.version,
          config_hash: loaded.configHash,
          config: loaded.config,
        },
        actor: { kind: 'system', id: null },
        causationId: log.lastEventId,
      });
      await log.append({
        type: 'WorkItemResumed',
        data: {
          previous_reason: previousReason,
          detail: `resumed by miengu run: park cleared (${previousReason})`,
          account: park?.account ?? null,
        },
        actor: { kind: 'supervisor', id: null },
        causationId: log.lastEventId,
      });

      const result = await runOneItem({
        loaded,
        itemId: entry.itemId,
        log,
        clock,
        ids,
        logger,
        signal,
        retainWorkspace,
      });

      const eventsAppendedBeforeFinish = log.lastSeq;
      await log.append({
        type: 'RunFinished',
        data: { outcome: result.outcome, events_appended: eventsAppendedBeforeFinish },
        actor: { kind: 'system', id: null },
        causationId: log.lastEventId,
      });

      if (
        result.outcome === 'parked' &&
        result.finalState.park !== null &&
        result.finalState.park.reason === 'provider-quota' &&
        result.finalState.park.account !== null
      ) {
        blockedAccounts.add(result.finalState.park.account);
      }

      rows.push({
        item: entry.itemId,
        ready: true,
        blocker: null,
        outcome: result.outcome,
        stage: result.finalState.stage,
        status: result.finalState.status,
      });
    } finally {
      await log.close();
    }
  }

  return rows;
}

/**
 * Mints a work item and runs it, via `runItem`, to completion or park. Constructs the
 * executor registry (eagerly, per role) after `RunStarted` and before `runItem` — a
 * `ConfigError` from a misconfigured sandbox therefore propagates before any `StageEntered`
 * is ever appended. Then, unless `--no-backlog`, drains every resumable parked item whose
 * park condition has cleared (binding decision 13); the new item's log is closed strictly
 * before the drain starts, so at most one log is ever open at once. Returns the **new
 * item's** exit code — a backlog item's outcome never changes it (§10).
 */
export async function runCommand(options: RunCommandOptions): Promise<number> {
  const loaded = await loadConfig(options.configPath);

  const prdPath = resolve(options.prdFile);
  const [sha256, fileStat] = await Promise.all([sha256File(prdPath), stat(prdPath)]);
  const title = basename(prdPath, extname(prdPath));
  const slug = slugify(title);

  const clock = systemClock;
  const ids = createIdMinter(systemRng);
  const logger = createLogger({ level: loaded.config.log.level });

  const itemId = await mintItemId(loaded.storeDir, slug, ids);
  const runId = ids.runId();

  const { log } = await EventLog.create({
    storeDir: loaded.storeDir,
    itemId,
    runId,
    clock,
    ids,
    logger,
  });

  const abortController = new AbortController();
  const onSigint = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', onSigint);

  let result: RunItemResult;
  try {
    await log.append({
      type: 'WorkItemCreated',
      data: {
        title,
        slug,
        source: { kind: 'prd-file', path: prdPath, sha256, bytes: fileStat.size },
        config_hash: loaded.configHash,
      },
      actor: { kind: 'human', id: null },
      causationId: null,
    });
    await log.append({
      type: 'RunStarted',
      data: {
        miengu_version: MIENGU_VERSION,
        node_version: process.version,
        config_hash: loaded.configHash,
        config: loaded.config,
      },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });

    result = await runOneItem({
      loaded,
      itemId,
      log,
      clock,
      ids,
      logger,
      signal: abortController.signal,
      retainWorkspace: options.retainWorkspace ?? false,
    });

    const eventsAppendedBeforeFinish = log.lastSeq;
    await log.append({
      type: 'RunFinished',
      data: { outcome: result.outcome, events_appended: eventsAppendedBeforeFinish },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
  } finally {
    await log.close();
  }

  let backlog: BacklogResultRow[] = [];
  if (options.noBacklog !== true) {
    backlog = await drainBacklog({
      loaded,
      runId,
      newItemId: itemId,
      newItemResult: result,
      clock,
      ids,
      logger,
      retainWorkspace: options.retainWorkspace ?? false,
      signal: abortController.signal,
    });
  }
  process.removeListener('SIGINT', onSigint);

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        item: itemId,
        outcome: result.outcome,
        stage: result.finalState.stage,
        status: result.finalState.status,
        backlog: backlog.map((row) => ({
          item: row.item,
          ready: row.ready,
          blocker: row.blocker,
          outcome: row.outcome,
          stage: row.stage,
          status: row.status,
        })),
      })}\n`,
    );
  } else {
    process.stdout.write(
      `item      ${itemId}\noutcome   ${result.outcome}\nstage     ${result.finalState.stage}\nstatus    ${result.finalState.status}\n`,
    );
    if (backlog.length > 0) {
      const lines = backlog.map((row) => {
        const readyOrBlocker = row.ready ? 'ready' : (row.blocker ?? 'blocked');
        const outcome = row.outcome ?? '-';
        const stage = row.stage ?? '-';
        const status = row.status ?? '-';
        return `${row.item}  ${readyOrBlocker}  ${outcome}  ${stage}  ${status}`;
      });
      process.stdout.write(`backlog\n${lines.join('\n')}\n`);
    }
  }

  return exitCodeForOutcome(result.outcome);
}
