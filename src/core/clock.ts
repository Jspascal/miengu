import { z } from 'zod';

export const IsoTimestampSchema = z.string().datetime({ offset: false }).brand<'IsoTimestamp'>();
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

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
