import { describe, it, expect } from 'vitest';
import { assertSandboxSupported } from '../../src/executors/executor.js';
import type { ExecutorCapabilities } from '../../src/executors/executor.js';
import { ConfigError } from '../../src/errors.js';
import { ExecutorInstanceIdSchema } from '../../src/core/ids.js';

const id = ExecutorInstanceIdSchema.parse('cc-sonnet');

const CAPS: ExecutorCapabilities = {
  nativeStructuredOutput: false,
  resumableSessions: true,
  sandboxModes: ['workspace-write'],
};

describe('assertSandboxSupported', () => {
  it('throws ConfigError naming the instance id, type and intent when the intent is unsupported', () => {
    try {
      assertSandboxSupported(id, 'claude-code', CAPS, 'read-only');
      expect.unreachable('expected assertSandboxSupported to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('cc-sonnet');
      expect(message).toContain('claude-code');
      expect(message).toContain('read-only');
    }
  });

  it('returns silently for a supported intent', () => {
    expect(() => {
      assertSandboxSupported(id, 'claude-code', CAPS, 'workspace-write');
    }).not.toThrow();
  });
});
