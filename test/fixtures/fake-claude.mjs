#!/usr/bin/env node
// Stands in for the `claude` binary in tests. Never contacts the network. Behaviour is
// selected by FAKE_CLAUDE_MODE so claudeCode.test.ts never has to invoke a real provider.

import { execFileSync } from 'node:child_process';

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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--version')) {
    process.stdout.write('2.1.247 (fake-claude)\n');
    process.exit(0);
    return;
  }

  await drainStdin();

  const mode = process.env['FAKE_CLAUDE_MODE'] ?? 'success';

  switch (mode) {
    case 'success': {
      emit({ type: 'assistant' });
      emit({ type: 'assistant' });
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        usage: { input_tokens: 120, output_tokens: 80 },
        total_cost_usd: 0.0123,
      });
      process.exit(0);
      break;
    }
    case 'error-result': {
      emit({ type: 'assistant' });
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        num_turns: 1,
      });
      process.exit(0);
      break;
    }
    case 'quota': {
      emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: 'You have exceeded your usage limit for this billing period.',
      });
      process.exit(0);
      break;
    }
    case 'garbage': {
      process.stdout.write('this is not json at all\n');
      process.stdout.write('neither is this line\n');
      process.exit(0);
      break;
    }
    case 'nonzero': {
      process.stderr.write('fatal: something went wrong talking to the provider\n');
      process.exit(2);
      break;
    }
    case 'hang': {
      // deliberately ignores SIGTERM to exercise miengu's SIGKILL ladder
      process.on('SIGTERM', () => {});
      emit({ type: 'assistant' });
      await sleep(600_000);
      process.exit(0);
      break;
    }
    case 'many-turns': {
      for (let i = 0; i < 100; i += 1) {
        emit({ type: 'assistant' });
        await sleep(50);
      }
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 100,
        usage: { input_tokens: 5000, output_tokens: 5000 },
        total_cost_usd: 1,
      });
      process.exit(0);
      break;
    }
    case 'commits': {
      execFileSync('git', ['add', '-A'], { cwd: process.cwd() });
      execFileSync('git', ['commit', '-m', 'fake-claude committed during the run'], {
        cwd: process.cwd(),
      });
      emit({ type: 'assistant' });
      emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 10 },
        total_cost_usd: 0.001,
      });
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
