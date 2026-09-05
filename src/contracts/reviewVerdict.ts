import { z } from 'zod';
import { TaskIdSchema } from '../core/ids.js';

export const ReviewVerdictSchema = z
  .object({
    task_id: TaskIdSchema,
    verdict: z.enum(['accept', 'revise', 'escalate']),
    findings: z.array(
      z
        .object({
          severity: z.enum(['blocking', 'major', 'minor']),
          kind: z.enum([
            'requirement-miss',
            'architecture-violation',
            'unrequested-scope',
            'correctness',
            'maintainability',
          ]),
          detail: z.string().min(1),
          path: z.string().nullable(),
        })
        .strict(),
    ),
    escalate_to: z.enum(['planner', 'architect', 'analyst']).nullable(),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
