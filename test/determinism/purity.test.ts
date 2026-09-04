import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_TIER, MienguEventSchema } from '../../src/core/events.js';
import type { EventType, MienguEvent, Stage } from '../../src/core/events.js';
import { project } from '../../src/state/projector.js';
import { stateHash } from '../../src/state/stateHash.js';

const ITEM_ID = 'wi-example-abc123';
const RUN_ID = 'run-00000000-0000-4000-8000-000000000001';

function hexId(prefix: string, n: number): string {
  const hex = n.toString(16).padStart(32, '0');
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function tsAt(n: number): string {
  return `2024-01-01T00:00:00.${String(n).padStart(3, '0')}Z`;
}

function mkEvent(seq: number, type: EventType, data: unknown): MienguEvent {
  return MienguEventSchema.parse({
    schema_version: 1,
    event_id: hexId('evt', seq),
    seq,
    item_id: ITEM_ID,
    run_id: RUN_ID,
    ts: tsAt(seq),
    tier: DEFAULT_TIER[type],
    actor: { kind: 'system', id: null },
    causation_id: null,
    type,
    data,
  });
}

const STAGE_CYCLE: readonly Stage[] = [
  'intake',
  'analysis',
  'architecture',
  'planning',
  'test-authoring',
  'implementation',
  'review',
  'integration',
  'done',
];

/** A deterministic, self-contained N-event golden fixture built without idgen.ts or
 * clock.ts, so this file never has to import a module that touches `node:crypto`. */
function buildFixture(n: number): MienguEvent[] {
  const events: MienguEvent[] = [
    mkEvent(1, 'WorkItemCreated', {
      title: 'Example item',
      slug: 'example',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
      config_hash: 'deadbeef',
    }),
  ];

  let cycleIndex = 0;
  let seq = 2;
  while (events.length < n) {
    const stage = STAGE_CYCLE[Math.floor(cycleIndex / 6) % STAGE_CYCLE.length] as Stage;
    const phase = cycleIndex % 6;
    switch (phase) {
      case 0:
        events.push(mkEvent(seq, 'StageEntered', { stage, attempt: 1 }));
        break;
      case 1:
        events.push(
          mkEvent(seq, 'ExecutorInvoked', {
            executor_id: 'stub',
            stage,
            workdir: '/tmp/wd',
            prompt_sha256: 'a'.repeat(64),
            prompt_bytes: 10,
            context_pack_id: null,
            session_id: null,
            budget: { max_turns: 10, max_wall_seconds: 60 },
            command_line: ['stub'],
          }),
        );
        break;
      case 2:
        events.push(
          mkEvent(seq, 'ExecutorReturned', {
            executor_id: 'stub',
            stage,
            status: 'completed',
            telemetry: { turns: 1, input_tokens: null, output_tokens: null, wall_seconds: 1 },
            raw: {
              exit_code: 0,
              signal: null,
              killed: 'none',
              observed_turns: 1,
              failure_kind: null,
              stderr_tail: '',
              transcript_path: null,
            },
          }),
        );
        break;
      case 3:
        events.push(
          mkEvent(seq, 'DiffCaptured', {
            workdir: '/tmp/wd',
            diff_sha256: 'b'.repeat(64),
            diff_ref: null,
            files_touched: [],
            untracked: [],
            insertions: 0,
            deletions: 0,
            committed_during_run: false,
          }),
        );
        break;
      case 4:
        events.push(mkEvent(seq, 'BudgetConsumed', { scope: 'task', wall_seconds: 1, turns: 1, usd: null }));
        break;
      case 5:
      default:
        events.push(mkEvent(seq, 'StageCompleted', { stage, attempt: 1, artifact: null }));
        break;
    }
    seq += 1;
    cycleIndex += 1;
  }

  return events;
}

function poisonedModule(name: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`${name} must not be touched by the projector (accessed: ${String(prop)})`);
      },
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('(a) poisoned globals', () => {
  it('project() never touches Date, Math.random, performance.now, node:fs, node:crypto, or node:child_process', async () => {
    const events = buildFixture(40);

    class ThrowingDate {
      constructor() {
        throw new Error('Date must not be touched by the projector');
      }
      static now(): number {
        throw new Error('Date.now must not be touched by the projector');
      }
    }
    vi.stubGlobal('Date', ThrowingDate);
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be touched by the projector');
    });
    vi.spyOn(performance, 'now').mockImplementation(() => {
      throw new Error('performance.now must not be touched by the projector');
    });

    vi.resetModules();
    vi.doMock('node:fs', () => poisonedModule('node:fs'));
    vi.doMock('node:fs/promises', () => poisonedModule('node:fs/promises'));
    vi.doMock('node:crypto', () => poisonedModule('node:crypto'));
    vi.doMock('node:child_process', () => poisonedModule('node:child_process'));

    try {
      const poisoned = await import('../../src/state/projector.js');
      expect(() => poisoned.project(events)).not.toThrow();
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('node:fs/promises');
      vi.doUnmock('node:crypto');
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
  });
});

describe('(b) time-independence', () => {
  it('projecting the same fixture under two different system-time instants yields the same stateHash', () => {
    const events = buildFixture(40);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
    const stateAtInstantOne = project(events);

    vi.setSystemTime(new Date('2031-06-15T12:34:56.000Z'));
    const stateAtInstantTwo = project(events);

    expect(stateHash(stateAtInstantOne)).toBe(stateHash(stateAtInstantTwo));
  });
});

describe('(c) snapshot-equivalence property', () => {
  it('splitting the fixture at every k and resuming from an intermediate projection reproduces the same stateHash', () => {
    const events = buildFixture(40);
    const wholeHash = stateHash(project(events));

    for (let k = 1; k <= events.length; k += 1) {
      const prefix = project(events.slice(0, k));
      const resumed = project(events.slice(k), prefix);
      expect(stateHash(resumed)).toBe(wholeHash);
    }
  });
});

describe('(d) static import audit', () => {
  const DETERMINISM_ZONE_FILES = [
    'src/state/workitem.ts',
    'src/state/projector.ts',
    'src/supervisor/budget.ts',
    'src/core/ids.ts',
    'src/core/canonical.ts',
    'src/core/provenance.ts',
    'src/core/events.ts',
  ];
  const FORBIDDEN_SUBSTRINGS = ['Date.now', 'new Date', 'Math.random', 'process.env'];

  for (const relPath of DETERMINISM_ZONE_FILES) {
    it(`${relPath} contains no node: import and no forbidden substring`, () => {
      const source = readFileSync(join(process.cwd(), relPath), 'utf8');
      expect(source).not.toMatch(/from ['"]node:/);
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(source).not.toContain(forbidden);
      }
    });
  }
});
