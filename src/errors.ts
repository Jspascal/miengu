export class MienguError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    exitCode: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    if (details !== undefined) {
      this.details = details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ConfigError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFIG_ERROR', 3, details);
  }
}

export class StoreError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'STORE_ERROR', 4, details);
  }
}

export class LogCorruptError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LOG_CORRUPT_ERROR', 4, details);
  }
}

export class ProjectionError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'PROJECTION_ERROR', 4, details);
  }
}

export class LockHeldError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'LOCK_HELD_ERROR', 5, details);
  }
}

export class ReplayMismatchError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'REPLAY_MISMATCH_ERROR', 7, details);
  }
}

export class NotImplementedError extends MienguError {
  constructor(what: string, phase: number) {
    super(`${what}: not implemented until Phase ${phase}`, 'NOT_IMPLEMENTED_ERROR', 10, {
      what,
      phase,
    });
  }
}

export class WorkspaceError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'WORKSPACE_ERROR', 1, details);
  }
}

export class IdError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'ID_ERROR', 1, details);
  }
}

export class CanonicalError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CANONICAL_ERROR', 1, details);
  }
}

export class ExecutorError extends MienguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'EXECUTOR_ERROR', 1, details);
  }
}

export function isMienguError(e: unknown): e is MienguError {
  return e instanceof MienguError;
}
