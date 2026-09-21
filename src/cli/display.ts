import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { MienguEvent } from '../core/events.js';
import { project } from '../state/projector.js';
import type { AgentOutput } from '../executors/output.js';
import type { HumanQuestion, HumanResponse } from './questions.js';
import { createProgressReporter, formatProgressEvent } from './progress.js';
import { renderDashboard, terminalText, wrapTerminalLine } from './panels.js';
export { terminalText, wrapTerminalLine } from './panels.js';

export interface RunDisplay {
  readonly interactive: boolean;
  onEvent: (event: MienguEvent) => void;
  onOutput: (output: AgentOutput) => void;
  conversation: (speaker: string, text: string) => void;
  history: (events: readonly MienguEvent[]) => void;
  requestAnswer: (questions: readonly HumanQuestion[], signal: AbortSignal) => Promise<HumanResponse | null>;
  close: () => void;
}

export function createRunDisplay(tui: boolean, quiet = false): RunDisplay {
  let closed = false;
  let opened = false;
  let item = 'Preparing';
  let stage = 'setup';
  let agent = 'waiting';
  let status = 'starting';
  let started = Date.now();
  let lastOutput = Date.now();
  let dirty = true;
  let focus = 0;
  const offsets = [0, 0, 0];
  const activity: string[] = [];
  const conversation: string[] = [];
  let questions: readonly HumanQuestion[] = [];
  let selected = 0;
  let draft = '';
  let draftActive = false;
  let finishAnswer: ((response: HumanResponse | null) => void) | null = null;
  let lastReply = '';
  const shownQuestions = new Set<string>();
  const interactive = tui && !quiet && process.stdin.isTTY === true;
  const write = (text: string): void => { process.stderr.write(text); };
  const append = (text: string, target = activity): void => {
    if (closed || quiet) return;
    open();
    const clean = terminalText(text);
    if (!tui) { write(`${clean}\n`); return; }
    target.push(...clean.split('\n'));
    if (target.length > 5000) target.splice(0, target.length - 5000);
    dirty = true;
  };
  const message = (speaker: string, text: string): void => { append(`${speaker.toUpperCase()}\n${text}\n`, conversation); };
  const report = createProgressReporter((line) => append(line));
  const render = (): void => {
    if (closed || !opened || !tui || quiet) return;
    const frame = renderDashboard({
      columns: process.stderr.columns || 100, rows: process.stderr.rows || 30,
      item, stage, agent, status, elapsed: Math.floor((Date.now() - started) / 1000),
      idle: Math.floor((Date.now() - lastOutput) / 1000), focus,
      activity, conversation, questions, selected, draft: draftActive ? draft : '',
      waiting: finishAnswer !== null, offsets,
    });
    write(`\x1b[H\x1b[2J${frame.join('\r\n')}`);
    dirty = false;
  };
  const onKey = (text: string | undefined, key: Key): void => {
    if (key.ctrl && key.name === 'c') { process.emit('SIGINT'); return; }
    if (key.name === 'tab') { focus = (focus + (key.shift ? 2 : 1)) % 3; render(); return; }
    if (key.name === 'escape') {
      if (draftActive) { draftActive = false; draft = ''; }
      else if (finishAnswer) { finishAnswer(null); process.emit('SIGINT'); }
      render(); return;
    }
    if (focus === 1 && finishAnswer) {
      const question = questions[selected];
      if (!question) return;
      if (key.name === 'up' || key.name === 'down') {
        selected = Math.max(0, Math.min(questions.length - 1, selected + (key.name === 'up' ? -1 : 1)));
        draft = ''; draftActive = false;
      } else if (key.name === 'return') {
        const answer = draftActive ? draft.trim() : question.proposed;
        if (answer) finishAnswer({ id: question.id, answer });
      } else if (key.name === 'backspace') {
        draft = Array.from(draft).slice(0, -1).join(''); draftActive = true;
      } else if (!draftActive && key.name === 'e' && question.editable) {
        draft = ''; draftActive = true;
      } else if (!draftActive && text && /^[1-9]$/.test(text)) {
        const choice = [question.proposed, ...question.alternatives][Number(text) - 1];
        if (choice) { draft = choice; draftActive = true; }
      } else if (draftActive && text && !key.ctrl && !key.meta && question.editable) {
        draft = (draft + terminalText(text).replace(/\n/g, ' ')).slice(0, 20000);
        draftActive = true;
      }
    } else {
      const index = focus === 2 ? 2 : 0;
      const count = (index === 2 ? activity : conversation).flatMap((line) => wrapTerminalLine(line, Math.max(10, (process.stderr.columns || 100) - 34))).length;
      if (key.name === 'up' || key.name === 'pageup') offsets[index] = Math.min(count, (offsets[index] ?? 0) + (key.name === 'up' ? 1 : 10));
      if (key.name === 'down' || key.name === 'pagedown') offsets[index] = Math.max(0, (offsets[index] ?? 0) - (key.name === 'down' ? 1 : 10));
      if (key.name === 'end') offsets[index] = 0;
    }
    render();
  };
  const wasRaw = process.stdin.isRaw;
  const wasFlowing = process.stdin.readableFlowing;
  let ticks = 0;
  let timer: NodeJS.Timeout | null = null;
  const open = (): void => {
    if (!tui || quiet || opened || closed) return;
    opened = true;
    write('\x1b[?1049h\x1b[?25l');
    if (interactive) {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.on('keypress', onKey);
      process.stdin.resume();
    }
    process.stderr.on('resize', render);
    render();
    timer = setInterval(() => { ticks += 1; if (dirty || ticks % 4 === 0) render(); }, 250);
    timer.unref();
  };
  return {
    interactive,
    conversation: message,
    history(events) {
      if (events.length > 0) {
        const state = project(events);
        stage = state.stage;
        status = state.status;
      }
      for (const event of events) {
        item = event.item_id;
        const line = formatProgressEvent(event);
        if (line) append(line);
        if (event.type === 'StageCompleted' && event.data.artifact) message(`AI / ${event.data.stage}`, JSON.stringify(event.data.artifact.body, null, 2));
        if (event.type === 'HumanAnswerRecorded') message('You', event.data.answer);
        if (event.type === 'CheckpointDecided') message('You', `${event.data.checkpoint}: ${event.data.decision}`);
      }
    },
    onEvent(event) {
      item = event.item_id;
      if (event.type === 'StageEntered') stage = event.data.stage;
      if (event.type === 'ExecutorInvoked') {
        agent = `${event.data.role ?? event.data.stage} / ${event.data.executor_id}`;
        status = 'running'; started = Date.now(); lastOutput = started; lastReply = '';
      }
      if (event.type === 'ExecutorReturned') {
        status = event.data.status;
        append(`${agent}: ${status} | exit ${String(event.data.raw.exit_code)}`);
        if (event.data.raw.transcript_path) append(`Transcript: ${event.data.raw.transcript_path}`);
        if (event.data.status !== 'completed' && event.data.raw.stderr_tail) append(event.data.raw.stderr_tail);
      }
      if (event.type === 'HumanAnswerRecorded') message('You', event.data.answer);
      if (event.type === 'CheckpointDecided') message('You', `${event.data.checkpoint}: ${event.data.decision}`);
      if (event.type === 'RunFinished') status = event.data.outcome;
      report(event); dirty = true;
    },
    onOutput(output) {
      lastOutput = Date.now();
      if (output.kind === 'reply') {
        const identity = `${output.executor}\0${output.text}`;
        if (identity !== lastReply) {
          if (tui) message(`AI / ${output.executor}`, output.text);
          else append(`[${output.executor}] reply: ${output.text}`);
          lastReply = identity;
        }
      } else append(`[${output.executor}] ${output.kind}: ${output.text}`);
    },
    requestAnswer(pending, signal) {
      if (!interactive || closed || signal.aborted || pending.length === 0) return Promise.resolve(null);
      if (finishAnswer) throw new Error('Only one question interaction may be active');
      for (const question of pending) {
        if (!shownQuestions.has(question.id)) {
          message('AI / question', `${question.question}\nProposed: ${question.proposed}\n${question.alternatives.map((a, index) => `${index + 2}. ${a}`).join('\n')}`);
          shownQuestions.add(question.id);
        }
      }
      questions = pending; selected = 0; draft = ''; draftActive = false; focus = 1; status = 'waiting for your answer';
      open();
      return new Promise((resolve) => {
        const cancel = (): void => { finishAnswer?.(null); };
        finishAnswer = (response) => {
          signal.removeEventListener('abort', cancel);
          finishAnswer = null; questions = []; draft = ''; draftActive = false;
          status = response ? 'saving answer' : 'paused'; dirty = true; resolve(response);
        };
        signal.addEventListener('abort', cancel, { once: true });
        render();
      });
    },
    close() {
      if (closed) return;
      finishAnswer?.(null);
      report.close(); closed = true;
      if (timer) clearInterval(timer);
      if (opened) {
        process.stderr.removeListener('resize', render);
        if (interactive) {
          process.stdin.removeListener('keypress', onKey);
          process.stdin.setRawMode(wasRaw ?? false);
          if (wasFlowing !== true) process.stdin.pause();
        }
        write('\x1b[?25h\x1b[?1049l');
        write(`${activity.slice(-20).join('\n')}\n`);
      }
    },
  };
}
