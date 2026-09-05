import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCandidates, postStep, testAuthorModule } from '../../src/agents/testAuthor.js';
import { ROLE_PACK_POLICY } from '../../src/wiki/contextpack.js';
import { computeContentHash } from '../../src/supervisor/freeze.js';
import { TestSuiteSpecDraftSchema, TestSuiteSpecSchema } from '../../src/contracts/testSuiteSpec.js';
import type { PackBuildInput } from '../../src/agents/agent.js';
import { SlugSchema, WorkItemIdSchema } from '../../src/core/ids.js';
import { fixedClock } from '../../src/core/clock.js';
import type { IsoTimestamp } from '../../src/core/clock.js';

const itemId = WorkItemIdSchema.parse('wi-example-abc123');
const slug = SlugSchema.parse('example');
const START = '2024-01-01T00:00:00.000Z' as IsoTimestamp;

function emptyRaw(): PackBuildInput['raw'] {
  return {
    prd: null,
    wikiIndex: null,
    existingReqIds: [],
    priorOutOfScope: [],
    stackFacts: null,
    systemSkeleton: null,
    fileMap: null,
    testConventions: null,
    sourceFiles: [],
    frozenTestList: [],
    frozenTestBodies: [],
    diff: null,
    oracleResults: null,
    reviewerFindings: null,
    assumptions: [],
  };
}

function pack(overrides: Partial<PackBuildInput['raw']> = {}): PackBuildInput {
  return {
    itemId,
    checkContext: {
      requirementSet: null,
      architecturePlan: null,
      taskGraph: null,
      maxPathsPerTask: 8,
      testDirs: ['test/'],
    },
    task: null,
    raw: { ...emptyRaw(), ...overrides },
  };
}

describe("testAuthor.buildCandidates excludes implementation, components, file-map, task-graph", () => {
  it('never emits architecture-components, file-map, task, or task-graph even when offered', () => {
    const full = pack({ fileMap: 'files', sourceFiles: [{ path: 'src/a.ts', body: 'x' }] });
    const sections = buildCandidates(full);
    const kinds = sections.map((s) => s.kind);
    expect(kinds).not.toContain('architecture-components');
    expect(kinds).not.toContain('file-map');
    expect(kinds).not.toContain('task');
    expect(kinds).not.toContain('task-graph');
    expect(kinds).not.toContain('source-files');
    const omits = ROLE_PACK_POLICY.testAuthor.omits;
    for (const kind of kinds) {
      expect(omits).not.toContain(kind);
    }
  });
});

let root: string;
let workdir: string;
let frozenTestsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'miengu-testauthor-'));
  workdir = join(root, 'workdir');
  frozenTestsDir = join(root, 'frozen-tests');
  await mkdir(join(workdir, 'test'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('testAuthor.postStep — the freeze', () => {
  it('completes a TestSuiteSpec whose content_hash equals computeContentHash(files), validating against TestSuiteSpecSchema', async () => {
    await writeFile(join(workdir, 'test/a.test.ts'), 'test body A');
    await writeFile(join(workdir, 'test/b.test.ts'), 'test body B');

    const draft = TestSuiteSpecDraftSchema.parse({
      suite_id: 'suite-example-1',
      cases: [
        {
          test_id: 'test-example-1',
          req_ids: ['REQ-example-1'],
          path: 'test/a.test.ts',
          intent: 'asserts a',
          negative: false,
          asserts_output: true,
        },
        {
          test_id: 'test-example-2',
          req_ids: ['REQ-example-1'],
          path: 'test/b.test.ts',
          intent: 'asserts b fails on bad input',
          negative: true,
          asserts_output: false,
        },
      ],
    });

    const clock = fixedClock(START);
    const appended: { type: string; data: unknown }[] = [];
    const result = await postStep({
      itemId,
      slug,
      artifact: draft,
      checkContext: { requirementSet: null, architecturePlan: null, taskGraph: null, maxPathsPerTask: 8, testDirs: [] },
      ids: undefined as never,
      workdir,
      frozenTestsDir,
      frozenTests: null,
      appendDerived: async (input) => {
        appended.push({ type: input.type, data: input.data });
        return { ts: clock.now() };
      },
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') {
      return;
    }
    const parsed = TestSuiteSpecSchema.parse(result.body);
    expect(parsed.frozen_at).toBe(START);

    const frozenEvent = appended.find((d) => d.type === 'TestsFrozen');
    expect(frozenEvent).toBeDefined();
    const files = (frozenEvent?.data as { files: { path: string; sha256: string; bytes: number }[] }).files;
    expect(files).toHaveLength(2);
    expect(parsed.content_hash).toBe(computeContentHash(files));
  });
});

describe('testAuthorModule', () => {
  it('binds role, stage and artifactKind consistently', () => {
    expect(testAuthorModule.role).toBe('testAuthor');
    expect(testAuthorModule.stage).toBe('test-authoring');
    expect(testAuthorModule.artifactKind).toBe('test-suite-spec');
  });
});
