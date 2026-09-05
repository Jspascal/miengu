import { z } from 'zod';
import { TARGET_MODES, EXECUTOR_TYPES } from '../core/events.js';
import { AccountIdSchema, ExecutorInstanceIdSchema } from '../core/ids.js';

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
    wiki: WikiConfigSchema.default({}),
    locale: z.enum(['fr', 'en']).default('fr'),
    store: StoreConfigSchema.default({}),
    log: LogConfigSchema.default({}),
  })
  .strict();

export type MienguConfig = z.infer<typeof MienguConfigSchema>;
