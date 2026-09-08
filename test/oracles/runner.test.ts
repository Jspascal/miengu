import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { WorkItemIdSchema, RunIdSchema } from '../../src/core/ids.js';
import { EventLog } from '../../src/core/log.js';
import type { AppendInput, OpenLogOptions } from '../../src/core/log.js';
import { silentLogger } from '../../src/logging.js';
import { sha256Hex } from '../../src/core/hash.js';
import { runOracleSweep } from '../../src/oracles/runner.js';
import type { OracleRunnerInput } from '../../src/oracles/runner.js';

const FAKE_ORACLE = fileURLToPath(new URL('../fixtures/fake-oracle.mjs', import.meta.url));
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;
const itemId = WorkItemIdSchema.parse('wi-oracle-abc123');
let root: string;
let storeDir: string;
let workdir: string;
let evidenceDir: string;
let orderFile: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'miengu-oracle-'));
  storeDir = join(root, 'store');
  workdir = join(root, 'workdir');
  evidenceDir = join(root, 'evidence');
  orderFile = join(root, 'order.txt');
  await writeFile(orderFile, '', 'utf8');
  await writeFile(join(root, '.keep'), '', 'utf8');
  await (await import('node:fs/promises')).mkdir(workdir);
  delete process.env['FAKE_ORACLE_MODE'];
  delete process.env['FAKE_ORACLE_ORDER_FILE'];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  delete process.env['FAKE_ORACLE_MODE'];
  delete process.env['FAKE_ORACLE_ORDER_FILE'];
});

function command(mode: string): string {
  return `FAKE_ORACLE_MODE=${mode} FAKE_ORACLE_ORDER_FILE=${JSON.stringify(orderFile)} node ${JSON.stringify(FAKE_ORACLE)}`;
}

async function makeInput(o: {
  commands?: Partial<Record<'build' | 'typecheck' | 'lint' | 'test', string | null>>;
  timeoutMs?: number;
  signal?: AbortSignal;
} = {}): Promise<{ input: OracleRunnerInput; events: () => Promise<readonly string[]>; close: () => Promise<void> }> {
  const options: OpenLogOptions = {
    storeDir,
    itemId,
    runId: RunIdSchema.parse('run-01234567-89ab-cdef-0123-456789abcdef'),
    clock: fixedClock(START, 1),
    ids: createIdMinter(fixedRng('oracle-runner')),
    logger: silentLogger,
  };
  const { log } = await EventLog.create(options);
  await log.append({
    type: 'WorkItemCreated',
    data: { title: 'Oracle', slug: 'oracle', source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'b'.repeat(64) },
    actor: { kind: 'system', id: null }, causationId: null,
  });
  const append = async (event: Omit<AppendInput, 'causationId'>) => {
    const appended = await log.append({ ...event, causationId: null });
    return { ts: appended.ts, eventId: appended.event_id };
  };
  return {
    input: {
      scope: 'task', taskId: null, workdir, timeoutMs: o.timeoutMs ?? 3_000,
      commands: { build: null, typecheck: null, lint: null, test: null, ...o.commands },
      signal: o.signal ?? new AbortController().signal, evidenceDir, append, causeId: null,
    },
    events: async () => (await log.readAll()).map((event) => event.type),
    close: () => log.close(),
  };
}

describe.sequential('runOracleSweep', () => {
  it('records a passing command with durable content-addressed evidence', async () => {
    const harness = await makeInput({ commands: { build: command('pass') } });
    const result = await runOracleSweep(harness.input);
    expect(result.outcome).toBe('passed');
    expect(result.results).toHaveLength(1);
    const recorded = result.results[0];
    expect(recorded?.stdout.sha256).toBe(sha256Hex('passing stdout'));
    expect(recorded?.stderr.sha256).toBe(sha256Hex('passing stderr'));
    expect(await readFile(recorded?.stdout.path ?? '', 'utf8')).toBe('passing stdout');
    expect(await readFile(recorded?.stderr.path ?? '', 'utf8')).toBe('passing stderr');
    expect(await harness.events()).toEqual(['WorkItemCreated', 'OracleSweepStarted', 'OracleResultRecorded', 'OracleSweepCompleted']);
    await harness.close();
  });

  it('rehashes existing evidence instead of accepting a same-size collision', async () => {
    const harness = await makeInput({ commands: { build: command('pass') } });
    const expected = Buffer.from('passing stdout');
    const collision = join(evidenceDir, `${sha256Hex(expected)}.stdout`);
    await (await import('node:fs/promises')).mkdir(evidenceDir, { recursive: true });
    await writeFile(collision, 'same-size-junk');
    await expect(runOracleSweep(harness.input)).rejects.toThrow(/evidence mismatch/);
    await harness.close();
  });

  it('fails fast in fixed build -> typecheck -> lint -> test order', async () => {
    const harness = await makeInput({ commands: { build: command('pass'), typecheck: command('fail'), lint: command('pass'), test: command('pass') } });
    const result = await runOracleSweep(harness.input);
    expect(result.outcome).toBe('failed');
    expect(result.failedKind).toBe('typecheck');
    expect(result.results.map((item) => item.kind)).toEqual(['build', 'typecheck']);
    expect(await readFile(orderFile, 'utf8')).toBe('pass\nfail\n');
    await harness.close();
  });

  it('skips null commands and emits a durable empty passing sweep', async () => {
    const harness = await makeInput();
    const result = await runOracleSweep(harness.input);
    expect(result).toMatchObject({ outcome: 'passed', failedKind: null, results: [] });
    expect(await harness.events()).toEqual(['WorkItemCreated', 'OracleSweepStarted', 'OracleSweepCompleted']);
    await harness.close();
  });

  it('uses shell composition for an operator-authored command', async () => {
    const harness = await makeInput({ commands: { test: `${command('pass')} && ${command('pass')}` } });
    const result = await runOracleSweep(harness.input);
    expect(result.outcome).toBe('passed');
    expect(await readFile(orderFile, 'utf8')).toBe('pass\npass\n');
    await harness.close();
  });

  it('records timeout after TERM grace expires and forces SIGKILL', async () => {
    const hangCommand = `FAKE_ORACLE_MODE=hang FAKE_ORACLE_ORDER_FILE=${JSON.stringify(orderFile)} exec node ${JSON.stringify(FAKE_ORACLE)}`;
    const harness = await makeInput({ commands: { build: hangCommand }, timeoutMs: 1_000 });
    const result = await runOracleSweep(harness.input);
    expect(result.outcome).toBe('failed');
    expect(result.results[0]).toMatchObject({ status: 'timed-out', signal: 'SIGKILL' });
    await harness.close();
  });

  it('kills a TERM-ignoring background descendant with its shell process group', async () => {
    const harness = await makeInput({ commands: { build: command('background') }, timeoutMs: 1_000 });
    const result = await runOracleSweep(harness.input);
    expect(result).toMatchObject({ outcome: 'failed' });
    expect(result.results[0]).toMatchObject({ status: 'timed-out' });
    await harness.close();
  });

  it('keeps the SIGKILL grace ladder after the TERM-exiting shell closes around a closed-stdio descendant', async () => {
    const pidFile = join(root, 'descendant.pid');
    const closedDescendant = `FAKE_ORACLE_MODE=term-exit-background-closed FAKE_ORACLE_ORDER_FILE=${JSON.stringify(orderFile)} FAKE_ORACLE_PID_FILE=${JSON.stringify(pidFile)} node ${JSON.stringify(FAKE_ORACLE)}`;
    const harness = await makeInput({ commands: { build: closedDescendant }, timeoutMs: 1_000 });
    const result = await runOracleSweep(harness.input);
    const pid = Number(await readFile(pidFile, 'utf8'));
    expect(result.results[0]).toMatchObject({ status: 'timed-out', signal: 'SIGKILL' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
    await harness.close();
  });

  it('records an abort without treating it as a failed oracle', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = await makeInput({ commands: { build: command('pass') }, signal: controller.signal });
    const result = await runOracleSweep(harness.input);
    expect(result).toMatchObject({ outcome: 'aborted', failedKind: null, results: [] });
    expect(await harness.events()).toEqual(['WorkItemCreated', 'OracleSweepStarted', 'OracleSweepCompleted']);
    await harness.close();
  });

  it('records a spawn error and always completes the sweep', async () => {
    const missingWorkdir = join(root, 'does-not-exist');
    const harness = await makeInput({ commands: { build: command('pass') } });
    const result = await runOracleSweep({ ...harness.input, workdir: missingWorkdir });
    expect(result.results[0]).toMatchObject({ status: 'spawn-error', exitCode: null, signal: null });
    expect(await harness.events()).toEqual(['WorkItemCreated', 'OracleSweepStarted', 'OracleResultRecorded', 'OracleSweepCompleted']);
    await harness.close();
  });
});
