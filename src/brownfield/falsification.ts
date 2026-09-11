import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdtemp, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJson } from '../core/canonical.js';
import { sha256Hex } from '../core/hash.js';
import type { PredicateEvaluation, PredicateEvaluationInput } from './types.js';
import { writeBrownfieldEvidence } from './evidence.js';

const WRAPPER_PROTOCOL = 'miengu-brownfield-v1';
const TERM_GRACE_MS = 2_000;
const WRAPPER_STDERR_CAP = 64 * 1024;
/** The exact wrapper-control key set in decision 13's documented order. */
const CONTROL_KEYS = [
  'protocol', 'status', 'exit_code', 'signal', 'stdout_path', 'stderr_path',
  'stdout_bytes', 'stderr_bytes', 'stdout_truncated', 'stderr_truncated',
] as const;
const CONTROL_KEYS_SORTED: readonly string[] = [...CONTROL_KEYS].sort();
const CONTROL_STATUSES: readonly string[] = ['exited', 'timed-out', 'aborted', 'policy-error', 'spawn-error'];

function validPath(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !path.includes('\\') && !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}

function printable(value: unknown): string {
  return canonicalJson(value);
}

async function regularBounded(root: string, path: string, limit: number): Promise<{ ok: true; value: Buffer } | { ok: false; reason: 'invalid-target' | 'output-truncated' }> {
  if (!validPath(path)) return { ok: false, reason: 'invalid-target' };
  const absolute = resolve(root, path);
  if (!within(root, absolute)) return { ok: false, reason: 'invalid-target' };
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) return { ok: false, reason: 'invalid-target' };
    if (info.size > limit) return { ok: false, reason: 'output-truncated' };
    return { ok: true, value: await readFile(absolute) };
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }
}

async function dependencyEdge(root: string, from: string, to: string, limit: number): Promise<{ ok: true; value: boolean } | { ok: false; reason: 'invalid-target' | 'output-truncated' }> {
  const file = await regularBounded(root, from, limit);
  if (!file.ok) return file;
  try {
    const json: unknown = JSON.parse(file.value.toString('utf8'));
    if (json === null || Array.isArray(json) || typeof json !== 'object') return { ok: false, reason: 'invalid-target' };
    const manifest = json as Record<string, unknown>;
    const groups = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    return { ok: true, value: groups.some((group) => {
      const values = manifest[group];
      return values !== null && typeof values === 'object' && !Array.isArray(values) && Object.prototype.hasOwnProperty.call(values, to);
    }) };
  } catch {
    return { ok: false, reason: 'invalid-target' };
  }
}

function pointerValue(value: unknown, pointer: string): { found: boolean; value: unknown } {
  if (pointer === '') return { found: true, value };
  if (!pointer.startsWith('/')) return { found: false, value: null };
  let current: unknown = value;
  for (const segment of pointer.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(segment)) current = current[Number(segment)];
    else if (current !== null && typeof current === 'object' && Object.prototype.hasOwnProperty.call(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return { found: false, value: null };
  }
  return { found: true, value: current };
}

interface Completed {
  readonly actual: boolean;
  readonly expected: string;
  readonly observed: string;
  readonly raw: Record<string, unknown>;
}

async function evaluateBuiltin(input: PredicateEvaluationInput): Promise<Completed | { reason: 'invalid-target' | 'output-truncated'; expected: string; observed: string }> {
  const predicate = input.proposal.predicate;
  if (predicate.kind === 'path-exists') {
    const expected = printable(predicate.expected);
    if (!validPath(predicate.path)) return { reason: 'invalid-target', expected, observed: 'invalid-path' };
    const candidate = resolve(input.targetRoot, predicate.path);
    if (!within(input.targetRoot, candidate)) return { reason: 'invalid-target', expected, observed: 'invalid-path' };
    let actual = false;
    try { actual = (await lstat(candidate)).isFile() || (await lstat(candidate)).isDirectory(); } catch { actual = false; }
    return { actual, expected, observed: printable(actual), raw: { predicate, expected, observed: actual } };
  }
  if (predicate.kind === 'text-includes') {
    const file = await regularBounded(input.targetRoot, predicate.path, input.policy.maxOutputBytes);
    if (!file.ok) return { reason: file.reason, expected: printable(predicate.expected), observed: file.reason };
    const actual = file.value.toString('utf8').includes(predicate.needle);
    return { actual, expected: printable(predicate.expected), observed: printable(actual), raw: { predicate, expected: predicate.expected, observed: actual } };
  }
  if (predicate.kind === 'json-pointer-equals') {
    const file = await regularBounded(input.targetRoot, predicate.path, input.policy.maxOutputBytes);
    if (!file.ok) return { reason: file.reason, expected: printable(predicate.expected), observed: file.reason };
    try {
      const pointer = pointerValue(JSON.parse(file.value.toString('utf8')), predicate.pointer);
      const actual = pointer.found && canonicalJson(pointer.value) === canonicalJson(predicate.expected);
      return { actual, expected: printable(predicate.expected), observed: pointer.found ? printable(pointer.value) : 'missing', raw: { predicate, expected: predicate.expected, observed: pointer.found ? pointer.value : null } };
    } catch { return { reason: 'invalid-target', expected: printable(predicate.expected), observed: 'invalid-json' }; }
  }
  if (predicate.kind === 'dependency-edge-exists') {
    const edge = await dependencyEdge(input.targetRoot, predicate.from, predicate.to, input.policy.maxOutputBytes);
    if (!edge.ok) return { reason: edge.reason, expected: printable(predicate.expected), observed: edge.reason };
    return { actual: edge.value, expected: printable(predicate.expected), observed: printable(edge.value), raw: { predicate, expected: predicate.expected, observed: edge.value } };
  }
  throw new Error('command predicate is not builtin');
}

function safeCommand(input: PredicateEvaluationInput): { argv: readonly string[] } | null {
  const predicate = input.proposal.predicate;
  if (predicate.kind !== 'declared-command-exits') return null;
  const command = input.policy.commands[predicate.command];
  const sandbox = input.policy.sandbox;
  if (command === undefined || sandbox === null) return null;
  if (!isAbsolute(sandbox.bin) || command.argv.length === 0 || !isAbsolute(command.argv[0] ?? '') || [...sandbox.argvPrefix, ...command.argv].some((part) => part.includes('\0'))) return null;
  return { argv: [sandbox.bin, ...sandbox.argvPrefix, 'run', '--protocol', WRAPPER_PROTOCOL, '--network', 'none', '--root-ro', resolve(input.targetRoot), '/workspace', '--scratch-rw'] };
}

interface WrapperResult { readonly status: 'completed' | 'timed-out' | 'aborted' | 'spawn-error'; readonly stdout: Buffer; readonly stderr: Buffer; readonly durationMs: number; }

async function runWrapper(argv: readonly string[], scratch: string, input: PredicateEvaluationInput): Promise<WrapperResult> {
  return new Promise((resolveResult) => {
    const started = performance.now();
    const child = spawn(argv[0] as string, argv.slice(1), { cwd: scratch, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/output/home', TMPDIR: '/output/tmp', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', CI: '1', NO_COLOR: '1' } });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let stdoutBytes = 0; let stderrBytes = 0;
    let timeout = false; let aborted = false; let terminating = false; let settled = false; let timer: NodeJS.Timeout | null = null; let killTimer: NodeJS.Timeout | null = null;
    const signalGroup = (signal: NodeJS.Signals): void => { try { if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ } };
    const settle = (status: WrapperResult['status']): void => { if (settled) return; settled = true; if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer); input.signal?.removeEventListener('abort', abort); resolveResult({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), durationMs: Math.max(0, Math.round(performance.now() - started)) }); };
    // On timeout/abort the SIGTERM -> fixed 2s grace -> SIGKILL of the whole detached group is
    // mandatory (decision 13). Once started it always runs to the SIGKILL: an early wrapper `close`
    // must not settle, because orphaned subject processes in the group may outlive the wrapper.
    const terminate = (isAbort: boolean): void => { if (settled) return; aborted ||= isAbort; timeout ||= !isAbort; if (terminating) return; terminating = true; signalGroup('SIGTERM'); killTimer = setTimeout(() => { signalGroup('SIGKILL'); settle(aborted ? 'aborted' : 'timed-out'); }, TERM_GRACE_MS); };
    const abort = (): void => terminate(true);
    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; if (stdoutBytes <= input.policy.maxOutputBytes) stdout.push(Buffer.from(chunk)); else terminate(false); });
    child.stderr?.on('data', (chunk: Buffer) => { if (stderrBytes < WRAPPER_STDERR_CAP) stderr.push(Buffer.from(chunk.subarray(0, WRAPPER_STDERR_CAP - stderrBytes))); stderrBytes += chunk.length; });
    child.on('error', () => { if (!terminating) settle('spawn-error'); });
    child.on('close', (code) => { if (terminating) return; settle(code === 0 ? 'completed' : 'spawn-error'); });
    if (input.signal?.aborted) terminate(true); else input.signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => terminate(false), input.policy.maxWallSeconds * 1000);
  });
}

/**
 * Read a named wrapper stream file by descriptor without following symlinks, then re-verify that the
 * opened inode is the same regular file that was named and still contained in the scratch directory.
 * Nothing under scratch is trusted after the wrapper exits: a leaked subject process may still be
 * swapping entries there.
 */
async function readStreamFile(
  scratch: string,
  name: string,
  declaredBytes: number,
  limit: number,
): Promise<{ ok: true; value: Buffer } | { ok: false; reason: 'spawn-error' | 'output-truncated' }> {
  if (name !== 'stdout.bin' && name !== 'stderr.bin') return { ok: false, reason: 'spawn-error' };
  const file = join(scratch, name);
  const pre = await lstat(file).catch(() => null);
  if (pre === null || !pre.isFile() || pre.isSymbolicLink()) return { ok: false, reason: 'spawn-error' };
  const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
  if (handle === null) return { ok: false, reason: 'spawn-error' };
  try {
    const post = await handle.stat();
    if (!post.isFile()) return { ok: false, reason: 'spawn-error' };
    // Identity recheck: the path must not have been swapped between lstat and open.
    if (post.ino !== pre.ino || post.dev !== pre.dev) return { ok: false, reason: 'spawn-error' };
    if (post.size > limit) return { ok: false, reason: 'output-truncated' };
    if (post.size !== declaredBytes) return { ok: false, reason: 'spawn-error' };
    // Containment recheck: the resolved file must sit directly inside the resolved scratch directory.
    const realScratch = await realpath(scratch).catch(() => null);
    const realFile = await realpath(file).catch(() => null);
    if (realScratch === null || realFile === null || dirname(realFile) !== realScratch) return { ok: false, reason: 'spawn-error' };
    const value = await handle.readFile();
    if (value.byteLength !== declaredBytes) return { ok: false, reason: 'spawn-error' };
    return { ok: true, value };
  } finally {
    await handle.close();
  }
}

async function commandCompleted(input: PredicateEvaluationInput): Promise<Completed | { reason: 'unavailable' | 'unsafe' | 'timed-out' | 'aborted' | 'spawn-error' | 'output-truncated'; expected: string; observed: string; raw: Record<string, unknown>; durationMs?: number }> {
  const predicate = input.proposal.predicate;
  if (predicate.kind !== 'declared-command-exits') throw new Error('not command');
  const command = input.policy.commands[predicate.command];
  if (command === undefined || input.policy.sandbox === null) return { reason: 'unavailable', expected: printable(predicate.expected_exit_codes), observed: 'unavailable', raw: { predicate, reason: 'unavailable' } };
  const base = safeCommand(input);
  if (base === null) return { reason: 'unsafe', expected: printable(predicate.expected_exit_codes), observed: 'unsafe', raw: { predicate, reason: 'unsafe' } };
  await mkdir(input.evidenceDir, { recursive: true });
  const scratch = await mkdtemp(join(input.evidenceDir, 'scratch-'));
  try {
    await Promise.all([mkdir(join(scratch, 'home')), mkdir(join(scratch, 'tmp'))]);
    const argv = [...base.argv, scratch, '/output', '--workdir', '/workspace', '--timeout-ms', String(input.policy.maxWallSeconds * 1000), '--stdout-max-bytes', String(input.policy.maxOutputBytes), '--stderr-max-bytes', String(input.policy.maxOutputBytes), '--', ...command.argv];
    const result = await runWrapper(argv, scratch, input);
    if (result.status !== 'completed') return { reason: result.status, expected: printable(predicate.expected_exit_codes), observed: result.status, raw: { predicate, wrapper_stderr: result.stderr.toString('base64'), status: result.status }, durationMs: result.durationMs };
    const rawControl = result.stdout.toString('utf8');
    const fail = (observed: string): { reason: 'spawn-error'; expected: string; observed: string; raw: Record<string, unknown>; durationMs: number } => ({
      reason: 'spawn-error', expected: printable(predicate.expected_exit_codes), observed,
      raw: { predicate, wrapper_stderr: result.stderr.toString('base64') }, durationMs: result.durationMs,
    });
    let control: unknown;
    try { control = JSON.parse(rawControl); } catch { return fail('malformed-wrapper-output'); }
    if (control === null || typeof control !== 'object' || Array.isArray(control)) return fail('invalid-wrapper-metadata');
    const c = control as Record<string, unknown>;
    // Exact key set: not just a count. A wrapper may substitute a bogus key for `signal` and keep ten.
    const keys = Object.keys(c).sort();
    if (keys.length !== CONTROL_KEYS_SORTED.length || CONTROL_KEYS_SORTED.some((k, i) => keys[i] !== k)) return fail('invalid-wrapper-key-set');
    if (c['protocol'] !== WRAPPER_PROTOCOL) return fail('invalid-wrapper-protocol');
    if (!CONTROL_STATUSES.includes(String(c['status']))) return fail('invalid-wrapper-status');
    if (!(c['exit_code'] === null || Number.isInteger(c['exit_code']))) return fail('invalid-wrapper-exit-code');
    if (!(c['signal'] === null || typeof c['signal'] === 'string')) return fail('invalid-wrapper-signal');
    if (typeof c['stdout_path'] !== 'string' || typeof c['stderr_path'] !== 'string') return fail('invalid-wrapper-metadata');
    if (!Number.isInteger(c['stdout_bytes']) || (c['stdout_bytes'] as number) < 0) return fail('invalid-wrapper-metadata');
    if (!Number.isInteger(c['stderr_bytes']) || (c['stderr_bytes'] as number) < 0) return fail('invalid-wrapper-metadata');
    if (typeof c['stdout_truncated'] !== 'boolean' || typeof c['stderr_truncated'] !== 'boolean') return fail('invalid-wrapper-metadata');
    // The documented wrapper object in any key order — but nothing around it. Re-serializing the
    // parsed object in its own (source) key order must reproduce the raw bytes exactly: this
    // still rejects leading/trailing bytes, surrounding whitespace, non-canonical value forms,
    // and duplicate keys (a repeated key survives in `rawControl` but not the reparse).
    if (JSON.stringify(c) !== rawControl) return fail('non-canonical-wrapper-output');
    if (c['status'] !== 'exited') return { reason: c['status'] === 'timed-out' ? 'timed-out' : c['status'] === 'aborted' ? 'aborted' : c['status'] === 'policy-error' ? 'unsafe' : 'spawn-error', expected: printable(predicate.expected_exit_codes), observed: String(c['status']), raw: { predicate, wrapper_stderr: result.stderr.toString('base64'), control: c }, durationMs: result.durationMs };
    if (c['stdout_truncated'] || c['stderr_truncated']) return { reason: 'output-truncated', expected: printable(predicate.expected_exit_codes), observed: 'output-truncated', raw: { predicate, control: c }, durationMs: result.durationMs };
    const streams: Buffer[] = [];
    for (const [nameKey, bytesKey] of [['stdout_path', 'stdout_bytes'], ['stderr_path', 'stderr_bytes']] as const) {
      const read = await readStreamFile(scratch, c[nameKey] as string, c[bytesKey] as number, input.policy.maxOutputBytes);
      if (!read.ok) return { reason: read.reason, expected: printable(predicate.expected_exit_codes), observed: read.reason === 'output-truncated' ? 'output-truncated' : 'invalid-stream-file', raw: { predicate, control: c }, durationMs: result.durationMs };
      streams.push(read.value);
    }
    const exitCode = c['exit_code'];
    if (!Number.isInteger(exitCode)) return { reason: 'spawn-error', expected: printable(predicate.expected_exit_codes), observed: 'invalid-exit-code', raw: { predicate, control: c }, durationMs: result.durationMs };
    const actual = predicate.expected_exit_codes.includes(exitCode as number);
    return { actual, expected: printable(predicate.expected_exit_codes), observed: printable(exitCode), raw: { predicate, control: c, stdout_sha256: sha256Hex(streams[0] ?? Buffer.alloc(0)), stderr_sha256: sha256Hex(streams[1] ?? Buffer.alloc(0)), stdout_base64: (streams[0] ?? Buffer.alloc(0)).toString('base64'), stderr_base64: (streams[1] ?? Buffer.alloc(0)).toString('base64') } };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Closed-predicate evaluator. Its caller appends `data` using the proposal event as causation. */
export async function evaluatePredicate(input: PredicateEvaluationInput): Promise<PredicateEvaluation> {
  const started = performance.now();
  const result = input.proposal.predicate.kind === 'declared-command-exits' ? await commandCompleted(input) : await evaluateBuiltin(input);
  const durationMs = 'durationMs' in result && result.durationMs !== undefined ? result.durationMs : Math.max(0, Math.round(performance.now() - started));
  const raw = 'raw' in result ? result.raw : { predicate: input.proposal.predicate, expected: result.expected, observed: result.observed, reason: result.reason };
  const evidence = await writeBrownfieldEvidence(input.evidenceDir, raw);
  if ('actual' in result) {
    const expectedBoolean = input.proposal.predicate.kind === 'declared-command-exits' ? true : input.proposal.predicate.expected;
    const confirmed = result.actual === expectedBoolean;
    return { data: { proposal_event_id: input.proposalEventId, target_commit: input.targetCommit, outcome: confirmed ? 'confirmed' : 'refuted', reason: result.actual ? 'predicate-true' : 'predicate-false', expected: result.expected, observed: result.observed, duration_ms: durationMs, evidence } };
  }
  return { data: { proposal_event_id: input.proposalEventId, target_commit: input.targetCommit, outcome: 'inconclusive', reason: result.reason, expected: result.expected, observed: result.observed, duration_ms: durationMs, evidence } };
}
