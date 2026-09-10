import { describe, it, expect } from 'vitest';
import {
  BLAST_RADIUS_TRIGGERS,
  AssumptionsConfigSchema,
  CheckpointsConfigSchema,
} from '../../src/config/schema.js';
import { classifyBlastRadius } from '../../src/supervisor/blastRadius.js';
import type { BlastRadiusPolicy } from '../../src/supervisor/blastRadius.js';
import { gatePolicyAt } from '../../src/supervisor/checkpointPolicy.js';
import type { GatePolicy } from '../../src/supervisor/checkpointPolicy.js';

// `src/supervisor/checkpointPolicy.ts` and `src/supervisor/blastRadius.ts` each mirror shape
// and defaults from `src/config/schema.ts` locally, because the determinism zone forbids them
// importing it (WORK_ORDER_PHASE5.md §5, item 11's and item 13's MUST-NOT lists). This file is
// not in the determinism zone, so it may import both sides and pin them against each other.
// It exists to catch drift, not to remove the mirror: nothing else fails if a trigger is added
// or a default changes in `schema.ts` without the mirrors following.

const MIRROR_DRIFT = (file: string): string =>
  `${file}'s mirrored config schema has drifted from src/config/schema.ts — update the mirror in ${file} to match`;

describe('config mirror: src/supervisor/checkpointPolicy.ts vs. src/config/schema.ts', () => {
  it('parsing {} through the mirror (via gatePolicyAt with no in-force RunStarted) and through the real schemas yields deep-equal defaults', () => {
    const realCheckpoints = CheckpointsConfigSchema.parse({});
    const realAssumptions = AssumptionsConfigSchema.parse({});
    const expected: GatePolicy = {
      owner: realCheckpoints.defaultOwner,
      reversible: realCheckpoints.reversible,
      irreversible: realCheckpoints.irreversible,
      blastRadius: realCheckpoints.blastRadius,
      maxStackDepth: realAssumptions.maxStackDepth,
    };
    const mirrored = gatePolicyAt([], 0);
    expect(mirrored, MIRROR_DRIFT('src/supervisor/checkpointPolicy.ts')).toEqual(expected);
  });

  it('the mirrored blast-radius severity defaults match the real schema', () => {
    const realSeverity = CheckpointsConfigSchema.parse({}).blastRadius.severity;
    const mirroredSeverity = gatePolicyAt([], 0).blastRadius.severity;
    expect(mirroredSeverity, MIRROR_DRIFT('src/supervisor/checkpointPolicy.ts')).toEqual(realSeverity);
  });

  it('the mirrored severity object declares triggers in the same vocabulary and order as BLAST_RADIUS_TRIGGERS', () => {
    const mirroredSeverity = gatePolicyAt([], 0).blastRadius.severity;
    expect(
      Object.keys(mirroredSeverity),
      MIRROR_DRIFT('src/supervisor/checkpointPolicy.ts'),
    ).toEqual([...BLAST_RADIUS_TRIGGERS]);
  });
});

describe('config mirror: src/supervisor/blastRadius.ts vs. src/config/schema.ts', () => {
  it('the mirrored trigger vocabulary is identical and identically ordered to BLAST_RADIUS_TRIGGERS', () => {
    // Every trigger fires: `fired` is built in the mirror's local trigger-table order
    // (`BLAST_RADIUS_TRIGGERS` as declared in blastRadius.ts, which is not exported), so
    // reading it back off a verdict that fires every trigger is the only way to observe that
    // order from outside the module without loosening its MUST-NOT-import-config-module rule.
    const paths = ['migrations/001.sql', 'src/auth/login.ts', 'openapi.yaml', 'src/index.ts', 'package.json'];
    const policy: BlastRadiusPolicy = {
      migrationOrSchemaPaths: ['migrations/**'],
      sensitivePaths: ['src/auth/**'],
      externalContractPaths: ['openapi.yaml'],
      protectedPaths: ['src/index.ts'],
      dependencyManifestPaths: ['package.json'],
      maxDiffLines: 0,
      maxFilesTouched: 0,
      severity: {
        'migration-or-schema': 'blocking',
        'sensitive-surface': 'blocking',
        'external-contract': 'blocking',
        'protected-surface': 'blocking',
        'dependency-manifest': 'blocking',
        'diff-size': 'advisory',
      },
    };
    const verdict = classifyBlastRadius(
      { paths, untracked: [], insertions: 1, deletions: 0 },
      policy,
    );
    expect(
      verdict.fired.map((f) => f.trigger),
      MIRROR_DRIFT('src/supervisor/blastRadius.ts'),
    ).toEqual([...BLAST_RADIUS_TRIGGERS]);
  });
});
