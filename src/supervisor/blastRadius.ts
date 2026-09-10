import type { EventOf } from '../core/events.js';

// Mirrors src/config/schema.ts's BLAST_RADIUS_TRIGGERS / TriggerSeverity exactly (same
// values, same order) without importing that module, which the determinism zone forbids for
// this file even for a type — WORK_ORDER_PHASE5.md item 11's MUST-NOT list. Byte-identical to
// the canonical list; `test/supervisor/blastRadius.test.ts` proves it stays that way.
const BLAST_RADIUS_TRIGGERS = [
  'migration-or-schema',
  'sensitive-surface',
  'external-contract',
  'protected-surface',
  'dependency-manifest',
  'diff-size',
] as const;
export type BlastRadiusTrigger = (typeof BLAST_RADIUS_TRIGGERS)[number];
export type TriggerSeverity = 'blocking' | 'advisory' | 'off';

/** Paths and integers only. There is deliberately no string field carrying prose, a summary,
 *  a confidence, or any agent-authored value: binding decision 5's guarantee is structural. */
export interface BlastRadiusInput {
  /** `files_touched ∪ untracked`, deduplicated, ascending under the default comparator. */
  readonly paths: readonly string[];
  /** `untracked`, ascending. Used only to exclude new files from `protected-surface`. */
  readonly untracked: readonly string[];
  readonly insertions: number;
  readonly deletions: number;
}

export interface BlastRadiusPolicy {
  readonly migrationOrSchemaPaths: readonly string[];
  readonly sensitivePaths: readonly string[];
  readonly externalContractPaths: readonly string[];
  readonly protectedPaths: readonly string[];
  readonly dependencyManifestPaths: readonly string[];
  readonly maxDiffLines: number;
  readonly maxFilesTouched: number;
  readonly severity: Readonly<Record<BlastRadiusTrigger, TriggerSeverity>>;
}

export interface FiredTrigger {
  readonly trigger: BlastRadiusTrigger;
  readonly severity: 'blocking' | 'advisory';
  /** The matching paths, ascending. Empty for `diff-size`. Never prose. */
  readonly paths: readonly string[];
}

export interface BlastRadiusVerdict {
  /** In `BLAST_RADIUS_TRIGGERS` order. `off` triggers never appear. */
  readonly fired: readonly FiredTrigger[];
  /** True iff some fired trigger has severity `blocking`. */
  readonly blocking: boolean;
}

/** Matches one path segment against one pattern segment: `*` matches zero or more characters
 *  other than `/` (there is no `/` within a segment by construction), every other character
 *  matches itself literally. A pure segment-wise dynamic-programming match; no backtracking,
 *  no `RegExp`. */
function matchesSegment(pattern: string, segment: string): boolean {
  const dp: boolean[][] = Array.from({ length: pattern.length + 1 }, () =>
    new Array<boolean>(segment.length + 1).fill(false),
  );
  const dpRow0 = dp[0];
  if (dpRow0 === undefined) return false;
  dpRow0[0] = true;
  for (let i = 1; i <= pattern.length; i += 1) {
    if (pattern[i - 1] === '*') {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (row !== undefined && prevRow !== undefined) {
        row[0] = prevRow[0] ?? false;
      }
    }
  }
  for (let i = 1; i <= pattern.length; i += 1) {
    for (let j = 1; j <= segment.length; j += 1) {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (row === undefined || prevRow === undefined) continue;
      if (pattern[i - 1] === '*') {
        row[j] = (prevRow[j] ?? false) || (row[j - 1] ?? false);
      } else {
        row[j] = (prevRow[j - 1] ?? false) && pattern[i - 1] === segment[j - 1];
      }
    }
  }
  return dp[pattern.length]?.[segment.length] ?? false;
}

/** Total. Never throws, never builds a RegExp, never reads the filesystem. */
export function matchesGlob(path: string, pattern: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const m = patternSegments.length;
  const n = pathSegments.length;
  const dp: boolean[][] = Array.from({ length: m + 1 }, () => new Array<boolean>(n + 1).fill(false));
  const dpRow0 = dp[0];
  if (dpRow0 === undefined) return false;
  dpRow0[0] = true;
  for (let i = 1; i <= m; i += 1) {
    if (patternSegments[i - 1] === '**') {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (row !== undefined && prevRow !== undefined) {
        row[0] = prevRow[0] ?? false;
      }
    }
  }
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const row = dp[i];
      const prevRow = dp[i - 1];
      if (row === undefined || prevRow === undefined) continue;
      const patternSegment = patternSegments[i - 1] as string;
      if (patternSegment === '**') {
        row[j] = (prevRow[j] ?? false) || (row[j - 1] ?? false);
      } else {
        row[j] = (prevRow[j - 1] ?? false) && matchesSegment(patternSegment, pathSegments[j - 1] as string);
      }
    }
  }
  return dp[m]?.[n] ?? false;
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern));
}

function matchingPaths(paths: readonly string[], patterns: readonly string[]): readonly string[] {
  return paths.filter((path) => matchesAny(path, patterns));
}

/** `classifyBlastRadius` evaluates triggers in `BLAST_RADIUS_TRIGGERS` order, skips `off`,
 *  and reads only paths and integers — never `Implementation.files_touched`, never a
 *  `summary`, never an agent-reported value or the filesystem. */
export function classifyBlastRadius(i: BlastRadiusInput, p: BlastRadiusPolicy): BlastRadiusVerdict {
  const untrackedSet = new Set(i.untracked);
  const tracked = i.paths.filter((path) => !untrackedSet.has(path));

  const fired: FiredTrigger[] = [];
  for (const trigger of BLAST_RADIUS_TRIGGERS) {
    const severity = p.severity[trigger];
    if (severity === 'off') continue;

    let matched: readonly string[];
    let hit: boolean;
    switch (trigger) {
      case 'migration-or-schema':
        matched = matchingPaths(i.paths, p.migrationOrSchemaPaths);
        hit = matched.length > 0;
        break;
      case 'sensitive-surface':
        matched = matchingPaths(i.paths, p.sensitivePaths);
        hit = matched.length > 0;
        break;
      case 'external-contract':
        matched = matchingPaths(i.paths, p.externalContractPaths);
        hit = matched.length > 0;
        break;
      case 'protected-surface':
        matched = matchingPaths(tracked, p.protectedPaths);
        hit = matched.length > 0;
        break;
      case 'dependency-manifest':
        matched = matchingPaths(i.paths, p.dependencyManifestPaths);
        hit = matched.length > 0;
        break;
      case 'diff-size':
        matched = [];
        hit = i.insertions + i.deletions > p.maxDiffLines || i.paths.length > p.maxFilesTouched;
        break;
    }

    if (hit) {
      fired.push({ trigger, severity, paths: matched });
    }
  }

  return {
    fired,
    blocking: fired.some((f) => f.severity === 'blocking'),
  };
}

/** `blastRadiusInput(diff)` from a `DiffCaptured` event's data. The only adapter. */
export function blastRadiusInput(d: EventOf<'DiffCaptured'>['data']): BlastRadiusInput {
  return {
    paths: Array.from(new Set([...d.files_touched, ...d.untracked])).sort(),
    untracked: [...d.untracked].sort(),
    insertions: d.insertions,
    deletions: d.deletions,
  };
}
