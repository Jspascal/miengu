import { NotImplementedError } from '../../errors.js';

/**
 * Prints `${command}: not implemented until Phase ${phase}` to stderr and throws
 * `NotImplementedError`. Never prints plausible-looking fake output, returns zero, or writes
 * a file — an audit trail must never imply something happened that did not.
 */
export function notImplemented(command: string, phase: number): never {
  const message = `${command}: not implemented until Phase ${String(phase)}`;
  process.stderr.write(`${message}\n`);
  throw new NotImplementedError(command, phase);
}
