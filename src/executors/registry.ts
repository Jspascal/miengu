import type { Clock } from '../core/clock.js';
import { assertNever } from '../core/events.js';
import type { Role, SandboxIntent } from '../core/events.js';
import type { IdMinter } from '../core/idgen.js';
import type { ExecutorInstanceId } from '../core/ids.js';
import type { AccountId } from '../core/ids.js';
import type { Logger } from '../logging.js';
import type { MienguConfig } from '../config/schema.js';
import { ConfigError } from '../errors.js';
import {
  ClaudeCodeExecutor,
  DEFAULT_SIGTERM_GRACE_SECONDS as CLAUDE_DEFAULT_SIGTERM_GRACE_SECONDS,
} from './claudeCode.js';
import {
  CodexCliExecutor,
  DEFAULT_SIGTERM_GRACE_SECONDS as CODEX_DEFAULT_SIGTERM_GRACE_SECONDS,
} from './codexCli.js';
import { StubExecutor } from './stub.js';
import { assertSandboxSupported } from './executor.js';
import type { Executor, RawRunSource } from './executor.js';
import { expandExecutorEnv } from './processConfig.js';

/** analyst/architect/planner/reviewer -> 'read-only'; testAuthor/coder -> 'workspace-write'. */
export const ROLE_SANDBOX_INTENT: Readonly<Record<Role, SandboxIntent>> = {
  analyst: 'read-only',
  architect: 'read-only',
  planner: 'read-only',
  testAuthor: 'workspace-write',
  coder: 'workspace-write',
  reviewer: 'read-only',
};

const ROLES: readonly Role[] = [
  'analyst',
  'architect',
  'planner',
  'testAuthor',
  'coder',
  'reviewer',
];

export interface ResolvedRoleSettings {
  readonly model: string | null;
  readonly effort: string | null;
  readonly maxTurns: number;
  readonly contextBudgetTokens: number;
}

export interface ExecutorHandle {
  readonly role: Role;
  readonly executor: Executor & Partial<RawRunSource>;
  readonly sandboxIntent: SandboxIntent;
  readonly resolved: ResolvedRoleSettings;
}

export interface ExecutorRegistry {
  forRole(role: Role): ExecutorHandle;
  accountForRole(role: Role): AccountId;
  readonly handles: readonly ExecutorHandle[];
}

type ExecutorInstanceConfig = NonNullable<MienguConfig['executors'][ExecutorInstanceId]>;

function buildAdapter(
  instanceId: ExecutorInstanceId,
  instance: ExecutorInstanceConfig,
  sandboxIntent: SandboxIntent,
  o: {
    paths: { transcriptsDir: string; messagesDir: string };
    clock: Clock;
    ids: IdMinter;
    logger: Logger;
  },
): Executor & Partial<RawRunSource> {
  switch (instance.type) {
    case 'stub':
      return new StubExecutor({
        id: instanceId,
        account: instance.account,
        sandboxIntent,
        clock: o.clock,
        ids: o.ids,
      });
    case 'claude-code':
      return new ClaudeCodeExecutor({
        id: instanceId,
        account: instance.account,
        bin: instance.bin ?? 'claude',
        argvPrefix: instance.args,
        env: expandExecutorEnv(instance.env),
        model: instance.model,
        effort: instance.effort,
        sandboxIntent,
        permissionModeOverride: instance.permissionMode,
        // MUST be 'stream-json'. docs/002-executor-findings.md (S2/S3) verified that
        // `rate_limit_event` — the machine-readable quota signal, carrying `status`,
        // `utilization` and `resetsAt` — is only emitted under
        // `--output-format stream-json --verbose`. Under 'json' stdout is one pretty-printed
        // object, no line parses as an event, `selectRateLimitInfo` always returns null, and
        // quota detection silently falls back to the text regexes the findings doc demoted to
        // last resort. Deliberately NOT config-surfaced: an operator has no reason to want
        // quota detection off, and this is the only value that keeps §17.3 working.
        outputFormat: 'stream-json',
        addDirs: instance.addDirs,
        maxBudgetUsd: instance.maxBudgetUsd,
        sigtermGraceSeconds: CLAUDE_DEFAULT_SIGTERM_GRACE_SECONDS,
        transcriptDir: o.paths.transcriptsDir,
        clock: o.clock,
        ids: o.ids,
        logger: o.logger,
      });
    case 'codex':
      return new CodexCliExecutor({
        id: instanceId,
        account: instance.account,
        bin: instance.bin ?? 'codex',
        argvPrefix: instance.args,
        env: expandExecutorEnv(instance.env),
        model: instance.model,
        reasoningEffort: instance.effort,
        sandboxIntent,
        extraConfig: instance.extraConfig,
        addDirs: instance.addDirs,
        sigtermGraceSeconds: CODEX_DEFAULT_SIGTERM_GRACE_SECONDS,
        transcriptDir: o.paths.transcriptsDir,
        clock: o.clock,
        ids: o.ids,
        logger: o.logger,
      });
    default:
      return assertNever(instance.type);
  }
}

/**
 * Constructs all six role adapters eagerly, per role (§17.5, binding decision 15), and calls
 * `assertSandboxSupported` for each before returning. A provider that cannot express its
 * role's sandbox intent throws `ConfigError` (exit 3) before the first `StageEntered` — a
 * misconfigured sandbox discovered mid-run means an agent has already written somewhere it
 * should not have.
 */
export function buildExecutorRegistry(o: {
  config: MienguConfig;
  paths: { transcriptsDir: string; messagesDir: string };
  clock: Clock;
  ids: IdMinter;
  logger: Logger;
}): ExecutorRegistry {
  const handles = new Map<Role, ExecutorHandle>();

  for (const role of ROLES) {
    const roleConfig = o.config.roles[role];
    const instanceId = roleConfig.executor;
    const instance = o.config.executors[instanceId];
    if (instance === undefined) {
      throw new ConfigError(
        `role "${role}" names executor "${instanceId}", which is not declared under executors:`,
        { role, instanceId },
      );
    }
    const sandboxIntent = ROLE_SANDBOX_INTENT[role];
    const executor = buildAdapter(instanceId, instance, sandboxIntent, {
      paths: o.paths,
      clock: o.clock,
      ids: o.ids,
      logger: o.logger,
    });
    assertSandboxSupported(instanceId, instance.type, executor.capabilities, sandboxIntent);

    handles.set(role, {
      role,
      executor,
      sandboxIntent,
      resolved: {
        model: instance.model,
        effort: instance.effort,
        maxTurns: roleConfig.maxTurns,
        contextBudgetTokens: roleConfig.contextBudgetTokens,
      },
    });
  }

  return {
    forRole(role: Role): ExecutorHandle {
      const handle = handles.get(role);
      if (handle === undefined) {
        throw new ConfigError(`no executor handle constructed for role "${role}"`, { role });
      }
      return handle;
    },
    accountForRole(role: Role): AccountId {
      return this.forRole(role).executor.account;
    },
    get handles(): readonly ExecutorHandle[] {
      return Array.from(handles.values());
    },
  };
}
