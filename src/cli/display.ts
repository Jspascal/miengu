import { stripVTControlCharacters } from 'node:util';
import type { MienguEvent } from '../core/events.js';
import type { AgentOutput } from '../executors/output.js';
import { createProgressReporter } from './progress.js';

export interface RunDisplay {
  onEvent: (event: MienguEvent) => void;
  onOutput: (output: AgentOutput) => void;
  close: () => void;
}

/** Provider output is untrusted terminal text (including OSC clipboard/title escapes). */
export function terminalText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

export function wrapTerminalLine(text: string, width: number): string[] {
  const result: string[] = [];
  let line = '';
  let cells = 0;
  for (const char of terminalText(text)) {
    // Conservatively reserve two cells for wide scripts and emoji.
    const size = (char.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1;
    if (cells + size > width && line.length > 0) { result.push(line); line = ''; cells = 0; }
    line += char;
    cells += size;
  }
  result.push(line);
  return result;
}

/** A bounded, scrollable dashboard; plain streams keep normal terminal scrollback. */
export function createRunDisplay(tui: boolean, quiet = false): RunDisplay {
  let closed = false;
  let opened = false;
  let item = 'Preparing';
  let stage = 'setup';
  let agent = 'waiting';
  let status = 'starting';
  let started = Date.now();
  let lastOutput = Date.now();
  let offset = 0;
  let dirty = true;
  let renderedLineCount = 0;
  const lines: string[] = [];
  const write = (text: string): void => { process.stderr.write(text); };
  const append = (text: string): void => {
    if (closed || quiet) return;
    open();
    const clean = terminalText(text);
    if (!tui) { write(`${clean}\n`); return; }
    const added = clean.split('\n');
    if (offset > 0) offset += added.length;
    lines.push(...added);
    if (lines.length > 5000) lines.splice(0, lines.length - 5000);
    dirty = true;
  };
  const report = createProgressReporter(append);
  const render = (): void => {
    if (closed || !tui || quiet) return;
    const width = Math.max(1, (process.stderr.columns || 100) - 1);
    const height = Math.max(1, (process.stderr.rows || 30) - 7);
    const wrapped = lines.flatMap((line) => wrapTerminalLine(line, width));
    renderedLineCount = wrapped.length;
    offset = Math.min(offset, Math.max(0, wrapped.length - 1));
    const end = Math.max(0, wrapped.length - offset);
    const visible = wrapped.slice(Math.max(0, end - height), end);
    const seconds = Math.floor((Date.now() - started) / 1000);
    const idle = Math.floor((Date.now() - lastOutput) / 1000);
    const frame = [
      'MIENGU | live agents',
      `${item} | ${stage}`,
      `${agent} | ${status} | ${seconds}s elapsed | last output ${idle}s ago`,
      '-'.repeat(width),
      ...visible,
      ...Array<string>(Math.max(0, height - visible.length)).fill(''),
      '-'.repeat(width),
      `Up/Down PgUp/PgDn: scroll | End: live | Ctrl-C: stop${offset ? ' | SCROLLED' : ''}`,
    ];
    write(`\x1b[H\x1b[2J${frame.map((line) => wrapTerminalLine(line, width)[0] ?? '').join('\r\n')}`);
    dirty = false;
  };
  const onKey = (chunk: Buffer): void => {
    const key = chunk.toString();
    if (key.includes('\x03')) process.emit('SIGINT');
    if (key === '\x1b[A') offset += 1;
    if (key === '\x1b[B') offset = Math.max(0, offset - 1);
    if (key === '\x1b[5~') offset += 10;
    if (key === '\x1b[6~') offset = Math.max(0, offset - 10);
    if (key === '\x1b[F' || key === '\x1b[4~') offset = 0;
    offset = Math.min(offset, Math.max(0, renderedLineCount - 1));
    render();
  };
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;
  const interactive = tui && !quiet && process.stdin.isTTY;
  let ticks = 0;
  let timer: NodeJS.Timeout | null = null;
  const open = (): void => {
    if (!tui || quiet || opened || closed) return;
    opened = true;
    write('\x1b[?1049h\x1b[?25l');
    if (interactive) {
      process.stdin.setRawMode(true);
      process.stdin.on('data', onKey);
      process.stdin.resume();
    }
    process.stderr.on('resize', render);
    render();
    timer = setInterval(() => {
      ticks += 1;
      if (dirty || ticks % 4 === 0) render();
    }, 250);
    timer.unref();
  };
  return {
    onEvent(event) {
      item = event.item_id;
      if (event.type === 'StageEntered') stage = event.data.stage;
      if (event.type === 'ExecutorInvoked') {
        agent = `${event.data.role ?? event.data.stage} / ${event.data.executor_id}`;
        status = 'running';
        started = Date.now();
        lastOutput = started;
      }
      if (event.type === 'ExecutorReturned') {
        status = event.data.status;
        append(`${agent}: ${status} | exit ${String(event.data.raw.exit_code)} | ${event.data.raw.failure_kind ?? 'no failure kind'}`);
        if (event.data.raw.transcript_path) append(`Transcript: ${event.data.raw.transcript_path}`);
        if (event.data.status !== 'completed' && event.data.raw.stderr_tail) append(event.data.raw.stderr_tail);
      }
      if (event.type === 'RunFinished') status = event.data.outcome;
      report(event);
      dirty = true;
    },
    onOutput(output) {
      lastOutput = Date.now();
      append(`[${output.executor}] ${output.kind}: ${output.text}`);
    },
    close() {
      if (closed) return;
      report.close();
      closed = true;
      if (timer) clearInterval(timer);
      if (opened) {
        process.stderr.removeListener('resize', render);
        if (interactive) {
          process.stdin.removeListener('data', onKey);
          process.stdin.setRawMode(wasRaw ?? false);
          if (wasFlowing !== true) process.stdin.pause();
        }
        write('\x1b[?25h\x1b[?1049l');
        write(`${lines.slice(-30).join('\n')}\n`);
      }
    },
  };
}
