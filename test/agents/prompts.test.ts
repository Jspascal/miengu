import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES } from '../../src/core/events.js';

const PROMPTS_DIR = join(process.cwd(), 'src/agents/prompts');

const EXPECTED_HEADINGS = [
  '## 1. ROLE',
  '## 2. INPUT',
  '## 3. CONTRACT',
  '## 4. RULES',
  '## 5. PROHIBITIONS',
  '## 6. TASK',
];

const SKELETON_SENTENCE =
  'You do not decide what happens next; you produce one artifact and stop.';

const ALLOWED_PLACEHOLDERS = new Set(['{{PACK}}', '{{CONTRACT}}', '{{TASK}}', '{{RETRY}}']);

function templatePath(role: string): string {
  return join(PROMPTS_DIR, `${role}.md`);
}

function readTemplate(role: string): string {
  return readFileSync(templatePath(role), 'utf8');
}

describe('all six role prompt templates', () => {
  for (const role of ROLES) {
    it(`${role}.md exists`, () => {
      expect(existsSync(templatePath(role))).toBe(true);
    });

    it(`${role}.md contains the six headings, byte-exact and in order`, () => {
      const body = readTemplate(role);
      let cursor = -1;
      for (const heading of EXPECTED_HEADINGS) {
        const idx = body.indexOf(heading, cursor + 1);
        expect(idx, `expected to find ${JSON.stringify(heading)} after position ${cursor}`).toBeGreaterThan(
          cursor,
        );
        cursor = idx;
      }
    });

    it(`${role}.md contains exactly the four placeholders and no other {{...}}`, () => {
      const body = readTemplate(role);
      const found = body.match(/\{\{[^}]*\}\}/g) ?? [];
      for (const placeholder of found) {
        expect(ALLOWED_PLACEHOLDERS.has(placeholder), `unexpected placeholder ${placeholder}`).toBe(
          true,
        );
      }
      for (const placeholder of ALLOWED_PLACEHOLDERS) {
        expect(found).toContain(placeholder);
      }
    });

    it(`${role}.md contains the §15.0 sentence byte-exact`, () => {
      const body = readTemplate(role);
      expect(body).toContain(SKELETON_SENTENCE);
    });

    it(`${role}.md contains no AI attribution, vendor name, or model name`, () => {
      const body = readTemplate(role).toLowerCase();
      for (const forbidden of [
        'co-authored-by',
        'generated with',
        'claude',
        'anthropic',
        'openai',
        'codex',
        'gpt-',
        'sonnet',
        'opus',
        'haiku',
      ]) {
        expect(body).not.toContain(forbidden);
      }
    });
  }
});

describe('testAuthor template load-bearing omission', () => {
  it('mentions neither "component" nor "task graph" outside its omit list', () => {
    const body = readTemplate('testAuthor');
    const lines = body.split('\n');
    const omitLineIndex = lines.findIndex((l) => l.startsWith('It deliberately omits:'));
    expect(omitLineIndex).toBeGreaterThanOrEqual(0);

    const withoutOmitLine = lines.filter((_, i) => i !== omitLineIndex).join('\n');
    expect(withoutOmitLine.toLowerCase()).not.toContain('component');
    expect(withoutOmitLine.toLowerCase()).not.toContain('task graph');
  });
});

describe('reviewer template', () => {
  it("section 5 forbids accepting to unblock the pipeline", () => {
    const body = readTemplate('reviewer');
    const section5Start = body.indexOf('## 5. PROHIBITIONS');
    const section6Start = body.indexOf('## 6. TASK');
    expect(section5Start).toBeGreaterThan(-1);
    expect(section6Start).toBeGreaterThan(section5Start);
    const section5 = body.slice(section5Start, section6Start);
    expect(section5.toLowerCase()).toContain('accept to unblock the pipeline');
  });
});
