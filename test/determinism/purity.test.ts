import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../../src/core/canonical.js';
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
    schema_version: 4,
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

const ACCOUNTS = ['claude-personal', 'codex-personal'] as const;

function executorInvoked(seq: number, stage: Stage, account: (typeof ACCOUNTS)[number]): MienguEvent {
  return mkEvent(seq, 'ExecutorInvoked', {
    executor_id: 'stub',
    executor_type: 'stub',
    account,
    role: null,
    stage,
    workdir: '/tmp/wd',
    sandbox_intent: 'workspace-write',
    native_structured_output: false,
    output_schema_sha256: null,
    prompt_sha256: 'a'.repeat(64),
    prompt_bytes: 10,
    prompt_path: null,
    prompt_template_sha256: null,
    validation_attempt: 1,
    context_pack_id: null,
    context_pack_estimated_tokens: null,
    resolved: { model: null, effort: null, max_turns: 10, context_budget_tokens: 1000 },
    budget: { max_turns: 10, max_wall_seconds: 60 },
    command_line: ['stub'],
    session_id: 'sess-stub',
  });
}

function executorReturned(
  seq: number,
  stage: Stage,
  account: (typeof ACCOUNTS)[number],
  status: 'completed' | 'quota_exhausted',
): MienguEvent {
  return mkEvent(seq, 'ExecutorReturned', {
    executor_id: 'stub',
    executor_type: 'stub',
    account,
    stage,
    status,
    telemetry: {
      turns: 1,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      wall_seconds: 1,
    },
    quota:
      status === 'quota_exhausted'
        ? {
            account,
            source: 'rate-limit-event',
            status: 'blocked',
            utilization: 1,
            window_kind: 'five_hour',
            resets_at: null,
          }
        : null,
    raw: {
      exit_code: 0,
      signal: null,
      killed: 'none',
      observed_turns: 1,
      failure_kind: null,
      stderr_tail: '',
      transcript_path: null,
      final_message_bytes: null,
      command_line: ['stub'],
      session_id: 'sess-stub',
    },
  });
}

/** A deterministic, self-contained N-event golden fixture built without idgen.ts or
 * clock.ts, so this file never has to import a module that touches `node:crypto`. Includes
 * at least one `BudgetConsumed` per account, one `ExecutorReturned{quota_exhausted}`, one
 * `TestsFrozen`, and a matched `WorktreeLockAcquired`/`Released` pair. */
function buildFixture(n: number): MienguEvent[] {
  const events: MienguEvent[] = [
    mkEvent(1, 'WorkItemCreated', {
      title: 'Example item',
      slug: 'example',
      source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
      config_hash: 'deadbeef',
    }),
  ];
  let seq = 2;
  function push(event: MienguEvent): void {
    events.push(event);
    seq += 1;
  }

  // Fixed prefix: exercises every Phase 2 delta at least once, deterministically.
  push(mkEvent(seq, 'StageEntered', { stage: 'implementation', attempt: 1 }));
  push(
    mkEvent(seq, 'WorktreeLockAcquired', {
      workdir: '/tmp/wd',
      holder: 'cc-sonnet',
      stage: 'implementation',
      intent: 'workspace-write',
    }),
  );
  push(executorInvoked(seq, 'implementation', 'claude-personal'));
  push(executorReturned(seq, 'implementation', 'claude-personal', 'quota_exhausted'));
  push(
    mkEvent(seq, 'WorktreeLockReleased', {
      workdir: '/tmp/wd',
      holder: 'cc-sonnet',
      stage: 'implementation',
      reclaimed: false,
    }),
  );
  push(mkEvent(seq, 'BudgetConsumed', { scope: 'task', account: 'claude-personal', wall_seconds: 1, turns: 1, usd: null }));
  push(mkEvent(seq, 'BudgetConsumed', { scope: 'task', account: 'codex-personal', wall_seconds: 1, turns: 1, usd: null }));
  push(
    mkEvent(seq, 'TestsFrozen', {
      suite_id: 'suite-example-1',
      content_hash: 'c'.repeat(64),
      files: [{ path: 'test/x.test.ts', sha256: 'd'.repeat(64), bytes: 10 }],
      frozen_copy_dir: '/tmp/frozen',
    }),
  );
  push(mkEvent(seq, 'StageCompleted', { stage: 'implementation', attempt: 1, artifact: null }));

  let cycleIndex = 0;
  while (events.length < n) {
    const stage = STAGE_CYCLE[Math.floor(cycleIndex / 6) % STAGE_CYCLE.length] as Stage;
    const phase = cycleIndex % 6;
    const account = ACCOUNTS[cycleIndex % ACCOUNTS.length] as (typeof ACCOUNTS)[number];
    switch (phase) {
      case 0:
        push(mkEvent(seq, 'StageEntered', { stage, attempt: 1 }));
        break;
      case 1:
        push(executorInvoked(seq, stage, account));
        break;
      case 2:
        push(executorReturned(seq, stage, account, 'completed'));
        break;
      case 3:
        push(
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
        push(
          mkEvent(seq, 'BudgetConsumed', {
            scope: 'task',
            account,
            wall_seconds: 1,
            turns: 1,
            usd: null,
          }),
        );
        break;
      case 5:
      default:
        push(mkEvent(seq, 'StageCompleted', { stage, attempt: 1, artifact: null }));
        break;
    }
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
    'src/supervisor/nextStage.ts',
    'src/supervisor/budget.ts',
    'src/supervisor/blastRadius.ts',
    'src/supervisor/assumptions.ts',
    'src/supervisor/checkpointPolicy.ts',
    'src/supervisor/backlog.ts',
    'src/core/ids.ts',
    'src/core/canonical.ts',
    'src/core/provenance.ts',
    'src/core/events.ts',
    // Phase 4 additions (Group A item 3). records.ts exists as of Group A item 1;
    // packmaterials.ts, humanview.ts and report/batch.ts are added by items 5, 12 and 15 and
    // this item's verification is re-run at each subsequent group gate.
    'src/wiki/records.ts',
    'src/wiki/packmaterials.ts',
    'src/wiki/humanview.ts',
    'src/report/batch.ts',
  ];
  const FORBIDDEN_SUBSTRINGS = [
    'Date.now',
    'new Date',
    'Math.random',
    'process.env',
    'localeCompare',
    'toLocaleString',
    'toLocaleDateString',
    'Intl.',
  ];

  for (const relPath of DETERMINISM_ZONE_FILES) {
    // packmaterials.ts, humanview.ts and report/batch.ts are declared here (item 3) before
    // they exist (items 5, 12, 15); skipped, never silently passed, until each is created —
    // at which point this same assertion applies to it with no further change to this file.
    const exists = existsSync(join(process.cwd(), relPath));
    const runner = exists ? it : it.skip;
    runner(`${relPath} contains no node: import and no forbidden substring`, () => {
      const source = readFileSync(join(process.cwd(), relPath), 'utf8');
      expect(source).not.toMatch(/from ['"]node:/);
      for (const forbidden of FORBIDDEN_SUBSTRINGS) {
        expect(source).not.toContain(forbidden);
      }
    });
  }
});

describe('(f) transitive import audit', () => {
  // (d) only inspects each zone file's own source text, so a forbidden import reachable
  // through an intermediate module — e.g. records.ts -> contracts/testSuiteSpec.ts ->
  // core/clock.js, one hop outside the zone — was invisible to it. Item 1's MUST-NOT list
  // (records.ts, and by the same declaration every other zone file) forbids clock.js,
  // idgen.js, hash.js, log.js, snapshot.js, node:*, pino and anything under src/config/,
  // src/cli/, src/executors/ — not just as a direct import, but as anything reachable at
  // all. This walks the real import graph from each zone file instead of trusting that no
  // intermediate module ever re-exposes one of them.
  const DETERMINISM_ZONE_FILES = [
    'src/state/workitem.ts',
    'src/state/projector.ts',
    'src/supervisor/nextStage.ts',
    'src/supervisor/budget.ts',
    'src/supervisor/blastRadius.ts',
    'src/supervisor/assumptions.ts',
    'src/supervisor/checkpointPolicy.ts',
    'src/supervisor/backlog.ts',
    'src/core/ids.ts',
    'src/core/canonical.ts',
    'src/core/provenance.ts',
    'src/core/events.ts',
    'src/wiki/records.ts',
    'src/wiki/packmaterials.ts',
    'src/wiki/humanview.ts',
    'src/report/batch.ts',
  ];
  const FORBIDDEN_NODE_BUILTIN = /^node:/;
  const FORBIDDEN_BARE_SPECIFIERS = ['pino'];
  const FORBIDDEN_PATH_PATTERNS = [
    /clock\.js$/, /idgen\.js$/, /hash\.js$/, /log\.js$/, /snapshot\.js$/,
    /\/executors\//, /\/cli\//, /\/config\//,
  ];
  // Matches both `import ... from '<spec>'` and `export ... from '<spec>'` (re-exports),
  // type-only or not — a forbidden module reached only via `export type` still widens what
  // is reachable from the zone.
  const IMPORT_SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]/g;

  function importSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    let match: RegExpExecArray | null;
    IMPORT_SPECIFIER_RE.lastIndex = 0;
    while ((match = IMPORT_SPECIFIER_RE.exec(source)) !== null) {
      specifiers.push(match[1] as string);
    }
    return specifiers;
  }

  function isForbidden(specifier: string): boolean {
    return (
      FORBIDDEN_NODE_BUILTIN.test(specifier) ||
      FORBIDDEN_BARE_SPECIFIERS.includes(specifier) ||
      FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(specifier))
    );
  }

  /** Resolves a relative specifier (`./x.js`, `../y.js`) to an on-disk `.ts` source file.
   *  Bare specifiers (npm packages) resolve to `null` and are not walked further. */
  function resolveRelative(fromFile: string, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const withoutExt = specifier.endsWith('.js') ? specifier.slice(0, -'.js'.length) : specifier;
    const resolved = join(dirname(fromFile), `${withoutExt}.ts`);
    return existsSync(resolved) ? resolved : null;
  }

  for (const relPath of DETERMINISM_ZONE_FILES) {
    const entry = join(process.cwd(), relPath);
    const exists = existsSync(entry);
    const runner = exists ? it : it.skip;
    runner(`${relPath}'s transitive import graph reaches no forbidden module`, () => {
      const visited = new Set<string>([entry]);
      const queue: string[] = [entry];
      const violations: string[] = [];

      while (queue.length > 0) {
        const file = queue.shift() as string;
        const source = readFileSync(file, 'utf8');
        for (const specifier of importSpecifiers(source)) {
          if (isForbidden(specifier)) {
            violations.push(`${file} -> ${specifier}`);
            continue;
          }
          const next = resolveRelative(file, specifier);
          if (next !== null && !visited.has(next)) {
            visited.add(next);
            queue.push(next);
          }
        }
      }

      expect(violations).toEqual([]);
    });
  }
});

describe('(e) per-account ledger key order is deterministic', () => {
  it('projecting the fixture twice yields the same budget.accounts key order under canonicalJson', () => {
    const events = buildFixture(40);
    const first = project(events);
    const second = project(events);
    expect(Object.keys(first.budget.accounts)).toEqual(Object.keys(second.budget.accounts));
    expect(canonicalJson(first.budget.accounts)).toBe(canonicalJson(second.budget.accounts));
  });
});
