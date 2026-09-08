import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');

/** Walks `src/` for every `.ts` file (item 14: "enumerate by walking", never a fixed list). */
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function toPosixRel(absPath: string): string {
  return relative(process.cwd(), absPath).split(sep).join('/');
}

const ALL_SRC_FILES = walkTsFiles(SRC_ROOT).map(toPosixRel).sort();

const FORBIDDEN_IMPORT_DIRS = [
  'src/agents/',
  'src/supervisor/',
  'src/executors/',
  'src/oracles/',
  'src/integrator/',
];
const FORBIDDEN_IMPORT_EXTRA_FILES = ['src/wiki/contextpack.ts', 'src/wiki/packmaterials.ts'];

describe('§12 module boundary: nothing agent-reachable imports the human view or the report', () => {
  const subjects = ALL_SRC_FILES.filter(
    (f) =>
      FORBIDDEN_IMPORT_DIRS.some((dir) => f.startsWith(dir)) || FORBIDDEN_IMPORT_EXTRA_FILES.includes(f),
  );

  it('the walk actually reaches the directories and files this audit is supposed to cover', () => {
    for (const dir of FORBIDDEN_IMPORT_DIRS) {
      expect(subjects.some((f) => f.startsWith(dir))).toBe(true);
    }
    for (const f of FORBIDDEN_IMPORT_EXTRA_FILES) {
      expect(subjects).toContain(f);
    }
  });

  for (const relPath of subjects) {
    it(`${relPath} imports neither humanview.js nor report/batch.js`, () => {
      const source = readFileSync(join(process.cwd(), relPath), 'utf8');
      expect(source).not.toMatch(/from\s+['"][^'"]*humanview\.js['"]/);
      expect(source).not.toMatch(/from\s+['"][^'"]*report\/batch\.js['"]/);
    });
  }
});

describe('§12 module boundary: the human view and the report import nothing forbidden', () => {
  const MODULES = ['src/wiki/humanview.ts', 'src/report/batch.ts'];

  for (const relPath of MODULES) {
    const abs = join(process.cwd(), relPath);
    // report/batch.ts is created by Group D (item 15); this file exists as of this item and
    // the assertion below already applies to it. The other module's is skipped, never
    // silently passed, until it exists.
    const exists = existsSync(abs);
    const runner = exists ? it : it.skip;
    runner(`${relPath} contains no node: import and no import from ../agents/`, () => {
      const source = readFileSync(abs, 'utf8');
      expect(source).not.toMatch(/from\s+['"]node:/);
      expect(source).not.toMatch(/from\s+['"][^'"]*\/agents\//);
    });
  }
});

describe('§12 module boundary: humanview.ts exports no function that claims to write', () => {
  const source = readFileSync(join(process.cwd(), 'src/wiki/humanview.ts'), 'utf8');
  const exportedNames = [...source.matchAll(/export function (\w+)/g)].map(
    (m) => m[1] as string,
  );

  it('has at least the two documented exports', () => {
    expect(exportedNames).toContain('renderHumanView');
    expect(exportedNames).toContain('isRenderedWikiPath');
  });

  it('no exported function name contains "write"', () => {
    for (const name of exportedNames) {
      expect(name.toLowerCase()).not.toContain('write');
    }
  });

  it('no JSDoc block claims a function writes, without "never" disclaiming it', () => {
    const blocks = source.match(/\/\*\*[\s\S]*?\*\//g) ?? [];
    for (const block of blocks) {
      if (/\bwrites?\b/i.test(block)) {
        expect(block.toLowerCase()).toContain('never');
      }
    }
  });
});
