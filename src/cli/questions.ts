import type { MienguEvent } from '../core/events.js';
import type { AssumptionId, CheckpointId } from '../core/ids.js';
import type { EventLog } from '../core/log.js';
import { project } from '../state/projector.js';
import { assumptionFacts, checkpointAssumptions } from '../supervisor/assumptions.js';
import { StoreError } from '../errors.js';

export interface HumanQuestion {
  id: string;
  kind: 'assumption' | 'checkpoint';
  question: string;
  proposed: string;
  alternatives: readonly string[];
  affects: readonly string[];
  checkpoints: readonly CheckpointId[];
  editable: boolean;
}

export interface HumanResponse {
  id: string;
  answer: string;
}

function checkpointLinks(events: readonly MienguEvent[]): Map<CheckpointId, readonly AssumptionId[]> {
  const links = new Map<CheckpointId, readonly AssumptionId[]>();
  events.forEach((event, index) => {
    if (event.type === 'CheckpointRaised') links.set(event.data.checkpoint, checkpointAssumptions(event, assumptionFacts(events.slice(0, index))));
  });
  return links;
}

export function pendingQuestions(events: readonly MienguEvent[]): HumanQuestion[] {
  if (events.length === 0) return [];
  const state = project(events);
  if (state.status === 'completed' || state.status === 'failed') return [];
  const unresolved = new Set(assumptionFacts(events).filter((f) => !f.resolved).map((f) => f.id));
  const links = checkpointLinks(events);
  const questions: HumanQuestion[] = state.assumptions.filter((a) => unresolved.has(a.id)).map((a) => ({
    id: a.id, kind: 'assumption', question: a.question, proposed: a.chosen,
    alternatives: state.frozenTests === null && state.activeCauseId === null ? a.alternatives : [], affects: a.affects,
    editable: state.frozenTests === null && state.activeCauseId === null,
    checkpoints: [...links].filter(([id, ids]) => state.checkpoints[id]?.status === 'open' && ids.includes(a.id)).map(([id]) => id),
  }));
  for (const event of events) {
    if (event.type !== 'CheckpointRaised' || state.checkpoints[event.data.checkpoint]?.status !== 'open') continue;
    const ids = links.get(event.data.checkpoint) ?? [];
    if (ids.some((id) => unresolved.has(id))) continue;
    questions.push({
      id: event.data.checkpoint, kind: 'checkpoint', question: event.data.summary,
      proposed: 'accept', alternatives: ['reject'], affects: [event.data.stage],
      checkpoints: [event.data.checkpoint], editable: false,
    });
  }
  return questions;
}

/** Caller owns the EventLog lock. Revalidate each response against the durable log. */
export async function recordHumanResponse(log: EventLog, response: HumanResponse): Promise<void> {
  const events = await log.readAll();
  const question = pendingQuestions(events).find((q) => q.id === response.id);
  if (!question) throw new StoreError(`Question ${response.id} is no longer pending`);
  const answer = response.answer.trim();
  if (!answer || answer.length > 20000) throw new StoreError('Answer must contain between 1 and 20000 characters');
  if (question.kind === 'checkpoint') {
    if (answer !== 'accept' && answer !== 'reject') throw new StoreError('Checkpoint decision must be accept or reject');
    await log.append({ type: 'CheckpointDecided', data: { checkpoint: question.id as CheckpointId, decision: answer, by: 'human', reason: 'Decided in the questions panel' }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
    return;
  }
  if (!question.editable && answer !== question.proposed) throw new StoreError('Changing this answer requires a new work item because tests are frozen or remediation is active');
  await log.append({ type: 'HumanAnswerRecorded', data: { assumption_id: question.id as AssumptionId, answer }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
  const latest = await log.readAll();
  const resolved = new Set(assumptionFacts(latest).filter((f) => f.resolved).map((f) => f.id));
  const state = project(latest);
  for (const [id, ids] of checkpointLinks(latest)) {
    if (ids.length === 0 || !ids.every((a) => resolved.has(a)) || state.checkpoints[id]?.status !== 'open') continue;
    await log.append({ type: 'CheckpointDecided', data: { checkpoint: id, decision: 'accept', by: 'human', reason: 'All linked assumptions explicitly answered by the operator' }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
  }
}
