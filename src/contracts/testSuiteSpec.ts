import { z } from 'zod';
import { IsoTimestampSchema } from '../core/clock.js';
import { ReqIdSchema, SuiteIdSchema, TestIdSchema } from '../core/ids.js';

export const TestCaseSchema = z
  .object({
    test_id: TestIdSchema,
    req_ids: z.array(ReqIdSchema).min(1),
    path: z.string().min(1),
    intent: z.string().min(1),
    negative: z.boolean(),
    asserts_output: z.boolean(),
  })
  .strict();

/** What the agent produces and what `--output-schema` enforces. */
export const TestSuiteSpecDraftSchema = z
  .object({
    suite_id: SuiteIdSchema,
    cases: z.array(TestCaseSchema).min(1),
  })
  .strict();

/** §4 verbatim. Produced by the supervisor post-step; the recorded artifact. */
export const TestSuiteSpecSchema = z
  .object({
    suite_id: SuiteIdSchema,
    frozen_at: IsoTimestampSchema,
    content_hash: z.string().regex(/^[0-9a-f]{64}$/),
    cases: z.array(TestCaseSchema).min(1),
  })
  .strict();

export type TestCase = z.infer<typeof TestCaseSchema>;
export type TestSuiteSpecDraft = z.infer<typeof TestSuiteSpecDraftSchema>;
export type TestSuiteSpec = z.infer<typeof TestSuiteSpecSchema>;
