import { stripVTControlCharacters } from 'node:util';
import type { HumanQuestion } from './questions.js';

export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').replace(/\t/g, '    ');
}

function charWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === '\u200d' || char === '\ufe0f') return 0;
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 && (code <= 0x115f || code >= 0x2e80 && code <= 0xa4cf || code >= 0xac00 && code <= 0xd7a3 || code >= 0xf900 && code <= 0xfaff || code >= 0xfe10 && code <= 0xff60 || code >= 0x1f000) ? 2 : 1;
}

export function wrapTerminalLine(text: string, width: number): string[] {
  const result: string[] = [];
  let line = ''; let cells = 0;
  for (const char of terminalText(text)) {
    const size = charWidth(char);
    if (cells + size > width && line.length > 0) { result.push(line); line = ''; cells = 0; }
    if (size > width) continue;
    line += char; cells += size;
  }
  result.push(line);
  return result;
}

function fit(text: string, width: number): string {
  const clipped = wrapTerminalLine(text, width)[0] ?? '';
  return clipped + ' '.repeat(Math.max(0, width - Array.from(clipped).reduce((sum, char) => sum + charWidth(char), 0)));
}

function box(title: string, lines: readonly string[], width: number, height: number, offset = 0, tail = false): string[] {
  const inner = Math.max(1, width - 2);
  const rows = Math.max(0, height - 2);
  const content = lines.flatMap((line) => wrapTerminalLine(line, inner));
  const start = tail ? Math.max(0, content.length - rows - Math.min(offset, Math.max(0, content.length - rows))) : offset;
  const visible = content.slice(start, start + rows);
  return [`+${fit(` ${title} `, inner).replace(/ +$/, (spaces) => '-'.repeat(spaces.length))}+`,
    ...Array.from({ length: rows }, (_, index) => `|${fit(visible[index] ?? '', inner)}|`), `+${'-'.repeat(inner)}+`];
}

export interface DashboardState {
  columns: number; rows: number; item: string; stage: string; agent: string; status: string;
  elapsed: number; idle: number; focus: number; activity: readonly string[]; conversation: readonly string[];
  questions: readonly HumanQuestion[]; selected: number; draft: string; waiting: boolean; offsets: readonly number[];
}

export function renderDashboard(s: DashboardState): string[] {
  const width = Math.max(12, s.columns - 1);
  const height = Math.max(8, s.rows - 1);
  const selected = s.questions[s.selected];
  const questionLines = selected ? [selected.question, `Affects: ${selected.affects.join(', ') || 'this item'}`,
    ...[selected.proposed, ...selected.alternatives].map((choice, index) => `${index + 1}. ${choice}`)] : ['No unanswered questions.'];
  const header = [`MIENGU | ${s.item}`, `${s.agent} | ${s.status} | ${s.elapsed}s | last output ${s.idle}s ago`];
  const footer = 'Tab: panel  Arrows/PgUp/PgDn: navigate  End: live  Ctrl-C: stop';
  if (width < 78 || height < 22) {
    const title = ['Conversation', 'Questions', 'Activity'][s.focus] ?? 'Conversation';
    const lines = s.focus === 1 ? [...questionLines, `Answer: ${s.draft || '(Enter accepts proposal)'}`] : s.focus === 2 ? s.activity : s.conversation;
    return [...header, ...box(title, lines, width, height - 3, s.offsets[s.focus] ?? 0, s.focus !== 1), footer].map((line) => fit(line, width));
  }
  const answerHeight = s.waiting ? Math.min(11, Math.floor(height / 3)) : 3;
  const bodyHeight = height - answerHeight - 3;
  const leftWidth = 29;
  const rightWidth = width - leftWidth - 1;
  const pipeline = ['intake', 'analysis', 'architecture', 'planning', 'test-authoring', 'implementation', 'review', 'integration', 'done'].map((stage) => `${stage === s.stage ? '>' : ' '} ${stage}`);
  const pipelineHeight = Math.min(12, Math.floor(bodyHeight * 0.6));
  const pipelineStart = Math.max(0, pipeline.findIndex((line) => line.startsWith('>')) - pipelineHeight + 3);
  const listStart = Math.max(0, s.selected - Math.max(0, bodyHeight - pipelineHeight - 4));
  const left = [...box('Pipeline', pipeline, leftWidth, pipelineHeight, pipelineStart), ...box(`${s.focus === 1 ? '*' : ''} Questions (${s.questions.length})`, s.questions.length ? s.questions.map((q, index) => `${index === s.selected ? '>' : ' '} ${q.id}`) : ['No pending questions'], leftWidth, bodyHeight - pipelineHeight, listStart)];
  const chatHeight = Math.max(4, Math.floor(bodyHeight * 0.65));
  const right = [...box(`${s.focus === 0 ? '*' : ''} Conversation: You / AI`, s.conversation, rightWidth, chatHeight, s.offsets[0] ?? 0, true), ...box(`${s.focus === 2 ? '*' : ''} Activity / tools`, s.activity, rightWidth, bodyHeight - chatHeight, s.offsets[2] ?? 0, true)];
  const input = s.waiting ? [...questionLines, `Answer: ${s.draft || '(proposed answer selected)'}`,
    selected?.editable ? 'e: custom answer  1-9: option  Enter: save  Esc: clear / park' : 'Select 1-9; Enter confirms. Esc parks.'] : ['Answers appear here when an agent needs your decision.'];
  const wrappedInput = input.flatMap((line) => wrapTerminalLine(line, width - 2));
  const answerLines = wrappedInput.length > answerHeight - 2 ? [...wrappedInput.slice(0, answerHeight - 4), ...wrappedInput.slice(-2)] : wrappedInput;
  return [...header, ...left.map((line, index) => `${line} ${right[index] ?? ''}`), ...box(s.waiting ? 'Your answer (saved to this work item)' : 'Input', answerLines, width, answerHeight), footer].map((line) => fit(line, width));
}
