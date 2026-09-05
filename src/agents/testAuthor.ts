import type { TestSuiteSpec, TestSuiteSpecDraft } from '../contracts/index.js';
import type { ContextPackSection } from '../wiki/contextpack.js';
import { freezeTests } from '../supervisor/freeze.js';
import { AgentError } from '../errors.js';
import { checkTestSuiteSpec } from './checks.js';
import type { CheckContext } from './checks.js';
import type { PackBuildInput, PostStepInput, PostStepResult, RoleModule } from './agent.js';

function section(
  kind: ContextPackSection['kind'],
  heading: string,
  body: string,
): ContextPackSection {
  return { kind, heading, body, tier: 'T1', sourceEventId: null };
}

/**
 * §15.4 pack: `RequirementSet` · `ArchitecturePlan.interfaces` only · test conventions
 * detected mechanically. Never emits implementation, `architecture-components`,
 * `file-map`, `task-graph`, `task`, or anything the Coder produced.
 */
export function buildCandidates(i: PackBuildInput): readonly ContextPackSection[] {
  const sections: ContextPackSection[] = [];
  if (i.raw.wikiIndex !== null) {
    sections.push(section('wiki-index', 'Wiki index', i.raw.wikiIndex));
  }
  if (i.raw.existingReqIds.length > 0) {
    sections.push(
      section('existing-req-ids', 'Existing requirement ids', i.raw.existingReqIds.join('\n')),
    );
  }
  if (i.raw.priorOutOfScope.length > 0) {
    sections.push(
      section('prior-out-of-scope', 'Previously recorded out of scope', i.raw.priorOutOfScope.join('\n')),
    );
  }
  if (i.raw.stackFacts !== null) {
    sections.push(section('stack-facts', 'Stack facts', i.raw.stackFacts));
  }
  if (i.raw.systemSkeleton !== null) {
    sections.push(section('system-skeleton', 'System skeleton', i.raw.systemSkeleton));
  }
  if (i.checkContext.requirementSet !== null) {
    sections.push(
      section('requirement-set', 'Requirement set', JSON.stringify(i.checkContext.requirementSet, null, 2)),
    );
  }
  if (i.checkContext.architecturePlan !== null) {
    sections.push(
      section(
        'architecture-interfaces',
        'Interfaces',
        JSON.stringify(i.checkContext.architecturePlan.interfaces, null, 2),
      ),
    );
  }
  if (i.raw.testConventions !== null) {
    sections.push(section('test-conventions', 'Test conventions', i.raw.testConventions));
  }
  if (i.raw.frozenTestList.length > 0) {
    sections.push(
      section(
        'frozen-test-list',
        'Previously frozen tests (names and intents only)',
        i.raw.frozenTestList.map((t) => `${t.testId}: ${t.intent}`).join('\n'),
      ),
    );
  }
  if (i.raw.assumptions.length > 0) {
    sections.push(section('assumptions', 'Recorded assumptions', JSON.stringify(i.raw.assumptions, null, 2)));
  }
  return sections;
}

export function buildTaskSection(): string {
  return 'Write against the contract, never an implementation. Produce a TestSuiteSpec ' +
    'covering every must requirement, with at least one negative case and at least one ' +
    'case that asserts observable output, following the target\'s existing conventions.';
}

export function validate(artifact: unknown, c: CheckContext): readonly string[] {
  return checkTestSuiteSpec(artifact as TestSuiteSpecDraft, c);
}

/**
 * §15.4 post-step: the freeze. Writes the declared test files (already on disk — the Test
 * Author runs `workspace-write`) into the frozen copy, hashes them, and completes the
 * `TestSuiteSpec` with `content_hash` and `frozen_at` taken from the `TestsFrozen` event's
 * `ts` — never from a fresh clock read.
 */
export async function postStep(i: PostStepInput): Promise<PostStepResult> {
  const draft = i.artifact as TestSuiteSpecDraft;
  const paths = draft.cases.map((c) => c.path);

  let frozen: { contentHash: string; files: readonly { path: string; sha256: string; bytes: number }[] };
  try {
    frozen = await freezeTests({
      workdir: i.workdir,
      frozenCopyDir: i.frozenTestsDir,
      paths,
      suiteId: draft.suite_id,
    });
  } catch (err) {
    return {
      kind: 'failed',
      reason: 'workspace-error',
      detail: err instanceof AgentError ? err.message : String(err),
      derived: [],
    };
  }

  const event = await i.appendDerived({
    type: 'TestsFrozen',
    data: {
      suite_id: draft.suite_id,
      content_hash: frozen.contentHash,
      files: frozen.files.map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
      frozen_copy_dir: i.frozenTestsDir,
    },
    actor: { kind: 'supervisor', id: null },
  });

  const completed: TestSuiteSpec = {
    suite_id: draft.suite_id,
    frozen_at: event.ts,
    content_hash: frozen.contentHash,
    cases: draft.cases,
  };

  return { kind: 'ok', body: completed, derived: [] };
}

export const testAuthorModule: RoleModule = {
  role: 'testAuthor',
  stage: 'test-authoring',
  artifactKind: 'test-suite-spec',
  buildCandidates,
  buildTaskSection,
  validate,
  postStep,
};
