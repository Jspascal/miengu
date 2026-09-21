import { describe, expect, it } from 'vitest';
import { decodeOutput, providerError } from '../../src/executors/output.js';

describe('provider output', () => {
  it('extracts stdout-only failures from both providers', () => {
    expect(providerError({ type: 'turn.failed', error: { message: 'Authentication failed' } })).toBe('Authentication failed');
    expect(providerError({ type: 'result', is_error: true, errors: ['Turn limit reached'] })).toContain('Turn limit reached');
    expect(providerError({ type: 'result', subtype: 'success', result: 'answer' })).toBe('');
  });
  it('shows public reasoning summaries, tool calls, and replies', () => {
    expect(decodeOutput({ type: 'item.completed', item: { type: 'reasoning', text: 'Checking the tests' } }))
      .toEqual([{ kind: 'reasoning', text: 'Checking the tests' }]);
    expect(decodeOutput({ type: 'assistant', message: { content: [
      { type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } },
      { type: 'text', text: 'Done' },
    ] } })).toEqual([
      { kind: 'tool', text: 'Read {"file_path":"README.md"}' },
      { kind: 'reply', text: 'Done' },
    ]);
  });
  it('tolerates unknown and malformed events', () => {
    expect(decodeOutput(null)).toEqual([]);
    expect(decodeOutput({ type: 'assistant', message: { content: [null] } })).toEqual([]);
  });
});
