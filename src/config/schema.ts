import { z } from 'zod';
import { TARGET_MODES, EXECUTOR_TYPES } from '../core/events.js';
import { AccountIdSchema, ExecutorInstanceIdSchema, RE_SLUG } from '../core/ids.js';

export const CONFIG_FILENAME = 'miengu.config.yaml';

export const TargetConfigSchema = z
  .object({
    repo: z.string(),
    mode: z.enum(TARGET_MODES).default('worktree'),
    baseRef: z.string().default('HEAD'),
  })
  .strict();

export const OraclesConfigSchema = z
  .object({
    build: z.string().nullable().default(null),
    test: z.string().nullable().default(null),
    lint: z.string().nullable().default(null),
    typecheck: z.string().nullable().default(null),
  })
  .strict();

// 1. Quota pools. Every executor instance must name one of these keys (§17.2).
export const AccountLimitsSchema = z
  .object({
    maxTurnsPerItem: z.number().int().positive().nullable().default(null),
    maxWallSecondsPerItem: z.number().int().positive().nullable().default(null),
    maxUsdPerItem: z.number().positive().nullable().default(null),
  })
  .strict();

export const AccountsConfigSchema = z
  .record(AccountIdSchema, AccountLimitsSchema)
  .refine((accounts) => Object.keys(accounts).length > 0, {
    message: 'accounts must declare at least one account',
  });

// 2. Named executor instances. Model + effort live here: they are provider terms.
export const ExecutorInstanceSchema = z
  .object({
    type: z.enum(EXECUTOR_TYPES),
    model: z.string().nullable().default(null),
    effort: z.string().nullable().default(null),
    account: AccountIdSchema,
    bin: z.string().nullable().default(null),
    permissionMode: z
      .enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
      .nullable()
      .default(null),
    addDirs: z.array(z.string()).default([]),
    maxBudgetUsd: z.number().positive().nullable().default(null),
    extraConfig: z.array(z.string()).default([]),
  })
  .strict();

export const ExecutorsConfigSchema = z.record(ExecutorInstanceIdSchema, ExecutorInstanceSchema);

// 3. Declared cross-vendor ranking. Explicit, because no honest inferred rank exists.
export const TiersSchema = z.record(ExecutorInstanceIdSchema, z.number().int().positive());

// 4. Roles reference an instance by name. Turns + context live here: role terms.
export const RoleConfigSchema = z
  .object({
    executor: ExecutorInstanceIdSchema,
    maxTurns: z.number().int().positive(),
    contextBudgetTokens: z.number().int().positive(),
  })
  .strict();

export const RolesConfigSchema = z
  .object({
    analyst: RoleConfigSchema,
    architect: RoleConfigSchema,
    planner: RoleConfigSchema,
    testAuthor: RoleConfigSchema,
    coder: RoleConfigSchema,
    reviewer: RoleConfigSchema,
  })
  .strict();

export const BudgetConfigSchema = z
  .object({
    maxWallSecondsPerInvocation: z.number().int().positive().default(1800),
    maxUsdPerRun: z.number().positive().nullable().default(null),
  })
  .strict();

export const LimitsConfigSchema = z
  .object({
    kOracle: z.number().int().positive().default(3),
    kTest: z.number().int().positive().default(3),
    kReview: z.number().int().positive().default(2),
    maxAttemptsPerStage: z.number().int().positive().default(3),
  })
  .strict();

export const PlannerConfigSchema = z
  .object({
    maxPathsPerTask: z.number().int().positive().default(8),
  })
  .strict();

export const WikiConfigSchema = z
  .object({
    language: z.enum(['fr', 'en']).default('en'),
  })
  .strict();

export const StoreConfigSchema = z
  .object({
    dir: z.string().default('.miengu'),
    snapshotEvery: z.number().int().positive().default(200),
  })
  .strict();

export const LogConfigSchema = z
  .object({
    level: z.string().default('info'),
  })
  .strict();

export const BLAST_RADIUS_TRIGGERS = [
  'migration-or-schema',
  'sensitive-surface',
  'external-contract',
  'protected-surface',
  'dependency-manifest',
  'diff-size',
] as const;
export type BlastRadiusTrigger = (typeof BLAST_RADIUS_TRIGGERS)[number];

export const TRIGGER_SEVERITIES = ['blocking', 'advisory', 'off'] as const;
export type TriggerSeverity = (typeof TRIGGER_SEVERITIES)[number];

export const TriggerSeveritySchema = z
  .object({
    'migration-or-schema': z.enum(TRIGGER_SEVERITIES).default('blocking'),
    'sensitive-surface':   z.enum(TRIGGER_SEVERITIES).default('blocking'),
    'external-contract':   z.enum(TRIGGER_SEVERITIES).default('blocking'),
    'protected-surface':   z.enum(TRIGGER_SEVERITIES).default('blocking'),
    'dependency-manifest': z.enum(TRIGGER_SEVERITIES).default('blocking'),
    'diff-size':           z.enum(TRIGGER_SEVERITIES).default('advisory'),
  })
  .strict();

export const BlastRadiusConfigSchema = z
  .object({
    migrationOrSchemaPaths:  z.array(z.string().min(1)).default([]),
    sensitivePaths:          z.array(z.string().min(1)).default([]),
    externalContractPaths:   z.array(z.string().min(1)).default([]),
    protectedPaths:          z.array(z.string().min(1)).default([]),
    dependencyManifestPaths: z.array(z.string().min(1)).default([]),
    maxDiffLines:            z.number().int().positive().default(400),
    maxFilesTouched:         z.number().int().positive().default(20),
    severity:                TriggerSeveritySchema.default({}),
  })
  .strict();

/** `default` is `'accept' | null` and never `'reject'` — binding decision 7. */
function checkpointClassSchema(slaSeconds: number | null, decision: 'accept' | null) {
  return z
    .object({
      slaSeconds: z.number().int().positive().nullable().default(slaSeconds),
      default: z.literal('accept').nullable().default(decision),
    })
    .strict();
}

export const ReversibleCheckpointSchema = checkpointClassSchema(86400, 'accept');
export const IrreversibleCheckpointSchema = checkpointClassSchema(null, null);

export const CheckpointsConfigSchema = z
  .object({
    /** An operator-declared label, lowercase-hyphen, <= 48 chars — the same shape as an
     *  AccountId. miengu has no identity model and does not invent one. */
    defaultOwner: z.string().regex(RE_SLUG).max(48).default('operator'),
    reversible:   ReversibleCheckpointSchema.default({}),
    irreversible: IrreversibleCheckpointSchema.default({}),
    blastRadius:  BlastRadiusConfigSchema.default({}),
  })
  .strict();

export const AssumptionsConfigSchema = z
  .object({
    maxStackDepth: z.number().int().positive().default(2),
  })
  .strict();

export const BrownfieldCommandSchema = z
  .object({
    argv: z.array(z.string()).min(1),
  })
  .strict();

export const BrownfieldSandboxSchema = z
  .object({
    bin: z.string(),
    argvPrefix: z.array(z.string()),
  })
  .strict();

export const BrownfieldFalsificationConfigSchema = z
  .object({
    maxPredicatesPerScope: z.number().int().positive().default(8),
    maxWallSeconds: z.number().int().positive().default(30),
    maxOutputBytes: z.number().int().positive().default(65536),
    commands: z.record(BrownfieldCommandSchema).default({}),
    sandbox: BrownfieldSandboxSchema.nullable().default(null),
  })
  .strict();

export const BrownfieldConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxTreeEntries: z.number().int().positive().default(5000),
    maxFilesPerScope: z.number().int().positive().default(200),
    maxDependencyDepth: z.number().int().nonnegative().default(2),
    maxFileBytes: z.number().int().positive().default(262144),
    maxTestExcerptBytes: z.number().int().positive().default(8192),
    maxGitCommits: z.number().int().positive().default(200),
    maxFilesPerCommit: z.number().int().positive().default(50),
    falsification: BrownfieldFalsificationConfigSchema.default({}),
  })
  .strict();

export const MienguConfigSchema = z
  .object({
    target: TargetConfigSchema,
    oracles: OraclesConfigSchema.default({}),
    accounts: AccountsConfigSchema,
    executors: ExecutorsConfigSchema,
    tiers: TiersSchema,
    roles: RolesConfigSchema,
    budget: BudgetConfigSchema.default({}),
    limits: LimitsConfigSchema.default({}),
    planner: PlannerConfigSchema.default({}),
    assumptions: AssumptionsConfigSchema.default({}),
    brownfield: BrownfieldConfigSchema.default({}),
    checkpoints: CheckpointsConfigSchema.default({}),
    wiki: WikiConfigSchema.default({}),
    locale: z.enum(['fr', 'en']).default('fr'),
    store: StoreConfigSchema.default({}),
    log: LogConfigSchema.default({}),
  })
  .strict();

export type MienguConfig = z.infer<typeof MienguConfigSchema>;
