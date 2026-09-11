import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { sha256Hex } from '../core/hash.js';
import type { BrownfieldFact, BrownfieldOmission, CollectedEvidence, CollectorInput } from './types.js';

const SUPPORTED_JSON_MANIFESTS: Readonly<Record<string, string>> = {
  'package.json': 'node',
  'composer.json': 'php',
};
const UNSUPPORTED_MANIFESTS = new Set(['pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml']);
const FRAMEWORKS = new Set(['next', 'react', 'vue', 'angular', 'express', 'fastify', 'nestjs', 'vite', 'vitest']);

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !resolve(root, rel).startsWith(`..${sep}`));
}

function validRelative(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function knownExclusion(path: string, input: CollectorInput, root: string): boolean {
  if (path === '.git' || path.startsWith('.git/')) return true;
  for (const candidate of [input.storeDir, ...input.workspaceMetadataDirs, '.miengu']) {
    if (candidate === null) continue;
    const absolute = resolve(root, candidate);
    if (!isInside(root, absolute)) continue;
    const rel = toPosix(relative(root, absolute));
    if (path === rel || path.startsWith(`${rel}/`)) return true;
  }
  return false;
}

function ordered<T extends { readonly kind: string }>(facts: readonly T[]): T[] {
  return [...facts].sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return lexical(a, b);
  });
}

function declaredEntrypoints(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || Array.isArray(value) || typeof value !== 'object') return [];
  return Object.keys(value as Record<string, unknown>)
    .sort(lexical)
    .flatMap((key) => declaredEntrypoints((value as Record<string, unknown>)[key]));
}

function parsePackageManifest(path: string, bytes: Buffer): { facts: BrownfieldFact[]; omissions: BrownfieldOmission[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { facts: [], omissions: [{ subject: path, code: 'unsupported-manifest' }] };
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { facts: [], omissions: [{ subject: path, code: 'unsupported-manifest' }] };
  }
  const manifest = parsed as Record<string, unknown>;
  const facts: BrownfieldFact[] = [{ kind: 'manifest', path, ecosystem: 'node' }];
  const dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
  for (const field of dependencies) {
    const values = manifest[field];
    if (values !== null && typeof values === 'object' && !Array.isArray(values)) {
      for (const name of Object.keys(values).sort(lexical)) {
        facts.push({ kind: 'dependency-edge', from: path, to: name });
        if (FRAMEWORKS.has(name)) facts.push({ kind: 'framework', name, manifest_path: path });
      }
    }
  }
  for (const field of ['main', 'module']) {
    const entry = manifest[field];
    if (typeof entry === 'string') facts.push({ kind: 'entrypoint', path: entry, source: `${path}:${field}` });
  }
  for (const entry of declaredEntrypoints(manifest['exports'])) {
    facts.push({ kind: 'entrypoint', path: entry, source: `${path}:exports` });
  }
  const bin = manifest['bin'];
  if (typeof bin === 'string') facts.push({ kind: 'entrypoint', path: bin, source: `${path}:bin` });
  if (bin !== null && typeof bin === 'object' && !Array.isArray(bin)) {
    for (const entry of Object.values(bin as Record<string, unknown>)) {
      if (typeof entry === 'string') facts.push({ kind: 'entrypoint', path: entry, source: `${path}:bin` });
    }
  }
  const scripts = manifest['scripts'];
  if (scripts !== null && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const name of Object.keys(scripts).sort(lexical)) {
      const command = (scripts as Record<string, unknown>)[name];
      if ((name === 'test' || name.startsWith('test:')) && typeof command === 'string') {
        facts.push({ kind: 'test-command', name, command, manifest_path: path });
      }
    }
  }
  return { facts, omissions: [] };
}

async function collectManifest(path: string, absolute: string): Promise<{ facts: BrownfieldFact[]; omissions: BrownfieldOmission[] }> {
  const ecosystem = SUPPORTED_JSON_MANIFESTS[path.split('/').at(-1) ?? ''];
  if (ecosystem === undefined) return { facts: [], omissions: [{ subject: path, code: 'unsupported-manifest' }] };
  const bytes = await readFile(absolute);
  if (ecosystem === 'node') return parsePackageManifest(path, bytes);
  try {
    JSON.parse(bytes.toString('utf8'));
    return { facts: [{ kind: 'manifest', path, ecosystem }], omissions: [] };
  } catch {
    return { facts: [], omissions: [{ subject: path, code: 'unsupported-manifest' }] };
  }
}

/** Tier 0: enumerate bounded repository metadata without following any symlink. */
export async function collectSkeleton(input: CollectorInput): Promise<CollectedEvidence> {
  const root = await realpath(input.targetRoot);
  const facts: BrownfieldFact[] = [];
  const omissions: BrownfieldOmission[] = [];
  const treePaths: string[] = [];
  const queue = [''];
  let inspected = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift() as string;
    const absolute = resolve(root, current || '.');
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      omissions.push({ subject: current || null, code: 'path-unreadable' });
      continue;
    }
    entries.sort((left, right) => lexical(left.name, right.name));
    for (const entry of entries) {
      const path = current === '' ? entry.name : `${current}/${entry.name}`;
      if (!validRelative(path) || knownExclusion(path, input, root)) continue;
      if (inspected >= input.limits.maxTreeEntries) {
        omissions.push({ subject: path, code: 'scope-truncated' });
        truncated = true;
        break;
      }
      inspected += 1;
      const child = resolve(root, path);
      if (!isInside(root, child)) {
        omissions.push({ subject: path, code: 'path-invalid' });
        continue;
      }
      let stat;
      try {
        stat = await lstat(child);
      } catch {
        omissions.push({ subject: path, code: 'path-unreadable' });
        continue;
      }
      if (stat.isSymbolicLink()) {
        omissions.push({ subject: path, code: 'path-invalid' });
        continue;
      }
      if (stat.isDirectory()) {
        queue.push(path);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > input.limits.maxFileBytes) {
        omissions.push({ subject: path, code: 'file-too-large' });
        continue;
      }
      treePaths.push(path);
      let bytes: Buffer;
      try {
        bytes = await readFile(child);
      } catch {
        omissions.push({ subject: path, code: 'path-unreadable' });
        continue;
      }
      facts.push({ kind: 'file', path, sha256: sha256Hex(bytes), bytes: bytes.length });
      const name = path.split('/').at(-1) ?? '';
      if (SUPPORTED_JSON_MANIFESTS[name] !== undefined || UNSUPPORTED_MANIFESTS.has(name)) {
        try {
          const metadata = await collectManifest(path, child);
          facts.push(...metadata.facts);
          omissions.push(...metadata.omissions);
        } catch {
          omissions.push({ subject: path, code: 'path-unreadable' });
        }
      }
    }
  }

  const sortedFacts = ordered(facts);
  const sortedOmissions = [...omissions].sort((left, right) => lexical(`${left.code}:${left.subject ?? ''}`, `${right.code}:${right.subject ?? ''}`));
  const sortedTree = treePaths.sort(lexical);
  return {
    facts: sortedFacts,
    omissions: sortedOmissions,
    coverage: sortedOmissions.length === 0 ? 'complete' : 'partial',
    treePaths: sortedTree,
    raw: { target_commit: input.targetCommit, paths: sortedTree, facts: sortedFacts, omissions: sortedOmissions },
  };
}
