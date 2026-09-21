import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../../src/core/log.js';
import { createIdMinter, fixedRng } from '../../src/core/idgen.js';
import { fixedClock } from '../../src/core/clock.js';
import { AssumptionIdSchema, CheckpointIdSchema, SlugSchema } from '../../src/core/ids.js';
import { silentLogger } from '../../src/logging.js';
import { pendingQuestions, recordHumanResponse } from '../../src/cli/questions.js';
import { project } from '../../src/state/projector.js';
import { assumptionFacts } from '../../src/supervisor/assumptions.js';
import { deriveClaims } from '../../src/wiki/records.js';

let dir: string;
let log: EventLog;
const id = AssumptionIdSchema.parse('assumption-example-1');
const second = AssumptionIdSchema.parse('assumption-example-2');
const checkpoint = CheckpointIdSchema.parse('cp-example-1');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'miengu-questions-'));
  const ids = createIdMinter(fixedRng('questions'));
  ({ log } = await EventLog.create({ storeDir: dir, itemId: ids.workItemId(SlugSchema.parse('example')), runId: ids.runId(), clock: fixedClock('2024-01-01T00:00:00.000Z'), ids, logger: silentLogger }));
  await log.append({ type: 'WorkItemCreated', data: { title: 'Example', slug: SlugSchema.parse('example'), source: { kind: 'prd-file', path: 'example.md', sha256: 'a'.repeat(64), bytes: 1 }, config_hash: 'config' }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
  await log.append({ type: 'StageCompleted', data: { stage: 'analysis', attempt: 1, artifact: { kind: 'requirement-set', sha256: 'a'.repeat(64), body: { requirements: [], ambiguities: [], out_of_scope: [] } } }, actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId });
  for (const assumptionId of [id, second]) await log.append({ type: 'AssumptionRecorded', data: { id: assumptionId, question: `Which policy for ${assumptionId}?`, chosen: 'Proposed policy', alternatives: ['Alternative policy'], affects: ['REQ-example-1'], depth: 1 }, actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId });
});
afterEach(async () => { await log.close(); await rm(dir, { recursive: true, force: true }); });

async function raise(kind: 'escalation' | 'assumption-gate', summary: string): Promise<void> {
  await log.append({ type: 'CheckpointRaised', data: { checkpoint, kind, stage: 'analysis', summary, blocking: true, sla_seconds: null, default_decision: null }, actor: { kind: 'supervisor', id: null }, causationId: log.lastEventId });
}

describe('durable human answers', () => {
  it('answers a legacy escalation and resolves only its linked assumption', async () => {
    await raise('escalation', `assumption '${id}' escalates at depth 2`);
    await recordHumanResponse(log, { id, answer: 'Proposed policy' });
    const events = await log.readAll();
    expect(project(events).checkpoints[checkpoint]?.status).toBe('accepted');
    expect(pendingQuestions(events).map((q) => q.id)).toEqual([second]);
    expect(assumptionFacts(events).find((f) => f.id === id)?.resolved).toBe(true);
    expect(project(events).artifacts.requirementSet).not.toBeNull();
    expect(events.find((e) => e.type === 'HumanAnswerRecorded')?.tier).toBe('T0');
  });
  it('invalidates stale planning on a changed answer, preserving the original event', async () => {
    const artifactId = project(await log.readAll()).artifacts.requirementSet!.eventId;
    await recordHumanResponse(log, { id, answer: 'Alternative policy' });
    const events = await log.readAll();
    const state = project(events);
    expect(state.stage).toBe('analysis');
    expect(state.artifacts.requirementSet).toBeNull();
    expect(state.invalidatedEventIds).toContain(artifactId);
    expect(state.assumptions[0]?.chosen).toBe('Alternative policy');
    expect(events.find((e) => e.type === 'AssumptionRecorded' && e.data.id === id)?.data).toMatchObject({ chosen: 'Proposed policy' });
    expect(deriveClaims(events).claims.find((c) => c.subject === id)?.status).toBe('invalidated');
  });
  it('keeps an aggregate gate open until every linked question is answered', async () => {
    await raise('assumption-gate', `assumption gate: ${id}, ${second} unresolved`);
    await recordHumanResponse(log, { id, answer: 'Proposed policy' });
    expect(project(await log.readAll()).checkpoints[checkpoint]?.status).toBe('open');
    await recordHumanResponse(log, { id: second, answer: 'Proposed policy' });
    expect(project(await log.readAll()).checkpoints[checkpoint]?.status).toBe('accepted');
    expect(pendingQuestions(await log.readAll())).toEqual([]);
  });
  it('refuses empty, stale, and unknown responses without appending', async () => {
    const before = log.lastSeq;
    await expect(recordHumanResponse(log, { id, answer: '  ' })).rejects.toThrow('Answer must');
    await expect(recordHumanResponse(log, { id: 'missing', answer: 'yes' })).rejects.toThrow('no longer pending');
    expect(log.lastSeq).toBe(before);
    await recordHumanResponse(log, { id, answer: 'Proposed policy' });
    await expect(recordHumanResponse(log, { id, answer: 'Alternative policy' })).rejects.toThrow('no longer pending');
  });
  it('recognizes accepted historical escalation checkpoints without asking again', async () => {
    await raise('escalation', `assumption '${id}' escalates at depth 2`);
    await log.append({ type: 'CheckpointDecided', data: { checkpoint, decision: 'accept', by: 'human', reason: null }, actor: { kind: 'human', id: null }, causationId: log.lastEventId });
    expect(pendingQuestions(await log.readAll()).map((q) => q.id)).toEqual([second]);
  });
});
