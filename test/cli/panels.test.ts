import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/cli/panels.js';
import type { DashboardState } from '../../src/cli/panels.js';

const state: DashboardState = {
  columns: 120, rows: 40, item: 'example', stage: 'analysis', agent: 'analyst / claude', status: 'waiting',
  elapsed: 15, idle: 2, focus: 1, activity: ['tool: Read README.md'], conversation: ['YOU', 'Build a ledger', 'AI / analyst', 'I have a question'],
  questions: [{ id: 'assumption-example-1', kind: 'assumption', question: 'Can a frozen account receive deposits?', proposed: 'No', alternatives: ['Yes'], affects: ['REQ-example-1'], checkpoints: [], editable: true }],
  selected: 0, draft: 'Yes, deposits only', waiting: true, offsets: [0, 0, 0],
};

describe('terminal panels', () => {
  it('shows pipeline, conversation, questions, activity, and answer input together', () => {
    const lines = renderDashboard(state);
    const frame = lines.join('\n');
    for (const label of ['Pipeline', 'Conversation: You / AI', 'Questions (1)', 'Activity / tools', 'Yes, deposits only', 'Build a ledger', 'Can a frozen account']) expect(frame).toContain(label);
    expect(lines.length).toBeLessThan(state.rows);
    expect(lines.every((line) => line.length < state.columns)).toBe(true);
  });
  it('uses a focused view in small terminals and removes escape sequences', () => {
    const lines = renderDashboard({ ...state, columns: 60, rows: 18, draft: '\x1b[2Janswer' });
    expect(lines.join('\n')).toContain('Questions');
    expect(lines.join('\n')).not.toContain('\x1b');
    expect(lines.every((line) => line.length < 60)).toBe(true);
    expect(lines.length).toBeLessThan(18);
  });
});
