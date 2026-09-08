import { appendFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const mode = process.env['FAKE_ORACLE_MODE'] ?? 'pass';
const orderFile = process.env['FAKE_ORACLE_ORDER_FILE'];

if (orderFile !== undefined) {
  await appendFile(orderFile, `${mode}\n`, 'utf8');
}

if (mode === 'hang') {
  // Install these before any asynchronous startup. The timeout test verifies the runner's
  // TERM -> grace -> KILL ladder, not a fixture-startup race.
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
  globalThis.setInterval(() => {}, 1000);
} else if (mode === 'background') {
  // The child inherits the shell's pipes and ignores TERM. This is the failure mode a
  // single-child `kill()` misses: the shell exits, but a descendant still owns stdout.
  spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, FAKE_ORACLE_MODE: 'hang' },
    stdio: 'inherit',
  }).unref();
} else if (mode === 'term-exit-background-closed') {
  // The command shell exits on TERM, while this descendant has no inherited pipes and keeps
  // running. The runner must still keep its grace timer and kill the whole process group.
  const child = spawn(process.execPath, [process.argv[1]], {
    env: { ...process.env, FAKE_ORACLE_MODE: 'hang' },
    stdio: 'ignore',
  });
  const pidFile = process.env['FAKE_ORACLE_PID_FILE'];
  if (pidFile !== undefined && child.pid !== undefined) await writeFile(pidFile, String(child.pid), 'utf8');
  child.unref();
  process.on('SIGTERM', () => process.exit(0));
  globalThis.setInterval(() => {}, 1000);
} else if (mode === 'fail') {
  process.stdout.write('failing stdout');
  process.stderr.write('failing stderr');
  process.exitCode = 7;
} else {
  process.stdout.write('passing stdout');
  process.stderr.write('passing stderr');
}
