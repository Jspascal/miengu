import { z } from 'zod';
import { ComponentIdSchema, ReqIdSchema, TaskIdSchema } from '../core/ids.js';

export const TaskGraphSchema = z
  .object({
    tasks: z
      .array(
        z
          .object({
            task_id: TaskIdSchema,
            title: z.string().min(1),
            req_ids: z.array(ReqIdSchema).min(1),
            component_ids: z.array(ComponentIdSchema),
            expected_paths: z.array(z.string().min(1)).min(1),
            depends_on: z.array(TaskIdSchema),
            definition_of_done: z.array(z.string().min(1)).min(1),
            estimated_turns: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type TaskGraph = z.infer<typeof TaskGraphSchema>;
