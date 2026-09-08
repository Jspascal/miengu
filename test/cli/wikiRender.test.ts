import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wikiRenderCommand } from '../../src/cli/commands/wikiRender.js';
import { EXIT } from '../../src/cli/exit.js';
import { fixedClock } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { EventLog, itemPaths } from '../../src/core/log.js';
import type { WorkItemId } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';

let workDir: string;
let configPath: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'miengu-cli-wikirender-work-'));
  configPath = join(workDir, 'miengu.config.yaml');
  await writeFile(
    configPath,
    [
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
      'wiki:',
      '  language: en',
      'store:',
      '  dir: .miengu',
      '',
    ].join('\n'),
    'utf8',
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Hand-written v3 event log: `WorkItemCreated` + one `architecture` `StageCompleted` naming a
 *  single component, which mints exactly one active `T2` `component` claim (§2's emission map).
 *  Never invokes a provider. */
async function createItemFixture(slug: string, componentId: string): Promise<WorkItemId> {
  const storeDir = join(workDir, '.miengu');
  const ids = createIdMinter(fixedRng(`wikirender-${slug}`));
  const itemId = ids.workItemId(slug);
  const { log } = await EventLog.create({
    storeDir,
    itemId,
    runId: ids.runId(),
    clock: fixedClock('2024-01-01T00:00:00.000Z'),
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
  await log.append({
    type: 'StageCompleted',
    data: {
      stage: 'architecture',
      attempt: 1,
      artifact: {
        kind: 'architecture-plan',
        sha256: 'b'.repeat(64),
        body: {
          decisions: [],
          components: [{ component_id: componentId, responsibility: `owns ${slug}`, paths: [], depends_on: [] }],
          interfaces: [],
        },
      },
    },
    actor: { kind: 'system', id: null },
    causationId: log.lastEventId,
  });
  await log.close();
  return itemId;
}

async function corruptItem(storeDir: string, itemId: WorkItemId): Promise<void> {
  const paths = itemPaths(storeDir, itemId);
  await writeFile(paths.eventsFile, 'not json at all\n', { flag: 'a' });
}

describe('wikiRenderCommand', () => {
  it('writes only wiki/index.md against an empty store, exit 0', async () => {
    const result = await wikiRenderCommand({ configPath, json: true });
    expect(result).toBe(EXIT.OK);
    const storeDir = join(workDir, '.miengu');
    await expect(readFile(join(storeDir, 'wiki', 'index.md'), 'utf8')).resolves.toContain('Wiki index');
    await expect(
      rm(join(storeDir, 'wiki', 'components'), { recursive: false }).then(
        () => 'existed',
        () => 'absent',
      ),
    ).resolves.toBe('absent');
  });

  it('renders the expected file set and content for a populated store', async () => {
    await createItemFixture('alpha', 'component-alpha-1');
    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let result: number;
    try {
      result = await wikiRenderCommand({ configPath, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(result).toBe(EXIT.OK);
    const payload = JSON.parse(output) as {
      files: { path: string }[];
      removed: string[];
      items: number;
      claims: number;
      language: string;
      corrupt: unknown[];
    };
    expect(payload.files.map((f) => f.path).sort()).toEqual([
      'wiki/components/component-alpha-1.md',
      'wiki/index.md',
    ]);
    expect(payload.removed).toEqual([]);
    expect(payload.items).toBe(1);
    expect(payload.claims).toBe(1);
    expect(payload.language).toBe('en');
    expect(payload.corrupt).toEqual([]);

    const storeDir = join(workDir, '.miengu');
    const componentFile = await readFile(join(storeDir, 'wiki', 'components', 'component-alpha-1.md'), 'utf8');
    expect(componentFile).toContain('owns alpha');
  });

  it('is idempotent: a second run is byte-identical and reports zero removals', async () => {
    await createItemFixture('beta', 'component-beta-1');
    await wikiRenderCommand({ configPath, json: true });
    const storeDir = join(workDir, '.miengu');
    const before = await readFile(join(storeDir, 'wiki', 'components', 'component-beta-1.md'), 'utf8');
    const beforeIndex = await readFile(join(storeDir, 'wiki', 'index.md'), 'utf8');

    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await wikiRenderCommand({ configPath, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(output) as { removed: string[] };
    expect(payload.removed).toEqual([]);

    const after = await readFile(join(storeDir, 'wiki', 'components', 'component-beta-1.md'), 'utf8');
    const afterIndex = await readFile(join(storeDir, 'wiki', 'index.md'), 'utf8');
    expect(after).toBe(before);
    expect(afterIndex).toBe(beforeIndex);
  });

  it('removes a stale owned file it no longer renders and leaves an unowned file untouched', async () => {
    await createItemFixture('gamma', 'component-gamma-1');
    await wikiRenderCommand({ configPath, json: true });
    const storeDir = join(workDir, '.miengu');
    const wikiDir = join(storeDir, 'wiki');
    await writeFile(join(wikiDir, 'components', 'component-old-1.md'), 'stale\n', 'utf8');
    await writeFile(join(wikiDir, 'notes.md'), 'operator notes\n', 'utf8');

    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await wikiRenderCommand({ configPath, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    const payload = JSON.parse(output) as { removed: string[] };
    expect(payload.removed).toEqual(['wiki/components/component-old-1.md']);

    await expect(
      readFile(join(wikiDir, 'components', 'component-old-1.md'), 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
    await expect(readFile(join(wikiDir, 'notes.md'), 'utf8')).resolves.toBe('operator notes\n');
  });

  it('isolates a corrupt item, still renders the healthy one, and exits 4', async () => {
    const healthyId = await createItemFixture('delta', 'component-delta-1');
    const badId = await createItemFixture('epsilon', 'component-epsilon-1');
    const storeDir = join(workDir, '.miengu');
    await corruptItem(storeDir, badId);

    let output = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    let result: number;
    try {
      result = await wikiRenderCommand({ configPath, json: true });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(result).toBe(EXIT.STORE);
    const payload = JSON.parse(output) as {
      items: number;
      corrupt: { itemId: string }[];
      files: { path: string }[];
    };
    expect(payload.items).toBe(1);
    expect(payload.corrupt.map((c) => c.itemId)).toEqual([badId]);
    expect(payload.files.map((f) => f.path)).toContain('wiki/components/component-delta-1.md');
    expect(healthyId).not.toBe(badId);
  });

  it('does not acquire the write lock', async () => {
    const itemId = await createItemFixture('zeta', 'component-zeta-1');
    const storeDir = join(workDir, '.miengu');
    const paths = itemPaths(storeDir, itemId);

    await wikiRenderCommand({ configPath, json: true });

    await expect(
      readFile(paths.lockFile, 'utf8').then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);
  });
});
