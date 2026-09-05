import { describe, it, expect } from 'vitest';
import { AgentError } from '../../src/errors.js';
import {
  loadTemplate,
  renderPrompt,
  templatePath,
  PROMPT_PLACEHOLDERS,
} from '../../src/agents/prompts/render.js';
import type { PromptTemplate, PromptVars } from '../../src/agents/prompts/render.js';

const VARS: PromptVars = {
  PACK: 'the assembled pack',
  CONTRACT: '{"type":"object"}',
  TASK: 'do the thing',
  RETRY: '',
};

function fakeTemplate(body: string): PromptTemplate {
  return { role: 'analyst', path: templatePath('analyst'), body, sha256: 'deadbeef' };
}

describe('templatePath', () => {
  it('points at a .md file under src/agents/prompts named after the role', () => {
    expect(templatePath('coder')).toMatch(/agents[/\\]prompts[/\\]coder\.md$/);
  });
});

describe('loadTemplate', () => {
  it('loads and hashes each of the six role templates', async () => {
    for (const role of ['analyst', 'architect', 'planner', 'testAuthor', 'coder', 'reviewer'] as const) {
      const template = await loadTemplate(role);
      expect(template.role).toBe(role);
      expect(template.body.length).toBeGreaterThan(0);
      expect(template.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('renderPrompt', () => {
  it('rendering with all four vars produces no residual {{', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}} {{RETRY}}');
    const rendered = renderPrompt(template, VARS);
    expect(rendered.text).not.toMatch(/\{\{/);
    expect(rendered.text).toBe('the assembled pack {"type":"object"} do the thing ');
  });

  it('omitting {{RETRY}} from a template throws', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}}');
    expect(() => renderPrompt(template, VARS)).toThrow(AgentError);
  });

  it('a template with an extra {{FOO}} throws', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}} {{RETRY}} {{FOO}}');
    expect(() => renderPrompt(template, VARS)).toThrow(AgentError);
  });

  it('the same template + vars twice produce identical sha256', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}} {{RETRY}}');
    const first = renderPrompt(template, VARS);
    const second = renderPrompt(template, VARS);
    expect(first.sha256).toBe(second.sha256);
    expect(first.text).toBe(second.text);
  });

  it('the sha256 changes when one var changes by one byte', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}} {{RETRY}}');
    const first = renderPrompt(template, VARS);
    const second = renderPrompt(template, { ...VARS, TASK: `${VARS.TASK}!` });
    expect(first.sha256).not.toBe(second.sha256);
  });

  it('records templateSha256 and byte length', () => {
    const template = fakeTemplate('{{PACK}} {{CONTRACT}} {{TASK}} {{RETRY}}');
    const rendered = renderPrompt(template, VARS);
    expect(rendered.templateSha256).toBe(template.sha256);
    expect(rendered.bytes).toBe(new TextEncoder().encode(rendered.text).length);
  });

  it('PROMPT_PLACEHOLDERS is exactly the four-key set', () => {
    expect([...PROMPT_PLACEHOLDERS].sort()).toEqual(['CONTRACT', 'PACK', 'RETRY', 'TASK']);
  });
});
