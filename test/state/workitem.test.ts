import { describe, it, expect } from 'vitest';
import { ROLES, STAGES } from '../../src/core/events.js';
import {
  emptyQuotaAborts,
  roleForStage,
  stageForRole,
  WorkItemStateSchema,
} from '../../src/state/workitem.js';
import type { WorkItemState } from '../../src/state/workitem.js';

const SUPERVISOR_ONLY_STAGES = ['intake', 'integration', 'done'];

describe('roleForStage', () => {
  it('is total over STAGES and returns null for exactly intake/integration/done', () => {
    for (const stage of STAGES) {
      const role = roleForStage(stage);
      if (SUPERVISOR_ONLY_STAGES.includes(stage)) {
        expect(role).toBeNull();
      } else {
        expect(role).not.toBeNull();
      }
    }
  });
});

describe('stageForRole', () => {
  it('round-trips for all six roles', () => {
    for (const role of ROLES) {
      const stage = stageForRole(role);
      expect(roleForStage(stage)).toBe(role);
    }
  });
});

describe('emptyQuotaAborts', () => {
  it('has all nine Stage keys at 0', () => {
    const aborts = emptyQuotaAborts();
    expect(Object.keys(aborts).sort()).toEqual([...STAGES].sort());
    for (const stage of STAGES) {
      expect(aborts[stage]).toBe(0);
    }
  });
});

function buildFullState(): WorkItemState {
  return {
    projectionVersion: 4,
    itemId: 'wi-example-abc123' as WorkItemState['itemId'],
    slug: 'example' as WorkItemState['slug'],
    seq: 1,
    lastEventId: null,
    createdAt: '2024-01-01T00:00:00.000Z' as WorkItemState['createdAt'],
    updatedAt: '2024-01-01T00:00:00.000Z' as WorkItemState['updatedAt'],
    title: 'Example item',
    source: { kind: 'prd-file', path: 'prd.md', sha256: 'a'.repeat(64), bytes: 10 },
    configHash: 'deadbeef',
    status: 'active',
    stage: 'intake',
    stageEnteredAt: null,
    attempts: {
      intake: 0,
      analysis: 0,
      architecture: 0,
      planning: 0,
      'test-authoring': 0,
      implementation: 0,
      review: 0,
      integration: 0,
      done: 0,
    },
    failures: [],
    park: null,
    budget: {
      accounts: {
        ['claude-personal' as never]: {
          consumed: { wallSeconds: 1, turns: 1, usd: null, partial: { turns: false, usd: true } },
          exhausted: null,
        },
      },
      item: { wallSeconds: 1, turns: 1, usd: null, partial: { turns: false, usd: true } },
      itemExhausted: null,
    },
    quotaAborts: emptyQuotaAborts(),
    worktreeLock: null,
    frozenTests: null,
    validationFailures: [],
    itemArtifacts: [],
    workspace: null,
    lastExecutor: null,
    lastDiff: null,
    artifacts: { requirementSet: null, architecturePlan: null, taskGraph: null, testSuiteSpec: null },
    taskGraphTaskIds: null,
    taskGraphDependencies: null,
    tasks: null,
    activeCauseId: null,
    causes: {},
    invalidatedEventIds: [],
    oracleSweeps: {},
    workspaceCheckpoints: {},
    integration: { status: 'pending', sweepId: null, finalPatch: null },
    checkpoints: {},
    assumptions: [],
    drift: [],
    tampering: [],
    runs: [],
  };
}

describe('WorkItemStateSchema', () => {
  it('parses a full v3 state', () => {
    const state = buildFullState();
    expect(WorkItemStateSchema.parse(state)).toEqual(state);
  });

  it('rejects a v1-shaped budget: {consumed, exhausted}', () => {
    const state = buildFullState() as unknown as Record<string, unknown>;
    state['budget'] = {
      consumed: { wallSeconds: 0, turns: 0, usd: 0, partial: { turns: false, usd: false } },
      exhausted: null,
    };
    expect(WorkItemStateSchema.safeParse(state).success).toBe(false);
  });
});
