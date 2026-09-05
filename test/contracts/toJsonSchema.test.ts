import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonSchema, jsonSchemaSha256 } from '../../src/contracts/toJsonSchema.js';
import { ContractError } from '../../src/errors.js';
import { RequirementSetSchema } from '../../src/contracts/requirementSet.js';
import { ArchitecturePlanSchema } from '../../src/contracts/architecturePlan.js';
import { TaskGraphSchema } from '../../src/contracts/taskGraph.js';
import { TestSuiteSpecDraftSchema } from '../../src/contracts/testSuiteSpec.js';
import { ImplementationSchema } from '../../src/contracts/implementation.js';
import { ReviewVerdictSchema } from '../../src/contracts/reviewVerdict.js';

const SCHEMAS = [
  { title: 'RequirementSet', schema: RequirementSetSchema },
  { title: 'ArchitecturePlan', schema: ArchitecturePlanSchema },
  { title: 'TaskGraph', schema: TaskGraphSchema },
  { title: 'TestSuiteSpecDraft', schema: TestSuiteSpecDraftSchema },
  { title: 'Implementation', schema: ImplementationSchema },
  { title: 'ReviewVerdict', schema: ReviewVerdictSchema },
] as const;

function collectObjectNodes(node: unknown, acc: Record<string, unknown>[]): void {
  if (node === null || typeof node !== 'object') {
    return;
  }
  const record = node as Record<string, unknown>;
  if (record['type'] === 'object') {
    acc.push(record);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        collectObjectNodes(item, acc);
      }
    } else {
      collectObjectNodes(value, acc);
    }
  }
}

function serialized(node: unknown): string {
  return JSON.stringify(node);
}

describe('toJsonSchema over the six agent-facing schemas', () => {
  for (const { title, schema } of SCHEMAS) {
    describe(title, () => {
      it('converts without throwing', () => {
        expect(() => toJsonSchema(schema, title)).not.toThrow();
      });

      const result = toJsonSchema(schema, title);

      it('every object node has additionalProperties: false', () => {
        const objectNodes: Record<string, unknown>[] = [];
        collectObjectNodes(result, objectNodes);
        expect(objectNodes.length).toBeGreaterThan(0);
        for (const node of objectNodes) {
          expect(node['additionalProperties']).toBe(false);
        }
      });

      it("every object node's required set-equals its properties keys", () => {
        const objectNodes: Record<string, unknown>[] = [];
        collectObjectNodes(result, objectNodes);
        for (const node of objectNodes) {
          const properties = node['properties'] as Record<string, unknown>;
          const required = node['required'] as string[];
          expect(new Set(required)).toEqual(new Set(Object.keys(properties)));
        }
      });

      it('the root is type: "object" and carries $schema + title', () => {
        expect(result['type']).toBe('object');
        expect(result['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
        expect(result['title']).toBe(title);
      });

      it('contains no $ref, no oneOf, no allOf, no "optional"', () => {
        const json = serialized(result);
        expect(json).not.toContain('$ref');
        expect(json).not.toContain('oneOf');
        expect(json).not.toContain('allOf');
        expect(json).not.toContain('optional');
      });

      it('is deterministic: two calls produce byte-identical canonicalJson', () => {
        const first = toJsonSchema(schema, title);
        const second = toJsonSchema(schema, title);
        expect(jsonSchemaSha256(first)).toBe(jsonSchemaSha256(second));
      });
    });
  }
});

describe('unsupported nodes', () => {
  it('a z.optional() throws ContractError', () => {
    const schema = z.object({ a: z.string().optional() }).strict();
    expect(() => toJsonSchema(schema, 'Bad')).toThrow(ContractError);
  });

  it('a z.union([z.string(), z.number()]) throws ContractError', () => {
    const schema = z.object({ a: z.union([z.string(), z.number()]) }).strict();
    expect(() => toJsonSchema(schema, 'Bad')).toThrow(ContractError);
  });
});
