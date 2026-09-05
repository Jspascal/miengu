import { z } from 'zod';
import { AssumptionIdSchema, DecisionIdSchema, TaskIdSchema } from '../core/ids.js';

export const ImplementationSchema = z
  .object({
    task_id: TaskIdSchema,
    diff_ref: z.string().min(1),
    files_touched: z.array(z.string().min(1)),
    assumption_ids: z.array(AssumptionIdSchema),
    deviations: z.array(
      z
        .object({
          from_decision_id: DecisionIdSchema,
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type Implementation = z.infer<typeof ImplementationSchema>;
