import pino from 'pino';

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
  readonly level: string;
  readonly destination?: string;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const { level, destination } = options;
  if (destination !== undefined) {
    return pino({ level }, pino.destination(destination));
  }
  return pino({ level }, pino.destination(2));
}

export const silentLogger: Logger = pino({ level: 'silent' });
