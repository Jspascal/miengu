import { z } from 'zod';
import { ReqIdSchema } from '../core/ids.js';

export const RequirementSetSchema = z
  .object({
    requirements: z
      .array(
        z
          .object({
            req_id: ReqIdSchema,
            statement: z.string().min(1),
            rationale: z.string().min(1),
            acceptance: z.array(z.string().min(1)).min(1),
            priority: z.enum(['must', 'should', 'could']),
            source_span: z.string().nullable(),
          })
          .strict(),
      )
      .min(1),
    ambiguities: z.array(
      z
        .object({
          question: z.string().min(1),
          affects: z.array(ReqIdSchema),
          options: z.array(z.string().min(1)).min(2),
          recommended: z.string().nullable(),
        })
        .strict(),
    ),
    out_of_scope: z.array(z.string().min(1)),
  })
  .strict();
export type RequirementSet = z.infer<typeof RequirementSetSchema>;
