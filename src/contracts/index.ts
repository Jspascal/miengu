import type { z } from 'zod';
import type { ArtifactKind, Role, Stage } from '../core/events.js';
import { stageForRole } from '../state/workitem.js';
import { ArchitecturePlanSchema } from './architecturePlan.js';
import { ImplementationSchema } from './implementation.js';
import { RequirementSetSchema } from './requirementSet.js';
import { ReviewVerdictSchema } from './reviewVerdict.js';
import { TaskGraphSchema } from './taskGraph.js';
import { TestSuiteSpecDraftSchema } from './testSuiteSpec.js';

export { ArchitecturePlanSchema } from './architecturePlan.js';
export type { ArchitecturePlan } from './architecturePlan.js';
export { ImplementationSchema } from './implementation.js';
export type { Implementation } from './implementation.js';
export { RequirementSetSchema } from './requirementSet.js';
export type { RequirementSet } from './requirementSet.js';
export { ReviewVerdictSchema } from './reviewVerdict.js';
export type { ReviewVerdict } from './reviewVerdict.js';
export { TaskGraphSchema } from './taskGraph.js';
export type { TaskGraph } from './taskGraph.js';
export {
  TestCaseSchema,
  TestSuiteSpecDraftSchema,
  TestSuiteSpecSchema,
} from './testSuiteSpec.js';
export type { TestCase, TestSuiteSpecDraft, TestSuiteSpec } from './testSuiteSpec.js';

export interface ContractBinding {
  readonly role: Role;
  readonly stage: Stage;
  readonly artifactKind: ArtifactKind;
  /** The AGENT-facing schema (draft form where they differ — see `testAuthor`). */
  readonly schema: z.ZodTypeAny;
  /** JSON Schema `title`. */
  readonly title: string;
}

export const CONTRACTS = {
  analyst: {
    role: 'analyst',
    stage: stageForRole('analyst'),
    artifactKind: 'requirement-set',
    schema: RequirementSetSchema,
    title: 'RequirementSet',
  },
  architect: {
    role: 'architect',
    stage: stageForRole('architect'),
    artifactKind: 'architecture-plan',
    schema: ArchitecturePlanSchema,
    title: 'ArchitecturePlan',
  },
  planner: {
    role: 'planner',
    stage: stageForRole('planner'),
    artifactKind: 'task-graph',
    schema: TaskGraphSchema,
    title: 'TaskGraph',
  },
  testAuthor: {
    role: 'testAuthor',
    stage: stageForRole('testAuthor'),
    artifactKind: 'test-suite-spec',
    schema: TestSuiteSpecDraftSchema,
    title: 'TestSuiteSpecDraft',
  },
  coder: {
    role: 'coder',
    stage: stageForRole('coder'),
    artifactKind: 'implementation',
    schema: ImplementationSchema,
    title: 'Implementation',
  },
  reviewer: {
    role: 'reviewer',
    stage: stageForRole('reviewer'),
    artifactKind: 'review-verdict',
    schema: ReviewVerdictSchema,
    title: 'ReviewVerdict',
  },
} satisfies Record<Role, ContractBinding>;

export function contractFor(role: Role): ContractBinding {
  return CONTRACTS[role];
}
