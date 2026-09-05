import { z } from 'zod';
import { ContractError } from '../errors.js';
import { sha256Canonical } from '../core/hash.js';

export interface JsonSchemaObject {
  readonly [k: string]: unknown;
}

function typeNameOf(schema: z.ZodTypeAny): string {
  return (schema as unknown as { _def: { typeName: string } })._def.typeName;
}

/**
 * A restricted, hand-written walker over exactly the zod constructs the six §4 contract
 * schemas use. Anything else throws `ContractError` rather than degrading silently.
 * Emits the OpenAI structured-output subset `codex exec --output-schema` accepts.
 */
function nodeToJsonSchema(schema: z.ZodTypeAny, path: string): Record<string, unknown> {
  const typeName = typeNameOf(schema);

  if (typeName === 'ZodObject') {
    const object = schema as unknown as z.ZodObject<z.ZodRawShape>;
    const shape = object.shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const key of Object.keys(shape)) {
      const value = shape[key];
      if (value === undefined) {
        continue;
      }
      properties[key] = nodeToJsonSchema(value, `${path}.${key}`);
      required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }

  if (typeName === 'ZodArray') {
    const array = schema as unknown as z.ZodArray<z.ZodTypeAny>;
    const items = nodeToJsonSchema(array.element, `${path}[]`);
    const result: Record<string, unknown> = { type: 'array', items };
    if (array._def.minLength !== null) {
      result['minItems'] = array._def.minLength.value;
    }
    return result;
  }

  if (typeName === 'ZodString') {
    const string_ = schema as unknown as z.ZodString;
    const result: Record<string, unknown> = { type: 'string' };
    for (const check of string_._def.checks) {
      if (check.kind === 'regex') {
        result['pattern'] = check.regex.source;
      } else if (check.kind === 'min') {
        result['minLength'] = check.value;
      } else if (check.kind === 'datetime') {
        result['format'] = 'date-time';
      }
    }
    return result;
  }

  if (typeName === 'ZodNumber') {
    const number_ = schema as unknown as z.ZodNumber;
    let isInt = false;
    let exclusiveMinZero = false;
    for (const check of number_._def.checks) {
      if (check.kind === 'int') {
        isInt = true;
      } else if (check.kind === 'min' && check.value === 0 && !check.inclusive) {
        exclusiveMinZero = true;
      }
    }
    const result: Record<string, unknown> = { type: isInt ? 'integer' : 'number' };
    if (exclusiveMinZero) {
      result['exclusiveMinimum'] = 0;
    }
    return result;
  }

  if (typeName === 'ZodBoolean') {
    return { type: 'boolean' };
  }

  if (typeName === 'ZodEnum') {
    const enum_ = schema as unknown as z.ZodEnum<[string, ...string[]]>;
    return { type: 'string', enum: [...enum_.options] };
  }

  if (typeName === 'ZodNullable') {
    const nullable = schema as unknown as z.ZodNullable<z.ZodTypeAny>;
    const inner = nodeToJsonSchema(nullable.unwrap(), path);
    if (inner['type'] === 'object' || inner['type'] === 'array') {
      return { anyOf: [inner, { type: 'null' }] };
    }
    const { type, ...rest } = inner;
    return { type: [type, 'null'], ...rest };
  }

  if (typeName === 'ZodBranded') {
    const branded = schema as unknown as z.ZodBranded<z.ZodTypeAny, string>;
    return nodeToJsonSchema(branded.unwrap(), path);
  }

  if (typeName === 'ZodLiteral') {
    const literal = schema as unknown as z.ZodLiteral<string | number | boolean>;
    const value = literal.value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { type: typeof value, const: value };
    }
    throw new ContractError(`unsupported zod node: ZodLiteral with non-primitive value at ${path}`);
  }

  throw new ContractError(`unsupported zod node: ${typeName} at ${path}`);
}

export function toJsonSchema(schema: z.ZodTypeAny, title: string): JsonSchemaObject {
  const body = nodeToJsonSchema(schema, '$');
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    ...body,
  };
}

export function jsonSchemaSha256(s: JsonSchemaObject): string {
  return sha256Canonical(s);
}
