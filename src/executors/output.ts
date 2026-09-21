/** Observability only: these notifications never participate in supervisor decisions. */
export interface AgentOutput {
  executor: string;
  kind: 'activity' | 'reply' | 'reasoning' | 'tool' | 'error';
  text: string;
}

export type OutputListener = (output: AgentOutput) => void;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function providerError(value: unknown): string {
  const event = record(value);
  const parts = [event['message'], event['error'], event['errors']];
  if (event['is_error'] === true || String(event['subtype']).startsWith('error')) {
    parts.push(event['result'], event['subtype']);
  }
  return parts.flatMap((part): string[] => {
    if (typeof part === 'string') return [part];
    if (Array.isArray(part)) return part.flatMap((entry) => typeof entry === 'string' ? [entry] : []);
    const message = record(part)['message'];
    return typeof message === 'string' ? [message] : [];
  }).filter(Boolean).join('\n');
}

/** Decode only public CLI stream fields; no attempt to recover hidden reasoning. */
export function decodeOutput(value: unknown): Omit<AgentOutput, 'executor'>[] {
  const event = record(value);
  const type = event['type'];
  const output: Omit<AgentOutput, 'executor'>[] = [];
  const add = (kind: AgentOutput['kind'], text: unknown): void => {
    if (typeof text === 'string' && text.length > 0) output.push({ kind, text });
  };
  if (type === 'assistant') {
    const content = record(event['message'])['content'];
    if (Array.isArray(content)) for (const value of content) {
      const block = record(value);
      if (block['type'] === 'text') add('reply', block['text']);
      if (block['type'] === 'thinking') add('reasoning', block['thinking']);
      if (block['type'] === 'tool_use') add('tool', `${String(block['name'])} ${JSON.stringify(block['input'] ?? {})}`);
    }
  } else if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
    const item = record(event['item']);
    if (item['type'] === 'agent_message') add('reply', item['text']);
    else if (item['type'] === 'reasoning') add('reasoning', item['text']);
    else if (item['type'] === 'error') add('error', item['message']);
    else {
      add('tool', `${text(item['type']) || 'tool'} ${text(item['command']) || text(item['tool'])} ${text(item['status'])}`);
      add('tool', item['aggregated_output']);
    }
  } else if (type === 'error' || type === 'turn.failed' || (type === 'result' && event['is_error'] === true)) {
    add('error', providerError(event));
  } else if (type === 'result') {
    add('reply', event['result']);
  } else if (type === 'system' || type === 'thread.started' || type === 'turn.started') {
    add('activity', text(event['subtype']) || text(type));
  }
  return output;
}

export function emitOutput(listener: OutputListener | undefined, output: AgentOutput): void {
  // Rendering errors must never strand a child process or alter its result.
  try { listener?.(output); } catch { /* best-effort display */ }
}
