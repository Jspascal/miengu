import { z } from 'zod';
import { ComponentIdSchema, DecisionIdSchema, InterfaceIdSchema, ReqIdSchema } from '../core/ids.js';

export const ArchitecturePlanSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          decision_id: DecisionIdSchema,
          title: z.string().min(1),
          choice: z.string().min(1),
          alternatives: z.array(z.string().min(1)),
          rationale: z.string().min(1),
          req_ids: z.array(ReqIdSchema),
          supersedes: DecisionIdSchema.nullable(),
          blast_radius: z.enum(['reversible', 'irreversible']),
        })
        .strict(),
    ),
    components: z.array(
      z
        .object({
          component_id: ComponentIdSchema,
          responsibility: z.string().min(1),
          paths: z.array(z.string().min(1)),
          depends_on: z.array(ComponentIdSchema),
        })
        .strict(),
    ),
    interfaces: z.array(
      z
        .object({
          interface_id: InterfaceIdSchema,
          component_id: ComponentIdSchema,
          signature: z.string().min(1),
          behaviour: z.string().min(1),
          req_ids: z.array(ReqIdSchema).min(1),
        })
        .strict(),
    ),
  })
  .strict();
export type ArchitecturePlan = z.infer<typeof ArchitecturePlanSchema>;
