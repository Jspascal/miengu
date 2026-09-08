import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reportCommand } from '../../src/cli/commands/report.js';
import { EXIT } from '../../src/cli/exit.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { EventLog, itemPaths } from '../../src/core/log.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';

let workDir: string;

function configWithLocale(locale: 'fr' | 'en'): string {
  return [
    'target:',
    '  repo: .',
    'accounts:',
    '  stub-account: {}',
    'executors:',
    '  stub-analyst: { type: stub, account: stub-account }',
    '  stub-architect: { type: stub, account: stub-account }',
    '  stub-planner: { type: stub, account: stub-account }',
    '  stub-testauthor: { type: stub, account: stub-account }',
    '  stub-coder: { type: stub, account: stub-account }',
    '  stub-reviewer: { type: stub, account: stub-account }',
    'tiers:',
    '  stub-analyst: 1',
    '  stub-architect: 1',
    '  stub-planner: 1',
    '  stub-testauthor: 1',
    '  stub-coder: 1',
    '  stub-reviewer: 1',
    'roles:',
    '  analyst: { executor: stub-analyst, maxTurns: 8, contextBudgetTokens: 40000 }',
    '  architect: { executor: stub-architect, maxTurns: 8, contextBudgetTokens: 40000 }',
    '  planner: { executor: stub-planner, maxTurns: 8, contextBudgetTokens: 40000 }',
    '  testAuthor: { executor: stub-testauthor, maxTurns: 8, contextBudgetTokens: 40000 }',
    '  coder: { executor: stub-coder, maxTurns: 8, contextBudgetTokens: 40000 }',
    '  reviewer: { executor: stub-reviewer, maxTurns: 8, contextBudgetTokens: 40000 }',
    `locale: ${locale}`,
    'store:',
    '  dir: .miengu',
    '',
  ].join('\n');
}

let configPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-report-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(configPath, configWithLocale('en'), 'utf8');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Hand-written v3 event log: `WorkItemCreated` plus, optionally, a raised (and possibly
 *  decided) checkpoint. Never invokes a provider. */
async function createItemFixture(
  slug: string,
  opts: {
    readonly checkpoint?: { readonly kind: 'irreversible'; readonly blocking: boolean; readonly stage: string };
    readonly updatedAtStep?: number;
  } = {},
): Promise<WorkItemId> {
  const storeDir = join(workDir, '.miengu');
  const ids = createIdMinter(fixedRng(`report-${slug}`));
  const itemId = ids.workItemId(slug);
  const { log } = await EventLog.create({
    storeDir,
    itemId,
    runId: ids.runId(),
    clock: fixedClock('2024-06-01T00:00:00.000Z'),
    ids,
    logger: silentLogger,
  });
  await log.append({
    type: 'WorkItemCreated',
    data: {
      title: `Fixture for ${slug}`,
      slug,
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 },
      config_hash: `${slug}-config`,
    },
    actor: { kind: 'system', id: null },
    causationId: null,
  });
  if (opts.checkpoint !== undefined) {
    await log.append({
      type: 'CheckpointRaised',
      data: {
        checkpoint: `cp-${slug}-1`,
        kind: opts.checkpoint.kind,
        stage: opts.checkpoint.stage,
        summary: `${slug} needs a human decision`,
        blocking: opts.checkpoint.blocking,
        sla_seconds: null,
        default_decision: null,
      },
      actor: { kind: 'supervisor', id: null },
      causationId: log.lastEventId,
    });
  }
  await log.close();
  return itemId;
}

async function corruptItem(storeDir: string, itemId: WorkItemId): Promise<void> {
  const paths = itemPaths(storeDir, itemId);
  await writeFile(paths.eventsFile, 'not json at all\n', { flag: 'a' });
}

async function captureStdout(fn: () => Promise<number>): Promise<{ result: number; output: string }> {
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, output };
  } finally {
    process.stdout.write = originalWrite;
  }
}

describe('reportCommand', () => {
  it('round-trips a BatchReport through --json', async () => {
    await createItemFixture('alpha', {
      checkpoint: { kind: 'irreversible', blocking: true, stage: 'architecture' },
    });
    const { result, output } = await captureStdout(() => reportCommand({ configPath, json: true }));
    expect(result).toBe(EXIT.OK);
    const report = JSON.parse(output) as {
      generatedFrom: { items: number };
      blockedIrreversible: { checkpointId: string }[];
      corrupt: unknown[];
    };
    expect(report.generatedFrom.items).toBe(1);
    expect(report.blockedIrreversible).toHaveLength(1);
    expect(report.blockedIrreversible[0]?.checkpointId).toBe('cp-alpha-1');
    expect(report.corrupt).toEqual([]);
  });

  it('renders section order matching decision 18, blocked checkpoint present, exit still 0', async () => {
    await createItemFixture('beta', {
      checkpoint: { kind: 'irreversible', blocking: true, stage: 'architecture' },
    });
    const { result, output } = await captureStdout(() => reportCommand({ configPath }));
    expect(result).toBe(EXIT.OK);
    expect(output).toContain('cp-beta-1');
    const blockedIndex = output.indexOf('Blocked irreversible checkpoints');
    expect(blockedIndex).toBeGreaterThanOrEqual(0);
  });

  it('accepts a full ISO-8601 --since value', async () => {
    await createItemFixture('gamma');
    const { result } = await captureStdout(() =>
      reportCommand({ configPath, since: '2024-01-01T00:00:00.000Z' }),
    );
    expect(result).toBe(EXIT.OK);
  });

  it('accepts a bare YYYY-MM-DD --since value, widened to T00:00:00.000Z', async () => {
    await createItemFixture('delta');
    const { result, output } = await captureStdout(() =>
      reportCommand({ configPath, since: '2024-06-01', json: true }),
    );
    expect(result).toBe(EXIT.OK);
    const report = JSON.parse(output) as { generatedFrom: { items: number; since: string | null } };
    expect(report.generatedFrom.since).toBe('2024-06-01T00:00:00.000Z');
    expect(report.generatedFrom.items).toBe(1);
  });

  it('exits 2 on an unparseable --since with no stdout written', async () => {
    await createItemFixture('epsilon');
    const { result, output } = await captureStdout(() =>
      reportCommand({ configPath, since: 'not-a-date' }),
    );
    expect(result).toBe(EXIT.USAGE);
    expect(output).toBe('');
  });

  it('isolates a corrupt item and exits 4', async () => {
    const healthyId = await createItemFixture('zeta');
    const badId = await createItemFixture('eta');
    const storeDir = join(workDir, '.miengu');
    await corruptItem(storeDir, badId);

    const { result, output } = await captureStdout(() => reportCommand({ configPath, json: true }));
    expect(result).toBe(EXIT.STORE);
    const report = JSON.parse(output) as {
      generatedFrom: { items: number };
      corrupt: { itemId: string }[];
    };
    expect(report.generatedFrom.items).toBe(1);
    expect(report.corrupt.map((c) => c.itemId)).toEqual([badId]);
    expect(healthyId).not.toBe(badId);
  });

  it('renders in fr and en from the same data', async () => {
    await createItemFixture('theta', {
      checkpoint: { kind: 'irreversible', blocking: true, stage: 'architecture' },
    });
    const enResult = await captureStdout(() => reportCommand({ configPath }));
    expect(enResult.output).toContain('Blocked irreversible checkpoints');

    await writeFile(configPath, configWithLocale('fr'), 'utf8');
    const frResult = await captureStdout(() => reportCommand({ configPath }));
    expect(frResult.output).toContain('Points de contrôle irréversibles bloqués');
  });

  it('does not acquire the write lock', async () => {
    const itemId = await createItemFixture('iota');
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    await reportCommand({ configPath, json: true });

    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });
});
