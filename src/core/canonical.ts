import { CanonicalError } from '../errors.js';

function serializeValue(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  const kind = typeof value;
  if (kind === 'undefined') {
    throw new CanonicalError(`undefined is not representable in canonical JSON at ${path}`);
  }
  if (kind === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new CanonicalError(
        `non-finite number is not representable in canonical JSON at ${path}: ${String(value)}`,
      );
    }
    return JSON.stringify(value);
  }
  if (kind === 'string') {
    return JSON.stringify(value);
  }
  if (kind === 'bigint') {
    throw new CanonicalError(`BigInt is not representable in canonical JSON at ${path}`);
  }
  if (kind === 'symbol') {
    throw new CanonicalError(`symbol is not representable in canonical JSON at ${path}`);
  }
  if (kind === 'function') {
    throw new CanonicalError(`function is not representable in canonical JSON at ${path}`);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => serializeValue(item, `${path}[${index}]`));
    return `[${items.join(',')}]`;
  }
  if (value instanceof Date) {
    throw new CanonicalError(`Date is not representable in canonical JSON at ${path}`);
  }
  if (value instanceof Map) {
    throw new CanonicalError(`Map is not representable in canonical JSON at ${path}`);
  }
  if (value instanceof Set) {
    throw new CanonicalError(`Set is not representable in canonical JSON at ${path}`);
  }
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const parts: string[] = [];
    for (const key of keys) {
      const fieldValue = obj[key];
      if (fieldValue === undefined) {
        throw new CanonicalError(
          `undefined is not representable in canonical JSON at ${path}.${key}`,
        );
      }
      parts.push(`${JSON.stringify(key)}:${serializeValue(fieldValue, `${path}.${key}`)}`);
    }
    return `{${parts.join(',')}}`;
  }
  throw new CanonicalError(`unsupported value type in canonical JSON at ${path}`);
}

/** Deterministic JSON: keys sorted lexicographically at every depth, no whitespace,
 *  undefined rejected, non-finite numbers rejected, arrays order-preserved. */
export function canonicalJson(value: unknown): string {
  return serializeValue(value, '$');
}
