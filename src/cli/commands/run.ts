import { mkdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { assertNever } from '../../core/events.js';
import { sha256File } from '../../core/hash.js';
import { itemPaths } from '../../core/log.js';
import { EventLog } from '../../core/log.js';
import { systemClock } from '../../core/clock.js';
import { createIdMinter, systemRng } from '../../core/idgen.js';
import type { IdMinter } from '../../core/idgen.js';
import { slugify } from '../../core/ids.js';
import type { WorkItemId } from '../../core/ids.js';
import { StoreError } from '../../errors.js';
import { createLogger } from '../../logging.js';
import { loadConfig } from '../../config/load.js';
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
import { EXIT } from '../exit.js';

const MIENGU_VERSION = '0.1.0';

export interface RunCommandOptions {
  readonly prdFile: string;
  readonly configPath?: string | undefined;
  readonly retainWorkspace?: boolean | undefined;
  readonly json?: boolean | undefined;
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
 * Mints a work item and runs it, via `runItem`, to completion or park. Constructs the
 * executor registry (eagerly, per role) after `RunStarted` and before `runItem` — a
 * `ConfigError` from a misconfigured sandbox therefore propagates before any `StageEntered`
 * is ever appended. Never runs more than one item, never commits anything, and never leaves
 * the write lock held on any exit path.
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
  const paths = itemPaths(loaded.storeDir, itemId);

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
      signal: abortController.signal,
      retainWorkspace: options.retainWorkspace ?? false,
    };

    let result = await runItem(deps);

    if (abortController.signal.aborted) {
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

    const eventsAppendedBeforeFinish = log.lastSeq;
    await log.append({
      type: 'RunFinished',
      data: { outcome: result.outcome, events_appended: eventsAppendedBeforeFinish },
      actor: { kind: 'system', id: null },
      causationId: log.lastEventId,
    });

    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          item: itemId,
          outcome: result.outcome,
          stage: result.finalState.stage,
          status: result.finalState.status,
        })}\n`,
      );
    } else {
      process.stdout.write(
        `item      ${itemId}\noutcome   ${result.outcome}\nstage     ${result.finalState.stage}\nstatus    ${result.finalState.status}\n`,
      );
    }

    return exitCodeForOutcome(result.outcome);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await log.close();
  }
}
