import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { assertNever } from '../../core/events.js';
import type { MienguEvent, RunOutcome, Stage } from '../../core/events.js';
import { sha256File, sha256Hex } from '../../core/hash.js';
import { EventLog, itemPaths, listItemIds, validateFullLog } from '../../core/log.js';
import { collectSkeleton } from '../../brownfield/skeleton.js';
import { collectGit } from '../../brownfield/git.js';
import { collectTests } from '../../brownfield/tests.js';
import { evaluatePredicate } from '../../brownfield/falsification.js';
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
import { applyEvent, project } from '../../state/projector.js';
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
import { createRunDisplay } from '../display.js';
import type { RunDisplay } from '../display.js';
import { assertExecutorCommandsAvailable } from '../../executors/processConfig.js';
import { pendingQuestions, recordHumanResponse } from '../questions.js';

const MIENGU_VERSION = '0.2.0';

export interface RunCommandOptions {
  readonly prdFile: string;
  readonly configPath?: string | undefined;
  readonly retainWorkspace?: boolean | undefined;
  readonly noBacklog?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly tui?: boolean | undefined;
  readonly newItem?: boolean | undefined;
  readonly resumeItem?: WorkItemId | undefined;
}

export async function resumeCommand(options: Omit<RunCommandOptions, 'prdFile' | 'newItem'> & { resumeItem: WorkItemId }): Promise<number> {
  return runCommand({ ...options, prdFile: '' });
}

async function resumeReady(log: EventLog, clock: Clock): Promise<boolean> {
  const state = project(await log.readAll());
  if (state.status !== 'parked') return false;
  const checkpoints = Object.values(state.checkpoints);
  const entry = planBacklog([{
    itemId: state.itemId, status: state.status, parkReason: state.park?.reason ?? null,
    parkSince: state.park?.since ?? null, resumable: state.park?.resumable ?? false,
    parkAccount: state.park?.account ?? null, nextStageAccount: null,
    quotaWindowCleared: state.park?.resetsAt == null || epochSeconds(state.park.resetsAt) <= epochSeconds(clock.now()),
    openBlockingCheckpoints: checkpoints.filter((c) => c.blocking && c.status === 'open').length,
    rejectedBlockingCheckpoints: checkpoints.filter((c) => c.blocking && c.status === 'rejected').length,
  }])[0];
  if (!entry?.ready || !state.park) return false;
  await log.append({ type: 'WorkItemResumed', data: { previous_reason: state.park.reason, detail: 'Resuming this work item after its blocker cleared', account: state.park.account }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
  return true;
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
  readonly display: RunDisplay;
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
  const brownfieldDir = paths.brownfieldDir;
  await Promise.all([
    mkdir(promptsDir, { recursive: true }),
    mkdir(schemasDir, { recursive: true }),
    mkdir(messagesDir, { recursive: true }),
    mkdir(frozenTestsDir, { recursive: true }),
    mkdir(oraclesDir, { recursive: true }),
    mkdir(brownfieldDir, { recursive: true }),
  ]);

  const executors = buildExecutorRegistry({
    onOutput: o.display.onOutput,
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
    ...(o.display.interactive ? { reviewHuman: async (events: readonly MienguEvent[]): Promise<boolean> => {
      const questions = pendingQuestions(events);
      if (questions.length === 0) return resumeReady(log, clock);
      const response = await o.display.requestAnswer(questions, signal);
      if (response === null) return false;
      try {
        await recordHumanResponse(log, response);
        await resumeReady(log, clock);
      } catch (error) {
        o.display.onOutput({ executor: 'miengu', kind: 'error', text: error instanceof Error ? error.message : String(error) });
      }
      return true;
    } } : {}),
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
    brownfield: {
      storeDir: loaded.storeDir,
      evidenceDir: brownfieldDir,
      targetRepoSha256: sha256Hex(loaded.targetRepo),
      collectorVersion: 1,
      collector: { collectSkeleton, collectGit, collectTests },
      predicateRunner: { evaluate: evaluatePredicate },
      readStore: async () => {
        const items = [] as { itemId: WorkItemId; events: readonly MienguEvent[] }[];
        const corrupt = [] as { itemId: WorkItemId; error: string }[];
        for (const siblingId of await listItemIds(loaded.storeDir)) {
          let raw: string;
          try {
            raw = await readFile(itemPaths(loaded.storeDir, siblingId).eventsFile, 'utf8');
          } catch (error) {
            corrupt.push({ itemId: siblingId, error: error instanceof Error ? error.message : String(error) });
            continue;
          }
          const validation = validateFullLog(raw, siblingId);
          if (!validation.ok) {
            corrupt.push({ itemId: siblingId, error: validation.reason });
            continue;
          }
          if (validation.events.length === 0) {
            // A valid empty log (created but never given its WorkItemCreated, or whose only
            // line is a never-durable torn tail) cannot be projected by deriveStoreClaimSets.
            // Classify it as unusable alongside genuinely corrupt siblings.
            corrupt.push({ itemId: siblingId, error: 'empty log: no durable events' });
            continue;
          }
          items.push({ itemId: siblingId, events: validation.events });
        }
        return { items, corrupt };
      },
    },
  };

  await resumeReady(log, clock);
  let result = await runItem(deps);

  if (signal.aborted) {
    const abortEvent = await log.append({
      type: 'WorkItemParked',
      data: {
        reason: 'operator-abort',
        detail: 'received operator stop signal (SIGINT or SIGTERM)',
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
  readonly display: RunDisplay;
  readonly loaded: LoadedConfig;
  readonly runId: RunId;
  readonly newItemId: WorkItemId;
  readonly newItemResult: RunItemResult;
  readonly clock: Clock;
  readonly ids: IdMinter;
  readonly logger: Logger;
  readonly retainWorkspace: boolean;
  readonly signal: AbortSignal;
  readonly showProgress: boolean;
}): Promise<BacklogResultRow[]> {
  const { loaded, runId, newItemId, newItemResult, clock, ids, logger, retainWorkspace, signal, showProgress } = o;
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
    if (signal.aborted) break;
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
      ({ log } = await EventLog.open({
        storeDir: loaded.storeDir,
        itemId: entry.itemId,
        runId,
        clock,
        ids,
        logger,
        onAppend: o.display.onEvent,
      }));
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
      if (showProgress) {
        o.display.onOutput({ executor: 'backlog', kind: 'activity', text: `resuming ${entry.itemId} after ${previousReason}` });
      }
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
        display: o.display,
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
    } catch (error) {
      await log.append({
        type: 'WorkItemFailed',
        data: { reason: 'internal-error', detail: error instanceof Error ? error.message : String(error) },
        actor: { kind: 'system', id: null },
        causationId: log.lastEventId,
      });
      await log.append({
        type: 'RunFinished',
        data: { outcome: 'failed', events_appended: log.lastSeq },
        actor: { kind: 'system', id: null },
        causationId: log.lastEventId,
      });
      throw error;
    } finally {
      await log.close();
    }
  }

  return rows;
}

/**
 * Resumes a matching unfinished item (or explicitly creates one) and runs it to completion
 * or park. Constructs the
 * executor registry (eagerly, per role) after `RunStarted` and before `runItem` — a
 * `ConfigError` from a misconfigured sandbox therefore propagates before any `StageEntered`
 * is ever appended. With `--backlog`, drains every resumable parked item whose
 * park condition has cleared; the selected item's log is closed strictly
 * before the drain starts, so at most one log is ever open at once. Returns the **selected
 * item's** exit code — a backlog item's outcome never changes it (§10).
 */
export async function runCommand(options: RunCommandOptions): Promise<number> {
  const display = createRunDisplay(options.tui !== false && process.stderr.isTTY === true && process.env['TERM'] !== 'dumb', options.json === true);
  try {
    return await runCommandWithDisplay(options, display);
  } finally {
    display.close();
  }
}

async function runCommandWithDisplay(options: RunCommandOptions, display: RunDisplay): Promise<number> {
  const loaded = await loadConfig(options.configPath);
  await assertExecutorCommandsAvailable(loaded);

  let existing: WorkItemState | null = options.resumeItem ? (await projectAccelerated(loaded.storeDir, options.resumeItem)).state : null;
  const prdPath = existing?.source.path ?? resolve(options.prdFile);
  const [sha256, fileStat] = await Promise.all([sha256File(prdPath), stat(prdPath)]);
  if (!existing && options.newItem !== true) {
    const candidates: WorkItemState[] = [];
    for (const id of await listItemIds(loaded.storeDir)) {
      try {
        const { state } = await projectAccelerated(loaded.storeDir, id);
        if (resolve(state.source.path) === prdPath && state.status !== 'completed') candidates.push(state);
      } catch { /* unrelated corrupt items do not hide the selected request */ }
    }
    candidates.sort((a, b) => b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : a.itemId < b.itemId ? -1 : 1);
    existing = candidates[0] ?? null;
  }
  if (existing && existing.source.sha256 !== sha256) throw new StoreError('The PRD changed since this item was created. Use run --new to start a separate item.');
  if (existing?.status === 'failed') throw new StoreError(`Item ${existing.itemId} failed. Inspect its report, or use run --new for an explicit new attempt.`);
  if (existing?.status === 'completed') throw new StoreError(`Item ${existing.itemId} is already completed.`);
  const title = basename(prdPath, extname(prdPath));
  const slug = slugify(title);

  const clock = systemClock;
  const ids = createIdMinter(systemRng);
  const logger = createLogger({ level: loaded.config.log.level });

  const itemId = existing?.itemId ?? await mintItemId(loaded.storeDir, slug, ids);
  const runId = ids.runId();

  const logOptions = {
    storeDir: loaded.storeDir,
    itemId,
    runId,
    clock,
    ids,
    logger,
    onAppend: display.onEvent,
  };
  const { log } = existing ? await EventLog.open(logOptions) : await EventLog.create(logOptions);

  const abortController = new AbortController();
  const onSigint = (): void => {
    abortController.abort();
  };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigint);

  let result: RunItemResult;
  let primaryRunFinished = false;
  try {
    display.conversation('You / request', await readFile(prdPath, 'utf8'));
    if (existing) display.history(await log.readAll());
    if (!existing) {
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
    }
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

    if (existing?.status === 'active') {
      // Acquiring the item lock proves no live writer owns this interrupted run.
      await log.append({ type: 'WorkItemParked', data: { reason: 'operator-abort', detail: 'Recovering an interrupted run', resumable: true, account: null, resets_at: null }, actor: { kind: 'system', id: null }, causationId: log.lastEventId });
    }

    try {
      result = await runOneItem({
        display,
        loaded,
        itemId,
        log,
        clock,
        ids,
        logger,
        signal: abortController.signal,
        retainWorkspace: options.retainWorkspace ?? false,
      });
    } catch (error) {
      // An exception outside the supervisor's normal StageFailed/park paths used to leave
      // the item looking active forever. Record a terminal outcome before rethrowing so both
      // the live feed and a later status/replay explain what actually happened.
      const events = await log.readAll();
      const alreadyTerminal = project(events).status !== 'active';
      if (!alreadyTerminal) {
        await log.append({
          type: 'WorkItemFailed',
          data: {
            reason: 'internal-error',
            detail: error instanceof Error ? error.message : String(error),
          },
          actor: { kind: 'system', id: null },
          causationId: log.lastEventId,
        });
      }
      const eventsAppendedBeforeFinish = log.lastSeq;
      await log.append({
        type: 'RunFinished',
        data: { outcome: 'failed', events_appended: eventsAppendedBeforeFinish },
        actor: { kind: 'system', id: null },
        causationId: log.lastEventId,
      });
      throw error;
    }

    const eventsAppendedBeforeFinish = log.lastSeq;
    await log.append({
      type: 'RunFinished',
      data: { outcome: result.outcome, events_appended: eventsAppendedBeforeFinish },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });
    primaryRunFinished = true;
  } finally {
    await log.close();
    if (!primaryRunFinished) {
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigint);
    }
  }

  let backlog: BacklogResultRow[] = [];
  try {
    if (options.noBacklog === false && !abortController.signal.aborted) {
      backlog = await drainBacklog({
        display,
        loaded,
        runId,
        newItemId: itemId,
        newItemResult: result,
        clock,
        ids,
        logger,
        retainWorkspace: options.retainWorkspace ?? false,
        signal: abortController.signal,
        showProgress: options.json !== true,
      });
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigint);
  }
  display.close();
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
