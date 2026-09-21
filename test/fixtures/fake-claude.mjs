#!/usr/bin/env node
// Stands in for the `claude` binary in tests. Never contacts the network. Behaviour is
// selected by FAKE_CLAUDE_MODE so claudeCode.test.ts never has to invoke a real provider.
//
// Rewritten from the captured reality, per `docs/002-executor-findings.md` (S2) and the
// verbatim capture at `docs/captures/s2-claude-stream-json.ndjson` — reality is the source
// of truth here, never the other way round.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '00000000-1111-4222-8333-444444444444';

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

// The three lines the real binary emits before any assistant output — S2 finding row 1.
// The parser must tolerate this leading noise; it never becomes a turn.
function emitLeadingNoise() {
  emit({
    type: 'system',
    subtype: 'hook_started',
    hook_id: 'fake-hook-id',
    hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart',
    uuid: 'fake-hook-started-uuid',
    session_id: SESSION_ID,
  });
  emit({
    type: 'system',
    subtype: 'hook_response',
    hook_id: 'fake-hook-id',
    hook_name: 'SessionStart:startup',
    hook_event: 'SessionStart',
    output: '',
    stdout: '',
    stderr: '',
    exit_code: 0,
    outcome: 'success',
    uuid: 'fake-hook-response-uuid',
    session_id: SESSION_ID,
  });
  emit({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    session_id: SESSION_ID,
    tools: ['Bash', 'Read', 'Write'],
    mcp_servers: [],
    model: 'claude-sonnet-5',
    permissionMode: 'acceptEdits',
    apiKeySource: 'none',
    claude_code_version: '2.1.260',
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
    uuid: 'fake-init-uuid',
  });
}

let assistantSerial = 0;
function emitAssistant(text, id = `msg_fake_${++assistantSerial}`) {
  emit({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
      stop_sequence: null,
    },
    parent_tool_use_id: null,
    request_id: 'req_fake',
    session_id: SESSION_ID,
    uuid: 'fake-assistant-uuid',
    timestamp: new Date().toISOString(),
  });
}

// Reproduces the captured payload verbatim in shape; individual fields are overridable so
// the quota-precedence modes below can flip exactly the fields under test.
function emitRateLimitEvent(overrides = {}) {
  emit({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed_warning',
      resetsAt: 1788545400,
      rateLimitType: 'five_hour',
      utilization: 0.91,
      isUsingOverage: false,
      surpassedThreshold: 0.9,
      unifiedWindows: {
        five_hour: { utilization: 0.91, resetsAt: 1788545400 },
        seven_day: { utilization: 0.1, resetsAt: 1789012800 },
      },
      ...overrides,
    },
    uuid: 'fake-rate-limit-uuid',
    session_id: SESSION_ID,
  });
}

// The real 24-key result object. `usage` carries the real 11 keys, including the two cache
// fields that S2 found were being silently dropped from the input-token figure.
function emitResult(overrides = {}) {
  emit({
    duration_api_ms: 2745,
    stop_reason: 'end_turn',
    session_id: SESSION_ID,
    total_cost_usd: 0.0686246,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 13336,
      cache_read_input_tokens: 8144,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: 'standard',
      cache_creation: { ephemeral_1h_input_tokens: 13336, ephemeral_5m_input_tokens: 0 },
      inference_geo: 'not_available',
      iterations: [],
    },
    modelUsage: {
      'claude-sonnet-5': {
        inputTokens: 2,
        outputTokens: 4,
        cacheReadInputTokens: 8144,
        cacheCreationInputTokens: 13336,
        webSearchRequests: 0,
        costUSD: 0.0686246,
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        thinkingTokens: 0,
        canonicalModel: 'claude-sonnet-5',
        provider: 'firstParty',
        costBasis: 'list',
      },
    },
    permission_denials: [],
    terminal_reason: 'completed',
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    subagent_stats: {
      spawned: 0,
      requested: { background: 0, foreground: 0, unset: 0 },
      started_in_background: 0,
      max_depth: 0,
      spawned_by_subagents: 0,
      completed: 0,
      failed: 0,
      killed: { parent: 0, user: 0, system: 0 },
      refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
      by_type: {},
    },
    is_error: false,
    num_turns: 2,
    subtype: 'success',
    api_error_status: null,
    result: 'ok',
    ttft_ms: 2381,
    type: 'result',
    duration_ms: 2883,
    uuid: 'fake-result-uuid',
    ttft_stream_ms: 2379,
    time_to_request_ms: 98,
    first_content_frame_ms: 2380,
    queued_turn_count: 0,
    ...overrides,
  });
}

const ARTIFACT_BODY = { ok: true, count: 1 };
const ARTIFACT_BODY_INVALID = { ok: 'nope', count: 'not-a-number' };

function counterFilePath() {
  const key = process.env['FAKE_CLAUDE_ARTIFACT_KEY'] ?? 'default';
  return join(process.env['TMPDIR'] ?? tmpdir(), `fake-claude-artifact-${key}.counter`);
}

function readAndBumpCounter() {
  const path = counterFilePath();
  const current = existsSync(path) ? Number.parseInt(readFileSync(path, 'utf8'), 10) : 0;
  writeFileSync(path, String(current + 1), 'utf8');
  return current;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write('2.1.260 (fake-claude)\n');
    process.exit(0);
    return;
  }

  await drainStdin();

  const mode = process.env['FAKE_CLAUDE_MODE'] ?? 'success';

  switch (mode) {
    case 'split-message': {
      emitLeadingNoise();
      emitAssistant('First block', 'msg_same');
      emitAssistant('Second block', 'msg_same');
      emitResult({ num_turns: 1 });
      process.exit(0);
      break;
    }
    case 'success': {
      emitLeadingNoise();
      emitAssistant('ok');
      emitAssistant('ok');
      emitRateLimitEvent();
      emitResult();
      process.exit(0);
      break;
    }
    case 'error-result': {
      emitLeadingNoise();
      emitAssistant('trying');
      emitResult({
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
      });
      process.exit(0);
      break;
    }
    case 'quota': {
      // Fallback path (precedence tier 3/4): no rate_limit_event, no api_error_status —
      // detection relies solely on the QUOTA_SIGNATURES regex against the result text.
      emitLeadingNoise();
      emitAssistant('trying');
      emitResult({
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: null,
        result: 'You have exceeded your usage limit for this billing period.',
      });
      process.exit(0);
      break;
    }
    case 'rate-limited': {
      // Precedence tier 1: rate_limit_info.status is not in RATE_LIMIT_ALLOWED_STATUSES.
      // Exit code is deliberately nonzero — S3 is PENDING on the real exit code, so the
      // stream evidence must win regardless of exit status.
      emitLeadingNoise();
      emitAssistant('trying');
      emitRateLimitEvent({ status: 'blocked', utilization: 1, surpassedThreshold: 1 });
      emitResult({
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: null,
      });
      process.exit(1);
      break;
    }
    case 'api-429': {
      // Precedence tier 2: no rate_limit_event at all, but result.api_error_status === 429.
      emitLeadingNoise();
      emitAssistant('trying');
      emitResult({
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 429,
      });
      process.exit(0);
      break;
    }
    case 'garbage': {
      emitLeadingNoise();
      process.stdout.write('this is not json at all\n');
      process.stdout.write('neither is this line\n');
      process.exit(0);
      break;
    }
    case 'nonzero': {
      emitLeadingNoise();
      process.stderr.write('fatal: something went wrong talking to the provider\n');
      process.exit(2);
      break;
    }
    case 'hang': {
      // deliberately ignores SIGTERM to exercise miengu's SIGKILL ladder
      process.on('SIGTERM', () => {});
      emitLeadingNoise();
      emitAssistant('working');
      await sleep(600_000);
      process.exit(0);
      break;
    }
    case 'many-turns': {
      emitLeadingNoise();
      for (let i = 0; i < 100; i += 1) {
        emitAssistant(`turn ${String(i)}`);
        await sleep(50);
      }
      emitRateLimitEvent();
      emitResult({ num_turns: 100 });
      process.exit(0);
      break;
    }
    case 'commits': {
      emitLeadingNoise();
      execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
      execFileSync('git', ['commit', '-m', 'fake-claude committed during the run'], {
        cwd: process.cwd(),
      });
      emitAssistant('committing');
      emitResult();
      process.exit(0);
      break;
    }
    case 'artifact': {
      emitLeadingNoise();
      emitAssistant('producing artifact');
      emitResult({ result: JSON.stringify(ARTIFACT_BODY) });
      process.exit(0);
      break;
    }
    case 'artifact-fenced': {
      emitLeadingNoise();
      emitAssistant('producing artifact');
      emitResult({ result: `\`\`\`json\n${JSON.stringify(ARTIFACT_BODY, null, 2)}\n\`\`\`` });
      process.exit(0);
      break;
    }
    case 'artifact-prose': {
      emitLeadingNoise();
      emitAssistant('producing artifact');
      emitResult({
        result: `Here is the artifact:\n${JSON.stringify(ARTIFACT_BODY)}\nLet me know if you need anything else.`,
      });
      process.exit(0);
      break;
    }
    case 'artifact-invalid': {
      emitLeadingNoise();
      emitAssistant('producing artifact');
      emitResult({ result: JSON.stringify(ARTIFACT_BODY_INVALID) });
      process.exit(0);
      break;
    }
    case 'artifact-then-valid': {
      // Invalid on invocation 1, valid on invocation 2, keyed by a counter file in TMPDIR —
      // this is what proves the single §9.1b retry.
      const invocation = readAndBumpCounter();
      emitLeadingNoise();
      emitAssistant('producing artifact');
      emitResult({
        result: JSON.stringify(invocation === 0 ? ARTIFACT_BODY_INVALID : ARTIFACT_BODY),
      });
      process.exit(0);
      break;
    }
    case 'artifact-by-model': {
      // Looks up the body to emit by the `--model` value, from a JSON file named by
      // FAKE_CLAUDE_ARTIFACT_TABLE (a map of model name -> artifact body). Lets an
      // acceptance test drive real per-role contract-valid content through this adapter
      // without inventing a scheme the real `claude` binary does not have — the table is
      // pure test plumbing, keyed on a value (`--model`) the adapter already sends.
      emitLeadingNoise();
      emitAssistant('producing artifact');
      const tablePath = process.env['FAKE_CLAUDE_ARTIFACT_TABLE'];
      const modelIndex = args.indexOf('--model');
      const model = modelIndex >= 0 ? args[modelIndex + 1] : undefined;
      let body = ARTIFACT_BODY;
      if (tablePath !== undefined && model !== undefined) {
        const table = JSON.parse(readFileSync(tablePath, 'utf8'));
        if (Object.prototype.hasOwnProperty.call(table, model)) {
          body = table[model];
        }
      }
      emitResult({ result: JSON.stringify(body) });
      process.exit(0);
      break;
    }
    default: {
      process.stderr.write(`fake-claude: unknown FAKE_CLAUDE_MODE "${mode}"\n`);
      process.exit(2);
    }
  }
}

await main();
