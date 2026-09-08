#!/usr/bin/env node
// Stands in for the `codex` binary in tests. Never contacts the network. Behaviour is
// selected by FAKE_CODEX_MODE so codexCli.test.ts never has to invoke a real provider.
//
// This fixture is an ORACLE, not a stub: when `--output-schema <FILE>` is passed it
// verifies the file obeys the OpenAI structured-output subset `codex exec --output-schema`
// actually accepts (§3.5), and exits nonzero on the first violation. That machine-checks
// `toJsonSchema`'s contract against a consumer, not only against itself.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function drainStdin() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on('data', () => {
      // the prompt is not used by any fixture mode; just drain it
    });
    process.stdin.on('end', resolve);
  });
}

const THREAD_ID = '01a06e8b-8f90-7c61-b1ff-13b87efdcb9f';

// Verifies exactly the invariants `toJsonSchema` promises (§3.5): root `type: "object"`,
// `additionalProperties: false` on every object node, every object's `required` set-equals
// its `properties` keys, and no `$ref` / `oneOf` / `allOf` anywhere.
function checkSchemaNode(node, path) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => {
      checkSchemaNode(item, `${path}[${String(i)}]`);
    });
    return;
  }
  if (node === null || typeof node !== 'object') {
    return;
  }
  if ('$ref' in node) {
    throw new Error(`$ref is not allowed at ${path}`);
  }
  if ('oneOf' in node) {
    throw new Error(`oneOf is not allowed at ${path}`);
  }
  if ('allOf' in node) {
    throw new Error(`allOf is not allowed at ${path}`);
  }
  if (node.type === 'object') {
    if (node.additionalProperties !== false) {
      throw new Error(`additionalProperties must be false at ${path}`);
    }
    const propertyKeys = Object.keys(node.properties ?? {});
    const required = Array.isArray(node.required) ? node.required : [];
    const propertySet = new Set(propertyKeys);
    const requiredSet = new Set(required);
    const setEqual =
      propertySet.size === requiredSet.size &&
      [...propertySet].every((k) => requiredSet.has(k));
    if (!setEqual) {
      throw new Error(`required must set-equal properties keys at ${path}`);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    checkSchemaNode(value, `${path}.${key}`);
  }
}

function verifyOutputSchema(schemaPath) {
  let schema;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    process.stderr.write(`fake-codex: could not read/parse --output-schema file: ${String(err)}\n`);
    process.exit(3);
    return;
  }
  if (schema === null || typeof schema !== 'object' || schema.type !== 'object') {
    process.stderr.write('fake-codex: --output-schema root must be type "object"\n');
    process.exit(3);
    return;
  }
  try {
    checkSchemaNode(schema, '$');
  } catch (err) {
    process.stderr.write(`fake-codex: --output-schema violates the structured-output subset: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  }
}

const ARTIFACT_BODY = { ok: true, count: 1 };
const ARTIFACT_BODY_INVALID = { ok: 'nope', count: 'not-a-number' };

function counterFilePath() {
  const key = process.env['FAKE_CODEX_ARTIFACT_KEY'] ?? 'default';
  return join(process.env['TMPDIR'] ?? tmpdir(), `fake-codex-artifact-${key}.counter`);
}

function readAndBumpCounter() {
  const path = counterFilePath();
  const current = existsSync(path) ? Number.parseInt(readFileSync(path, 'utf8'), 10) : 0;
  writeFileSync(path, String(current + 1), 'utf8');
  return current;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = process.env['FAKE_CODEX_MODE'] ?? 'success';
  if (mode === 'hang') {
    // Install before any async setup so the timeout test cannot race the handler.
    process.on('SIGTERM', () => {});
  }
  if (args.includes('--version')) {
    process.stdout.write('codex-cli 0.149.1 (fake-codex)\n');
    process.exit(0);
    return;
  }

  const outputSchemaIndex = args.indexOf('--output-schema');
  if (outputSchemaIndex >= 0) {
    const schemaPath = args[outputSchemaIndex + 1];
    if (schemaPath !== undefined) {
      verifyOutputSchema(schemaPath);
    }
  }

  const outputLastMessageIndex = args.indexOf('-o');
  const outputLastMessagePath =
    outputLastMessageIndex >= 0 ? args[outputLastMessageIndex + 1] : undefined;

  await drainStdin();

  const writeFinalMessage = (text) => {
    if (outputLastMessagePath !== undefined) {
      writeFileSync(outputLastMessagePath, text, 'utf8');
    }
  };

  switch (mode) {
    case 'success': {
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'ok' } });
      writeFinalMessage('ok');
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: 18_383,
          cached_input_tokens: 6144,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      });
      process.exit(0);
      break;
    }
    case 'artifact': {
      const text = JSON.stringify(ARTIFACT_BODY);
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
      writeFinalMessage(text);
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: 18_383,
          cached_input_tokens: 6144,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      });
      process.exit(0);
      break;
    }
    case 'artifact-invalid': {
      const text = JSON.stringify(ARTIFACT_BODY_INVALID);
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
      writeFinalMessage(text);
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: 18_383,
          cached_input_tokens: 6144,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      });
      process.exit(0);
      break;
    }
    case 'artifact-then-valid': {
      const invocation = readAndBumpCounter();
      const text = JSON.stringify(invocation === 0 ? ARTIFACT_BODY_INVALID : ARTIFACT_BODY);
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
      writeFinalMessage(text);
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: 18_383,
          cached_input_tokens: 6144,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      });
      process.exit(0);
      break;
    }
    case 'artifact-by-model': {
      // Looks up the body to emit by the `-m` value, from a JSON file named by
      // FAKE_CODEX_ARTIFACT_TABLE (a map of model name -> artifact body). See the mirror
      // implementation in fake-claude.mjs for the rationale.
      const tablePath = process.env['FAKE_CODEX_ARTIFACT_TABLE'];
      const modelIndex = args.indexOf('-m');
      const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
      let body = ARTIFACT_BODY;
      if (tablePath !== undefined && model !== undefined) {
        const table = JSON.parse(readFileSync(tablePath, 'utf8'));
        if (Object.prototype.hasOwnProperty.call(table, model)) {
          body = table[model];
        }
      }
      const text = JSON.stringify(body);
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
      writeFinalMessage(text);
      emit({
        type: 'turn.completed',
        usage: {
          input_tokens: 18_383,
          cached_input_tokens: 6144,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      });
      process.exit(0);
      break;
    }
    case 'quota': {
      // S5: only `error` and `turn.failed` are terminal. Text carries a QUOTA_SIGNATURES
      // match — S5's `status`/`error.type` at genuine quota exhaustion is unverified, so
      // this fixture reproduces the shape (a JSON-encoded `message` field), not a guessed
      // vocabulary.
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      emit({
        type: 'error',
        message: JSON.stringify({
          type: 'error',
          status: 429,
          error: { type: 'rate_limit_exceeded', message: 'rate limit exceeded' },
        }),
      });
      emit({
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 429,
            error: { type: 'rate_limit_exceeded', message: 'rate limit exceeded' },
          }),
        },
      });
      process.exit(1);
      break;
    }
    case 'nonzero': {
      // S5 finding 3: an `item.completed` of `item.type === "error"` is NOT fatal on its
      // own — it appears here before the terminal `error`/`turn.failed` pair, exactly as
      // captured.
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({
        type: 'item.completed',
        item: { id: 'item_0', type: 'error', message: 'Model metadata not found.' },
      });
      emit({ type: 'turn.started' });
      emit({
        type: 'error',
        message: JSON.stringify({
          type: 'error',
          status: 400,
          error: { type: 'invalid_request_error', message: 'the model is not supported' },
        }),
      });
      emit({
        type: 'turn.failed',
        error: {
          message: JSON.stringify({
            type: 'error',
            status: 400,
            error: { type: 'invalid_request_error', message: 'the model is not supported' },
          }),
        },
      });
      process.exit(1);
      break;
    }
    case 'garbage': {
      process.stdout.write('this is not json at all\n');
      process.stdout.write('neither is this line\n');
      process.exit(0);
      break;
    }
    case 'hang': {
      // deliberately ignores SIGTERM to exercise miengu's SIGKILL ladder
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      emit({ type: 'turn.started' });
      await sleep(600_000);
      process.exit(0);
      break;
    }
    case 'many-turns': {
      emit({ type: 'thread.started', thread_id: THREAD_ID });
      for (let i = 0; i < 100; i += 1) {
        emit({ type: 'turn.started' });
        emit({
          type: 'item.completed',
          item: { id: `item_${String(i)}`, type: 'agent_message', text: `turn ${String(i)}` },
        });
        emit({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 0,
          },
        });
        await sleep(50);
      }
      process.exit(0);
      break;
    }
    default: {
      process.stderr.write(`fake-codex: unknown FAKE_CODEX_MODE "${mode}"\n`);
      process.exit(2);
    }
  }
}

await main();
