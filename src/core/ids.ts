import { z } from 'zod';
import { IdError } from '../errors.js';

export const RE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RE_REQ_ID = /^REQ-[a-z0-9-]+-\d+$/;
export const RE_TASK_ID = /^task-[a-z0-9-]+-\d+$/;
export const RE_CLAIM_ID = /^claim-[a-z0-9-]+-\d+$/;
export const RE_ASSUMPTION_ID = /^assumption-[a-z0-9-]+-\d+$/;
export const RE_DECISION_ID = /^decision-[a-z0-9-]+-\d+$/;
export const RE_COMPONENT_ID = /^component-[a-z0-9-]+-\d+$/;
export const RE_INTERFACE_ID = /^interface-[a-z0-9-]+-\d+$/;
export const RE_TEST_ID = /^test-[a-z0-9-]+-\d+$/;
export const RE_SUITE_ID = /^suite-[a-z0-9-]+-\d+$/;
export const RE_WORK_ITEM_ID = /^wi-[a-z0-9-]+-[a-z0-9]{6}$/;
export const RE_EVENT_ID =
  /^evt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RE_RUN_ID =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const RE_CHECKPOINT_ID = /^cp-[a-z0-9-]+-\d+$/;

export const SlugSchema = z.string().regex(RE_SLUG).max(48).brand<'Slug'>();
export const ReqIdSchema = z.string().regex(RE_REQ_ID).brand<'ReqId'>();
export const TaskIdSchema = z.string().regex(RE_TASK_ID).brand<'TaskId'>();
export const ClaimIdSchema = z.string().regex(RE_CLAIM_ID).brand<'ClaimId'>();
export const AssumptionIdSchema = z
  .string()
  .regex(RE_ASSUMPTION_ID)
  .brand<'AssumptionId'>();
export const DecisionIdSchema = z
  .string()
  .regex(RE_DECISION_ID)
  .brand<'DecisionId'>();
export const ComponentIdSchema = z
  .string()
  .regex(RE_COMPONENT_ID)
  .brand<'ComponentId'>();
export const InterfaceIdSchema = z
  .string()
  .regex(RE_INTERFACE_ID)
  .brand<'InterfaceId'>();
export const TestIdSchema = z.string().regex(RE_TEST_ID).brand<'TestId'>();
export const SuiteIdSchema = z.string().regex(RE_SUITE_ID).brand<'SuiteId'>();
export const WorkItemIdSchema = z
  .string()
  .regex(RE_WORK_ITEM_ID)
  .brand<'WorkItemId'>();
export const EventIdSchema = z.string().regex(RE_EVENT_ID).brand<'EventId'>();
export const RunIdSchema = z.string().regex(RE_RUN_ID).brand<'RunId'>();
export const CheckpointIdSchema = z
  .string()
  .regex(RE_CHECKPOINT_ID)
  .brand<'CheckpointId'>();

export type Slug = z.infer<typeof SlugSchema>;
export type ReqId = z.infer<typeof ReqIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type ClaimId = z.infer<typeof ClaimIdSchema>;
export type AssumptionId = z.infer<typeof AssumptionIdSchema>;
export type DecisionId = z.infer<typeof DecisionIdSchema>;
export type ComponentId = z.infer<typeof ComponentIdSchema>;
export type InterfaceId = z.infer<typeof InterfaceIdSchema>;
export type TestId = z.infer<typeof TestIdSchema>;
export type SuiteId = z.infer<typeof SuiteIdSchema>;
export type WorkItemId = z.infer<typeof WorkItemIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;

function formatSerial(prefix: string, re: RegExp, slug: Slug, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new IdError(`serial number must be a positive integer, got ${String(n)}`, {
      prefix,
      slug,
      n,
    });
  }
  const id = `${prefix}${slug}-${n}`;
  if (!re.test(id)) {
    throw new IdError(`formatted id failed its own regex: ${id}`, { prefix, slug, n });
  }
  return id;
}

export function formatReqId(slug: Slug, n: number): ReqId {
  return formatSerial('REQ-', RE_REQ_ID, slug, n) as ReqId;
}
export function formatTaskId(slug: Slug, n: number): TaskId {
  return formatSerial('task-', RE_TASK_ID, slug, n) as TaskId;
}
export function formatClaimId(slug: Slug, n: number): ClaimId {
  return formatSerial('claim-', RE_CLAIM_ID, slug, n) as ClaimId;
}
export function formatAssumptionId(slug: Slug, n: number): AssumptionId {
  return formatSerial('assumption-', RE_ASSUMPTION_ID, slug, n) as AssumptionId;
}
export function formatDecisionId(slug: Slug, n: number): DecisionId {
  return formatSerial('decision-', RE_DECISION_ID, slug, n) as DecisionId;
}
export function formatComponentId(slug: Slug, n: number): ComponentId {
  return formatSerial('component-', RE_COMPONENT_ID, slug, n) as ComponentId;
}
export function formatInterfaceId(slug: Slug, n: number): InterfaceId {
  return formatSerial('interface-', RE_INTERFACE_ID, slug, n) as InterfaceId;
}
export function formatTestId(slug: Slug, n: number): TestId {
  return formatSerial('test-', RE_TEST_ID, slug, n) as TestId;
}
export function formatSuiteId(slug: Slug, n: number): SuiteId {
  return formatSerial('suite-', RE_SUITE_ID, slug, n) as SuiteId;
}
export function formatCheckpointId(slug: Slug, n: number): CheckpointId {
  return formatSerial('cp-', RE_CHECKPOINT_ID, slug, n) as CheckpointId;
}

interface SerialFamily {
  readonly prefix: string;
  readonly re: RegExp;
}

const SERIAL_FAMILIES: readonly SerialFamily[] = [
  { prefix: 'REQ-', re: RE_REQ_ID },
  { prefix: 'task-', re: RE_TASK_ID },
  { prefix: 'claim-', re: RE_CLAIM_ID },
  { prefix: 'assumption-', re: RE_ASSUMPTION_ID },
  { prefix: 'decision-', re: RE_DECISION_ID },
  { prefix: 'component-', re: RE_COMPONENT_ID },
  { prefix: 'interface-', re: RE_INTERFACE_ID },
  { prefix: 'test-', re: RE_TEST_ID },
  { prefix: 'suite-', re: RE_SUITE_ID },
  { prefix: 'cp-', re: RE_CHECKPOINT_ID },
];

const SERIAL_TAIL_RE = /^(.*)-(\d+)$/;

export function parseSerial(id: string): { slug: Slug; n: number } {
  for (const family of SERIAL_FAMILIES) {
    if (!family.re.test(id)) {
      continue;
    }
    const rest = id.slice(family.prefix.length);
    const match = SERIAL_TAIL_RE.exec(rest);
    if (match === null) {
      throw new IdError(`malformed serial id: ${id}`);
    }
    const slugPart = match[1];
    const nPart = match[2];
    if (slugPart === undefined || nPart === undefined) {
      throw new IdError(`malformed serial id: ${id}`);
    }
    const parsedSlug = SlugSchema.safeParse(slugPart);
    if (!parsedSlug.success) {
      throw new IdError(`malformed serial id slug: ${id}`);
    }
    return { slug: parsedSlug.data, n: Number.parseInt(nPart, 10) };
  }
  throw new IdError(`unrecognised serial id: ${id}`);
}

export function slugify(input: string): Slug {
  const withoutDiacritics = input.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const hyphenated = withoutDiacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = hyphenated.slice(0, 48).replace(/-+$/g, '');
  if (truncated.length === 0) {
    throw new IdError(`slugify produced an empty slug for input: ${JSON.stringify(input)}`);
  }
  const parsed = SlugSchema.safeParse(truncated);
  if (!parsed.success) {
    throw new IdError(`slugify produced an invalid slug for input: ${JSON.stringify(input)}`);
  }
  return parsed.data;
}

export function isSlug(v: unknown): v is Slug {
  return typeof v === 'string' && RE_SLUG.test(v);
}
export function isReqId(v: unknown): v is ReqId {
  return typeof v === 'string' && RE_REQ_ID.test(v);
}
export function isTaskId(v: unknown): v is TaskId {
  return typeof v === 'string' && RE_TASK_ID.test(v);
}
export function isClaimId(v: unknown): v is ClaimId {
  return typeof v === 'string' && RE_CLAIM_ID.test(v);
}
export function isAssumptionId(v: unknown): v is AssumptionId {
  return typeof v === 'string' && RE_ASSUMPTION_ID.test(v);
}
export function isDecisionId(v: unknown): v is DecisionId {
  return typeof v === 'string' && RE_DECISION_ID.test(v);
}
export function isComponentId(v: unknown): v is ComponentId {
  return typeof v === 'string' && RE_COMPONENT_ID.test(v);
}
export function isInterfaceId(v: unknown): v is InterfaceId {
  return typeof v === 'string' && RE_INTERFACE_ID.test(v);
}
export function isTestId(v: unknown): v is TestId {
  return typeof v === 'string' && RE_TEST_ID.test(v);
}
export function isSuiteId(v: unknown): v is SuiteId {
  return typeof v === 'string' && RE_SUITE_ID.test(v);
}
export function isWorkItemId(v: unknown): v is WorkItemId {
  return typeof v === 'string' && RE_WORK_ITEM_ID.test(v);
}
export function isEventId(v: unknown): v is EventId {
  return typeof v === 'string' && RE_EVENT_ID.test(v);
}
export function isRunId(v: unknown): v is RunId {
  return typeof v === 'string' && RE_RUN_ID.test(v);
}
export function isCheckpointId(v: unknown): v is CheckpointId {
  return typeof v === 'string' && RE_CHECKPOINT_ID.test(v);
}
