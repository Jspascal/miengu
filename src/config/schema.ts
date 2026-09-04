import { z } from 'zod';
import { TARGET_MODES } from '../core/events.js';

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

const ClaudeCodeConfigSchema = z
  .object({
    bin: z.string().default('claude'),
    model: z.string().nullable().default(null),
    permissionMode: z
      .enum(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'])
      .default('acceptEdits'),
    outputFormat: z.enum(['json', 'stream-json']).default('stream-json'),
    addDirs: z.array(z.string()).default([]),
    maxBudgetUsd: z.number().positive().nullable().default(null),
  })
  .strict();

export const ExecutorConfigSchema = z
  .object({
    id: z.enum(['claude-code', 'stub']).default('stub'),
    claudeCode: ClaudeCodeConfigSchema.default({}),
  })
  .strict();

export const BudgetConfigSchema = z
  .object({
    maxTurnsPerTask: z.number().int().positive().default(40),
    maxWallSecondsPerTask: z.number().int().positive().default(1800),
    maxUsdPerRun: z.number().positive().nullable().default(null),
    maxWallSecondsPerRun: z.number().int().positive().nullable().default(null),
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
    executor: ExecutorConfigSchema.default({}),
    budget: BudgetConfigSchema.default({}),
    limits: LimitsConfigSchema.default({}),
    wiki: WikiConfigSchema.default({}),
    locale: z.enum(['fr', 'en']).default('fr'),
    store: StoreConfigSchema.default({}),
    log: LogConfigSchema.default({}),
  })
  .strict();

export type MienguConfig = z.infer<typeof MienguConfigSchema>;
