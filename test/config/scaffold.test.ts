import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { CONFIG_TEMPLATE, renderConfigTemplate } from '../../src/config/scaffold.js';
import { MienguConfigSchema } from '../../src/config/schema.js';
import { validateConfig } from '../../src/config/validate.js';

const EXAMPLE_PATH = fileURLToPath(
  new URL('../../miengu.config.example.yaml', import.meta.url),
);

describe('CONFIG_TEMPLATE', () => {
  it('parses successfully against MienguConfigSchema', () => {
    const parsed = parseYaml(CONFIG_TEMPLATE) as unknown;
    expect(() => MienguConfigSchema.parse(parsed)).not.toThrow();
  });

  it('passes validateConfig — the shipped template must not fail its own safety check', () => {
    const parsed = MienguConfigSchema.parse(parseYaml(CONFIG_TEMPLATE));
    expect(() => validateConfig(parsed)).not.toThrow();
  });

  it('is byte-identical to the committed example file', () => {
    const onDisk = readFileSync(EXAMPLE_PATH, 'utf8');
    expect(onDisk).toBe(CONFIG_TEMPLATE);
  });

  it('does not hardcode a real target path', () => {
    expect(CONFIG_TEMPLATE).toContain('../some-project');
  });

  it('declares no stack-specific oracle command', () => {
    const parsed = MienguConfigSchema.parse(parseYaml(CONFIG_TEMPLATE));
    expect(parsed.oracles).toEqual({ build: null, test: null, lint: null, typecheck: null });
  });
});

describe('renderConfigTemplate', () => {
  it('substitutes the given target repo path', () => {
    const rendered = renderConfigTemplate({ targetRepo: '/abs/path/to/target' });
    expect(rendered).toContain('repo: /abs/path/to/target');
    expect(rendered).not.toContain('../some-project');
  });

  it('produces a document that still parses against MienguConfigSchema', () => {
    const rendered = renderConfigTemplate({ targetRepo: '/abs/path/to/target' });
    const parsed = parseYaml(rendered) as unknown;
    expect(() => MienguConfigSchema.parse(parsed)).not.toThrow();
  });
});
