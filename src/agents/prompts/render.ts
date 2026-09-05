import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Role } from '../../core/events.js';
import { sha256Hex } from '../../core/hash.js';
import { AgentError } from '../../errors.js';

const PROMPTS_DIR = dirname(fileURLToPath(import.meta.url));

export interface PromptTemplate {
  readonly role: Role;
  readonly path: string;
  readonly body: string;
  readonly sha256: string; // sha256 IS the version (decision 12) — no separate integer.
}

export interface RenderedPrompt {
  readonly text: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly templateSha256: string;
}

export interface PromptVars {
  readonly PACK: string;
  readonly CONTRACT: string;
  readonly TASK: string;
  readonly RETRY: string; // '' when not a retry
}

export const PROMPT_PLACEHOLDERS = ['PACK', 'CONTRACT', 'TASK', 'RETRY'] as const;

export function templatePath(role: Role): string {
  return join(PROMPTS_DIR, `${role}.md`);
}

const templateCache = new Map<Role, PromptTemplate>();

/** I/O; caches by role. */
export async function loadTemplate(role: Role): Promise<PromptTemplate> {
  const cached = templateCache.get(role);
  if (cached !== undefined) {
    return cached;
  }
  const path = templatePath(role);
  const body = await readFile(path, 'utf8');
  const template: PromptTemplate = { role, path, body, sha256: sha256Hex(body) };
  templateCache.set(role, template);
  return template;
}

/**
 * PURE. Strict both ways: an unreplaced `{{...}}` left in the output throws `AgentError`;
 * a placeholder in `PROMPT_PLACEHOLDERS` with no occurrence in the template throws
 * `AgentError`. No template engine, no partial render ever reaching a provider.
 */
export function renderPrompt(t: PromptTemplate, v: PromptVars): RenderedPrompt {
  let text = t.body;
  for (const key of PROMPT_PLACEHOLDERS) {
    const placeholder = `{{${key}}}`;
    if (!t.body.includes(placeholder)) {
      throw new AgentError(
        `template for role '${t.role}' does not contain placeholder ${placeholder}`,
        { role: t.role, placeholder },
      );
    }
    text = text.replaceAll(placeholder, v[key]);
  }

  const residual = text.match(/\{\{[^}]*\}\}/);
  if (residual !== null) {
    throw new AgentError(
      `rendered prompt for role '${t.role}' still contains an unreplaced placeholder: ${residual[0]}`,
      { role: t.role, placeholder: residual[0] },
    );
  }

  return {
    text,
    sha256: sha256Hex(text),
    bytes: new TextEncoder().encode(text).length,
    templateSha256: t.sha256,
  };
}
