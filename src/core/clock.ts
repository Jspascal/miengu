import { z } from 'zod';
import { StoreError } from '../errors.js';

export const IsoTimestampSchema = z.string().datetime({ offset: false }).brand<'IsoTimestamp'>();
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Validates `ts` against `IsoTimestampSchema` first, so this never returns `NaN`: that path
 *  is unreachable for any value that came out of the log. Used by the SLA sweep (binding
 *  decision 8) to compare a checkpoint's `raisedAt` against `now` in whole seconds. */
export function epochSeconds(ts: IsoTimestamp): number {
  const parsed = IsoTimestampSchema.safeParse(ts);
  if (!parsed.success) {
    throw new StoreError(`epochSeconds: not a valid IsoTimestamp: ${JSON.stringify(ts)}`, {
      ts,
    });
  }
  return Math.floor(Date.parse(parsed.data) / 1000);
}

export interface Clock {
  now(): IsoTimestamp;
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now(): IsoTimestamp {
    return new Date().toISOString() as IsoTimestamp;
  },
  monotonicMs(): number {
    return performance.now();
  },
};

export function fixedClock(start: IsoTimestamp, stepMs = 1000): Clock {
  let currentMs = Date.parse(start);
  let monotonicMs = 0;
  return {
    now(): IsoTimestamp {
      const iso = new Date(currentMs).toISOString() as IsoTimestamp;
      currentMs += stepMs;
      return iso;
    },
    monotonicMs(): number {
      const value = monotonicMs;
      monotonicMs += stepMs;
      return value;
    },
  };
}
