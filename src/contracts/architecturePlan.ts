import { z } from 'zod';
import {
  ClaimIdSchema,
  ComponentIdSchema,
  DecisionIdSchema,
  InterfaceIdSchema,
  ReqIdSchema,
  WorkItemIdSchema,
} from '../core/ids.js';
import { BrownfieldPredicateSchema } from '../core/events.js';

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
    // Phase 6 decision 23: the Architect is the sole Tier-3 falsification proposal author.
    // Each entry carries only an assertion, a nullable qualified existing claim subject, a
    // nullable area, and a closed predicate — never command argv, target commit, scope hash,
    // event id, routing choice or free-form executable text. An empty array is valid.
    falsifications: z.array(
      z
        .object({
          assertion: z.string().min(1),
          subject: z
            .object({ claim_item: WorkItemIdSchema, claim: ClaimIdSchema })
            .strict()
            .nullable(),
          area: z.string().nullable(),
          predicate: BrownfieldPredicateSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type ArchitecturePlan = z.infer<typeof ArchitecturePlanSchema>;
