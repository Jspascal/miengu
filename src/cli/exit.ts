import { isMienguError } from '../errors.js';

/** The §3 exit-code table, as a frozen const. */
export const EXIT = {
  OK: 0,
  INTERNAL: 1,
  USAGE: 2,
  CONFIG: 3,
  STORE: 4,
  LOCK_HELD: 5,
  PARKED: 6,
  REPLAY_MISMATCH: 7,
  NOT_IMPLEMENTED: 10,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Maps a thrown value to its exit code: a `MienguError`'s own `exitCode`, else `EXIT.INTERNAL`. */
export function exitCodeFor(e: unknown): number {
  return isMienguError(e) ? e.exitCode : EXIT.INTERNAL;
}
