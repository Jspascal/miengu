import { describe, it, expect } from 'vitest';
import { TaskGraphSchema } from '../../src/contracts/taskGraph.js';

const VALID = {
  tasks: [
    {
      task_id: 'task-auth-1',
      title: 'Implement login endpoint',
      req_ids: ['REQ-auth-1'],
      component_ids: ['component-auth-1'],
      expected_paths: ['src/auth/login.ts'],
      depends_on: [],
      definition_of_done: ['Login endpoint returns a session token for valid credentials.'],
      estimated_turns: 5,
    },
  ],
};

describe('TaskGraphSchema', () => {
  it('parses a valid fixture', () => {
    const result = TaskGraphSchema.safeParse(VALID);
    expect(result.success).toBe(true);
  });

  it('rejects an empty tasks array', () => {
    const result = TaskGraphSchema.safeParse({ tasks: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an empty expected_paths array', () => {
    const result = TaskGraphSchema.safeParse({
      tasks: [{ ...VALID.tasks[0], expected_paths: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty definition_of_done array', () => {
    const result = TaskGraphSchema.safeParse({
      tasks: [{ ...VALID.tasks[0], definition_of_done: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects estimated_turns: 0', () => {
    const result = TaskGraphSchema.safeParse({
      tasks: [{ ...VALID.tasks[0], estimated_turns: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an extra key', () => {
    const result = TaskGraphSchema.safeParse({ ...VALID, bogus: true });
    expect(result.success).toBe(false);
  });
});
