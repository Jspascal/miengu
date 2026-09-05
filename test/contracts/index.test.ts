import { describe, it, expect } from 'vitest';
import { ARTIFACT_KINDS, ROLES } from '../../src/core/events.js';
import { stageForRole } from '../../src/state/workitem.js';
import { toJsonSchema } from '../../src/contracts/toJsonSchema.js';
import { CONTRACTS, contractFor } from '../../src/contracts/index.js';
import { TestSuiteSpecSchema } from '../../src/contracts/testSuiteSpec.js';

describe('CONTRACTS', () => {
  it('Object.keys(CONTRACTS) set-equals ROLES', () => {
    expect(new Set(Object.keys(CONTRACTS))).toEqual(new Set(ROLES));
  });

  it("each binding's stage === stageForRole(role)", () => {
    for (const role of ROLES) {
      expect(CONTRACTS[role].stage).toBe(stageForRole(role));
    }
  });

  it('each artifactKind is a member of ARTIFACT_KINDS', () => {
    for (const role of ROLES) {
      expect(ARTIFACT_KINDS).toContain(CONTRACTS[role].artifactKind);
    }
  });

  it('toJsonSchema succeeds for all six bindings', () => {
    for (const role of ROLES) {
      const binding = CONTRACTS[role];
      expect(() => toJsonSchema(binding.schema, binding.title)).not.toThrow();
    }
  });

  it('testAuthor binds the draft form, not the frozen TestSuiteSpecSchema', () => {
    expect(CONTRACTS.testAuthor.schema).not.toBe(TestSuiteSpecSchema);
  });
});

describe('contractFor', () => {
  it('returns the same binding as CONTRACTS[role] for every role', () => {
    for (const role of ROLES) {
      expect(contractFor(role)).toBe(CONTRACTS[role]);
    }
  });
});
