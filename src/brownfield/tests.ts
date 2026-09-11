import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { sha256Hex } from '../core/hash.js';
import type { BrownfieldFact, BrownfieldOmission, CollectedEvidence, ScopedCollectorInput } from './types.js';

const TEST_PATH = /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|\.(?:test|spec)\.[^/]+$/;
const SUPPORTED_TEST_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const TEST_IDENTIFIER = /\b(?:it|test|describe)\s*(?:\.\w+)?\s*\(\s*(['"`])([^'"`\n]{1,512})\1/g;

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/');
}

function orderedFacts(facts: readonly BrownfieldFact[]): BrownfieldFact[] {
  return [...facts].sort((left, right) => lexical(JSON.stringify(left), JSON.stringify(right)));
}

function orderedOmissions(omissions: readonly BrownfieldOmission[]): BrownfieldOmission[] {
  return [...omissions].sort((left, right) => lexical(`${left.code}:${left.subject ?? ''}`, `${right.code}:${right.subject ?? ''}`));
}

function excerpt(source: Buffer, limit: number): string {
  return source.subarray(0, limit).toString('utf8');
}

function commandPathCandidates(command: string | null): readonly string[] {
  if (command === null) return [];
  const candidates = new Set<string>();
  const tokens = command.slice(0, 8_192).match(/(?:"[^"]+"|'[^']+'|[^\s]+)/g) ?? [];
  for (const token of tokens.slice(0, 64)) {
    const path = token.replace(/^(?:['"])(.*)(?:['"])$/, '$1');
    if (path.includes('/') && SUPPORTED_TEST_EXTENSION.test(path)) candidates.add(path);
  }
  return [...candidates].sort(lexical);
}

function edgePathCandidates(input: ScopedCollectorInput, selected: ReadonlySet<string>): readonly string[] {
  const candidates = new Set<string>();
  for (const edge of input.dependencyEdges) {
    if (selected.has(edge.from)) candidates.add(edge.to);
    else if (selected.has(edge.to)) candidates.add(edge.from);
  }
  return [...candidates].sort(lexical);
}

/** Tier 2: bounded test observations from the selected neighborhood, without behavioral inference. */
export async function collectTests(input: ScopedCollectorInput): Promise<CollectedEvidence> {
  const facts: BrownfieldFact[] = [];
  const omissions: BrownfieldOmission[] = [];
  const root = await realpath(input.targetRoot);
  const selected = new Set(input.scope.paths);
  const commandCandidates = commandPathCandidates(input.configuredTestCommand).filter((path) => selected.has(path));
  const edgeCandidates = edgePathCandidates(input, selected);
  const candidates = [...new Set([
    ...input.scope.paths.filter((path) => TEST_PATH.test(path)),
    ...commandCandidates,
    ...edgeCandidates,
  ])].sort(lexical);

  for (const path of candidates) {
    if (!validPath(path)) {
      omissions.push({ subject: path, code: 'path-invalid' });
      continue;
    }
    if (!SUPPORTED_TEST_EXTENSION.test(path)) {
      omissions.push({ subject: path, code: 'unsupported-test-syntax' });
      continue;
    }
    const absolute = resolve(root, path);
    if (!isInside(root, absolute)) {
      omissions.push({ subject: path, code: 'path-invalid' });
      continue;
    }
    let source: Buffer;
    try {
      const file = await lstat(absolute);
      if (file.isSymbolicLink()) {
        omissions.push({ subject: path, code: 'path-invalid' });
        continue;
      }
      if (!file.isFile()) {
        omissions.push({ subject: path, code: 'path-missing' });
        continue;
      }
      if (file.size > input.limits.maxFileBytes) {
        omissions.push({ subject: path, code: 'file-too-large' });
        continue;
      }
      if (!isInside(root, await realpath(absolute))) {
        omissions.push({ subject: path, code: 'path-invalid' });
        continue;
      }
      source = await readFile(absolute);
    } catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : null;
      omissions.push({ subject: path, code: code === 'ENOENT' ? 'path-missing' : 'path-unreadable' });
      continue;
    }
    if (source.includes(0)) {
      omissions.push({ subject: path, code: 'binary-file' });
      continue;
    }
    const identifiers = [...source.toString('utf8').matchAll(TEST_IDENTIFIER)].map((match) => match[2]).filter((id): id is string => id !== undefined);
    if (identifiers.length === 0) {
      omissions.push({ subject: path, code: 'unsupported-test-syntax' });
      continue;
    }
    const sourceSha256 = sha256Hex(source);
    const boundedExcerpt = excerpt(source, input.limits.maxTestExcerptBytes);
    for (const testId of [...new Set(identifiers)].sort(lexical)) {
      facts.push({ kind: 'test-spec', path, test_id: testId, source_sha256: sourceSha256, bytes: source.length, excerpt: boundedExcerpt });
    }
  }

  const sortedFacts = orderedFacts(facts);
  const sortedOmissions = orderedOmissions(omissions);
  return {
    facts: sortedFacts,
    omissions: sortedOmissions,
    coverage: sortedOmissions.length === 0 ? 'complete' : 'partial',
    treePaths: [],
    raw: {
      target_commit: input.targetCommit, candidates, command_candidates: commandCandidates,
      edge_candidates: edgeCandidates, facts: sortedFacts, omissions: sortedOmissions,
    },
  };
}
