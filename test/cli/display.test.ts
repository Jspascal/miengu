import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunDisplay, terminalText, wrapTerminalLine } from '../../src/cli/display.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('run display', () => {
  it('removes terminal control sequences from provider output', () => {
    expect(terminalText('\x1b[2Jhello\x1b]52;c;payload\x07\rworld')).toBe('helloworld');
  });
  it('wraps long replies without dropping their content', () => {
    const text = 'hello world '.repeat(50);
    expect(wrapTerminalLine(text, 30).join('')).toBe(text);
    expect(wrapTerminalLine(text, 30).every((line) => line.length <= 30)).toBe(true);
  });
  it('keeps plain output readable and suppresses output in JSON mode', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const display = createRunDisplay(false);
    display.onOutput({ executor: 'claude', kind: 'reply', text: 'Hello' });
    display.close();
    expect(write).toHaveBeenCalledWith('[claude] reply: Hello\n');
    write.mockClear();
    const quiet = createRunDisplay(false, true);
    quiet.onOutput({ executor: 'codex', kind: 'reply', text: 'Hidden' });
    quiet.close();
    expect(write).not.toHaveBeenCalled();
  });
  it('restores the terminal and removes timers and resize listeners on close', () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const before = process.stderr.listenerCount('resize');
    const display = createRunDisplay(true);
    display.onOutput({ executor: 'codex', kind: 'reply', text: 'Final reply' });
    vi.advanceTimersByTime(1000);
    expect(write.mock.calls.some(([text]) => String(text).includes('Final reply'))).toBe(true);
    display.close();
    display.close();
    expect(write).toHaveBeenCalledWith('\x1b[?25h\x1b[?1049l');
    expect(process.stderr.listenerCount('resize')).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('submits a typed answer, cancels a pending question, and restores idle stdin', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const raw = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
    const flowing = Object.getOwnPropertyDescriptor(process.stdin, 'readableFlowing');
    const setRawMode = vi.fn();
    const pause = vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: setRawMode });
    Object.defineProperty(process.stdin, 'readableFlowing', { configurable: true, value: null });
    try {
      const display = createRunDisplay(true);
      display.onOutput({ executor: 'test', kind: 'reply', text: 'Done' });
      const questions = [{ id: 'assumption-example-1', kind: 'assumption' as const, question: 'Which limit?', proposed: 'No limit', alternatives: ['100'], affects: [], checkpoints: [], editable: true }];
      const controller = new AbortController();
      const answer = display.requestAnswer(questions, controller.signal);
      process.stdin.emit('keypress', 'e', { name: 'e' });
      process.stdin.emit('keypress', '500', { name: undefined });
      process.stdin.emit('keypress', '\r', { name: 'return' });
      await expect(answer).resolves.toEqual({ id: 'assumption-example-1', answer: '500' });
      const waiting = display.requestAnswer(questions, controller.signal);
      controller.abort();
      await expect(waiting).resolves.toBeNull();
      display.close();
      expect(setRawMode).toHaveBeenLastCalledWith(false);
      expect(pause).toHaveBeenCalled();
    } finally {
      for (const [name, descriptor] of [['isTTY', tty], ['setRawMode', raw], ['readableFlowing', flowing]] as const) {
        if (descriptor) Object.defineProperty(process.stdin, name, descriptor);
        else Reflect.deleteProperty(process.stdin, name);
      }
    }
  });
});
