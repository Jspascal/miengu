import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { BrownfieldFact, BrownfieldOmission, CollectedEvidence, ScopedCollectorInput } from './types.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedFacts(facts: readonly BrownfieldFact[]): BrownfieldFact[] {
  return [...facts].sort((left, right) => lexical(JSON.stringify(left), JSON.stringify(right)));
}

function orderedOmissions(omissions: readonly BrownfieldOmission[]): BrownfieldOmission[] {
  return [...omissions].sort((left, right) => lexical(`${left.code}:${left.subject ?? ''}`, `${right.code}:${right.subject ?? ''}`));
}

function errorText(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { stderr?: unknown; message?: unknown; killed?: unknown };
    return `${typeof candidate.stderr === 'string' ? candidate.stderr : ''}\n${typeof candidate.message === 'string' ? candidate.message : ''}`;
  }
  return String(error);
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
    encoding: 'utf8', shell: false, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

function omissionForGitError(error: unknown, subject: string | null): BrownfieldOmission {
  const text = errorText(error);
  if (/timed out/i.test(text)) return { subject, code: 'timed-out' };
  if (/not a git repository/i.test(text)) return { subject, code: 'not-git' };
  if (/bad object|unknown revision|needed a single revision|ambiguous argument/i.test(text)) {
    return { subject, code: 'git-object-missing' };
  }
  return { subject, code: 'command-failed' };
}

function subjectTokens(subject: string): readonly string[] {
  return subject.toLowerCase().match(/[a-z0-9][a-z0-9-]{0,63}/g) ?? [];
}

interface Commit {
  readonly hash: string;
  readonly parents: readonly string[];
  readonly subject: string;
}

function parseCommits(raw: string): readonly Commit[] {
  return raw.split('\x1e').flatMap((record) => {
    if (record.length === 0) return [];
    const [hash = '', parents = '', subject = ''] = record.split('\0', 3);
    if (hash.length === 0) return [];
    return [{ hash, parents: parents.length === 0 ? [] : parents.split(' '), subject }];
  });
}

function parseChangedLines(raw: string): ReadonlyMap<string, number> {
  const changed = new Map<string, number>();
  for (const line of raw.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (match === null) continue;
    const added = match[1] === '-' ? 0 : Number(match[1]);
    const removed = match[2] === '-' ? 0 : Number(match[2]);
    const path = match[3];
    if (path !== undefined) changed.set(path, added + removed);
  }
  return changed;
}

/** Tier 1: bounded, path-scoped commit vocabulary, churn, and unordered co-change facts. */
export async function collectGit(input: ScopedCollectorInput): Promise<CollectedEvidence> {
  const omissions: BrownfieldOmission[] = [];
  const vocabulary = new Map<string, number>();
  const churn = new Map<string, { commits: number; changedLines: number }>();
  const cochange = new Map<string, number>();
  const paths = [...new Set(input.scope.paths)].sort(lexical);

  if (paths.length === 0) {
    return { facts: [], omissions: [], coverage: 'complete', treePaths: [], raw: { commits: [], paths } };
  }

  try {
    const inside = (await git(input.targetRoot, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') throw new Error('not a git repository');
  } catch (error) {
    omissions.push(omissionForGitError(error, null));
    return { facts: [], omissions: orderedOmissions(omissions), coverage: 'partial', treePaths: [], raw: { commits: [], paths } };
  }

  try {
    await git(input.targetRoot, ['rev-parse', '--verify', `${input.targetCommit}^{commit}`]);
  } catch (error) {
    omissions.push(omissionForGitError(error, input.targetCommit));
    return { facts: [], omissions: orderedOmissions(omissions), coverage: 'partial', treePaths: [], raw: { commits: [], paths } };
  }

  try {
    if ((await git(input.targetRoot, ['rev-parse', '--is-shallow-repository'])).trim() === 'true') {
      omissions.push({ subject: null, code: 'shallow-history' });
    }
  } catch (error) {
    omissions.push(omissionForGitError(error, null));
  }

  let commits: readonly Commit[];
  try {
    commits = parseCommits(await git(input.targetRoot, [
      'log', '--format=%x1e%H%x00%P%x00%s', `--max-count=${input.limits.maxGitCommits}`, input.targetCommit, '--', ...paths,
    ]));
  } catch (error) {
    omissions.push(omissionForGitError(error, input.targetCommit));
    return { facts: [], omissions: orderedOmissions(omissions), coverage: 'partial', treePaths: [], raw: { commits: [], paths } };
  }

  const vocabularyLimit = input.limits.maxGitCommits * 8;
  let vocabularyTruncated = false;
  for (const commit of commits) {
    for (const token of subjectTokens(commit.subject)) {
      if (vocabulary.has(token) || vocabulary.size < vocabularyLimit) vocabulary.set(token, (vocabulary.get(token) ?? 0) + 1);
      else vocabularyTruncated = true;
    }
    // A merge's subject is historical vocabulary, but its parent-relative changes are deliberately
    // not interpreted as churn or co-change.
    if (commit.parents.length > 1) continue;
    try {
      const allFiles = (await git(input.targetRoot, ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', commit.hash]))
        .split('\0').filter((path) => path.length > 0);
      const numstat = parseChangedLines(await git(input.targetRoot, [
        'diff-tree', '--root', '--no-commit-id', '--numstat', '--no-renames', '-r', commit.hash, '--', ...paths,
      ]));
      const changedPaths = [...numstat.keys()].sort(lexical);
      for (const [path, changedLines] of numstat) {
        const current = churn.get(path) ?? { commits: 0, changedLines: 0 };
        churn.set(path, { commits: current.commits + 1, changedLines: current.changedLines + changedLines });
      }
      if (allFiles.length > input.limits.maxFilesPerCommit) {
        omissions.push({ subject: commit.hash, code: 'commit-too-wide' });
        continue;
      }
      for (let leftIndex = 0; leftIndex < changedPaths.length; leftIndex += 1) {
        const left = changedPaths[leftIndex];
        if (left === undefined) continue;
        for (let rightIndex = leftIndex + 1; rightIndex < changedPaths.length; rightIndex += 1) {
          const right = changedPaths[rightIndex];
          if (right === undefined) continue;
          const pair = `${left}\0${right}`;
          cochange.set(pair, (cochange.get(pair) ?? 0) + 1);
        }
      }
    } catch (error) {
      omissions.push(omissionForGitError(error, commit.hash));
    }
  }

  if (vocabularyTruncated) omissions.push({ subject: null, code: 'output-truncated' });

  const facts: BrownfieldFact[] = [
    ...[...vocabulary.entries()].map(([token, count]) => ({ kind: 'git-vocabulary' as const, token, count })),
    ...[...churn.entries()].map(([path, value]) => ({ kind: 'git-churn' as const, path, commits: value.commits, changed_lines: value.changedLines })),
    ...[...cochange.entries()].map(([pair, commits]) => {
      const [left = '', right = ''] = pair.split('\0', 2);
      return { kind: 'git-cochange' as const, left, right, commits };
    }),
  ];
  const sortedFacts = orderedFacts(facts);
  const sortedOmissions = orderedOmissions(omissions);
  return {
    facts: sortedFacts,
    omissions: sortedOmissions,
    coverage: sortedOmissions.length === 0 ? 'complete' : 'partial',
    treePaths: [],
    raw: { target_commit: input.targetCommit, paths, commits, facts: sortedFacts, omissions: sortedOmissions },
  };
}
