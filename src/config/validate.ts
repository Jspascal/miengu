import { ConfigError } from '../errors.js';
import type { ExecutorType } from '../core/events.js';
import type { MienguConfig } from './schema.js';

export interface ValidatedConfig {
  readonly config: MienguConfig;
}

export const CLAUDE_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Rank of `effort` on `type`'s own documented ordering, or `null` when `effort` is `null`. */
export function effortRank(type: ExecutorType, effort: string | null): number | null {
  if (effort === null) {
    return null;
  }
  const order: readonly string[] =
    type === 'claude-code' ? CLAUDE_EFFORT_ORDER : type === 'codex' ? CODEX_EFFORT_ORDER : [];
  const index = order.indexOf(effort);
  return index === -1 ? null : index;
}

/**
 * Throws `ConfigError` (exit 3) listing EVERY violation, one per line. Never warns.
 * Implements checks V1–V9 of §3.12.
 */
export function validateConfig(c: MienguConfig): void {
  const violations: string[] = [];

  const executorNames = Object.keys(c.executors);
  const accountNames = new Set(Object.keys(c.accounts));
  const roleNames = Object.keys(c.roles) as ReadonlyArray<keyof typeof c.roles>;
  const tierNames = new Set(Object.keys(c.tiers));
  const referencedAccounts = new Set<string>();

  // V1 — every executors.*.account is a key of accounts.
  for (const [name, instance] of Object.entries(c.executors)) {
    if (instance === undefined) {
      continue;
    }
    referencedAccounts.add(instance.account);
    if (!accountNames.has(instance.account)) {
      violations.push(
        `executor "${name}" names account "${instance.account}", which is not declared under accounts:`,
      );
    }
  }

  // V2 — every roles.*.executor is a key of executors.
  const executorNameSet = new Set(executorNames);
  for (const roleName of roleNames) {
    const role = c.roles[roleName];
    if (!executorNameSet.has(role.executor)) {
      violations.push(
        `role "${roleName}" names executor "${role.executor}", which is not declared under executors:`,
      );
    }
  }

  // V3 — tiers has an entry for every declared executor instance.
  for (const name of executorNames) {
    if (!tierNames.has(name)) {
      violations.push(`executor "${name}" has no entry in tiers:`);
    }
  }

  // V4 — tiers has no key that is not a declared instance.
  for (const name of tierNames) {
    if (!executorNameSet.has(name)) {
      violations.push(`tiers declares "${name}", which is not a declared executor instance`);
    }
  }

  // V5 — reviewer tier >= coder tier.
  const reviewerRole = c.roles.reviewer;
  const coderRole = c.roles.coder;
  const reviewerInstance = c.executors[reviewerRole.executor];
  const coderInstance = c.executors[coderRole.executor];
  const reviewerTier = c.tiers[reviewerRole.executor];
  const coderTier = c.tiers[coderRole.executor];

  if (reviewerTier !== undefined && coderTier !== undefined) {
    if (!(reviewerTier >= coderTier)) {
      violations.push(
        'reviewer model must be >= coder model — a weaker reviewer cannot refute a stronger coder',
      );
    } else if (
      reviewerTier === coderTier &&
      reviewerInstance !== undefined &&
      coderInstance !== undefined &&
      reviewerInstance.type === coderInstance.type
    ) {
      // V6 — same tier, same provider: effort must also rank >=.
      const reviewerEffortRank = effortRank(reviewerInstance.type, reviewerInstance.effort);
      const coderEffortRank = effortRank(coderInstance.type, coderInstance.effort);
      if (
        reviewerEffortRank !== null &&
        coderEffortRank !== null &&
        !(reviewerEffortRank >= coderEffortRank)
      ) {
        violations.push(
          `reviewer effort "${String(reviewerInstance.effort)}" is below coder effort ` +
            `"${String(coderInstance.effort)}" on the same provider at the same tier`,
        );
      }
    }
  }

  // V7 — executors.*.effort is a member of that type's order (or null).
  for (const [name, instance] of Object.entries(c.executors)) {
    if (instance === undefined) {
      continue;
    }
    if (instance.effort === null) {
      continue;
    }
    if (instance.type === 'stub') {
      continue;
    }
    const order: readonly string[] =
      instance.type === 'claude-code' ? CLAUDE_EFFORT_ORDER : CODEX_EFFORT_ORDER;
    if (!order.includes(instance.effort)) {
      violations.push(
        `executor "${name}" declares effort "${instance.effort}", which ${instance.type} does not accept (${order.join(', ')})`,
      );
    }
  }

  // V8 — type: 'stub' instances declare no model/effort.
  for (const [name, instance] of Object.entries(c.executors)) {
    if (instance === undefined) {
      continue;
    }
    if (instance.type === 'stub' && (instance.model !== null || instance.effort !== null)) {
      violations.push(`executor "${name}" is type stub and must not declare model or effort`);
    }
  }

  // V9 — every accounts key is referenced by >=1 executor instance.
  for (const name of accountNames) {
    if (!referencedAccounts.has(name)) {
      violations.push(`account "${name}" is not referenced by any executor`);
    }
  }

  // V10 — an irreversible checkpoint carries neither an SLA nor a default (§8: no timeout, no default).
  if (c.checkpoints.irreversible.slaSeconds !== null || c.checkpoints.irreversible.default !== null) {
    violations.push(
      'an irreversible checkpoint must declare neither an SLA nor a default decision (§8: no timeout, no default)',
    );
  }

  // V11 — every blast-radius pattern is a well-formed glob: non-empty, no leading `/`, no `\`,
  // no empty segment.
  const BLAST_RADIUS_PATTERN_LISTS: ReadonlyArray<[string, readonly string[]]> = [
    ['migrationOrSchemaPaths', c.checkpoints.blastRadius.migrationOrSchemaPaths],
    ['sensitivePaths', c.checkpoints.blastRadius.sensitivePaths],
    ['externalContractPaths', c.checkpoints.blastRadius.externalContractPaths],
    ['protectedPaths', c.checkpoints.blastRadius.protectedPaths],
    ['dependencyManifestPaths', c.checkpoints.blastRadius.dependencyManifestPaths],
  ];
  for (const [listName, patterns] of BLAST_RADIUS_PATTERN_LISTS) {
    for (const pattern of patterns) {
      const malformed =
        pattern.length === 0 ||
        pattern.startsWith('/') ||
        pattern.includes('\\') ||
        pattern.includes('//');
      if (malformed) {
        violations.push(
          `checkpoints.blastRadius.${listName} declares a malformed pattern: ${JSON.stringify(pattern)}`,
        );
      }
    }
  }

  // V12 — a checkpoint class declares an SLA and a default together, or neither.
  if (
    (c.checkpoints.reversible.slaSeconds === null) !== (c.checkpoints.reversible.default === null)
  ) {
    violations.push('a checkpoint class must declare an SLA and a default together, or neither');
  }

  // V13 — bounded excerpt and scope limits must remain subsets of their collection caps.
  if (c.brownfield.maxTestExcerptBytes > c.brownfield.maxFileBytes) {
    violations.push(
      'brownfield.maxTestExcerptBytes must be <= brownfield.maxFileBytes',
    );
  }
  if (c.brownfield.maxFilesPerScope > c.brownfield.maxTreeEntries) {
    violations.push(
      'brownfield.maxFilesPerScope must be <= brownfield.maxTreeEntries',
    );
  }

  // V14 — process predicates use the fixed wrapper protocol and never resolve executables via PATH.
  const { commands, sandbox } = c.brownfield.falsification;
  if (sandbox !== null) {
    if (!sandbox.bin.startsWith('/')) {
      violations.push('brownfield.falsification.sandbox.bin must be an absolute path');
    }
    for (const argument of sandbox.argvPrefix) {
      if (argument.includes('\0')) {
        violations.push('brownfield.falsification.sandbox.argvPrefix members must not contain NUL');
      }
    }
  }
  for (const [name, command] of Object.entries(commands)) {
    const executable = command.argv[0];
    if (executable !== undefined && !executable.startsWith('/')) {
      violations.push(
        `brownfield.falsification.commands.${JSON.stringify(name)}.argv[0] must be an absolute path`,
      );
    }
    for (const argument of command.argv) {
      if (argument.includes('\0')) {
        violations.push(
          `brownfield.falsification.commands.${JSON.stringify(name)}.argv members must not contain NUL`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new ConfigError(violations.join('\n'), { violations });
  }
}
