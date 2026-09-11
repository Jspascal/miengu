import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluatePredicate } from '../../src/brownfield/falsification.js';
import type { PredicateEvaluationInput } from '../../src/brownfield/types.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

// Prepended to wrapper fixtures: `C(o)` emits a compact flat object with sorted keys. The reader
// accepts any key order, while these fixtures keep their byte representation deterministic.
const CANON =
  "const C=o=>'{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+JSON.stringify(o[k])).join(',')+'}';";
const OK_CONTROL = {
  protocol: 'miengu-brownfield-v1', status: 'exited', exit_code: 0, signal: null,
  stdout_path: 'stdout.bin', stderr_path: 'stderr.bin', stdout_bytes: 0, stderr_bytes: 0,
  stdout_truncated: false, stderr_truncated: false,
};

function input(root: string, predicate: PredicateEvaluationInput['proposal']['predicate']): PredicateEvaluationInput {
  return {
    targetRoot: root, targetCommit: 'HEAD', proposalEventId: 'evt-00000000-0000-0000-0000-000000000001' as never,
    proposal: { target_commit: 'HEAD', scope_sha256: 'a'.repeat(64), subject: null, assertion: 'assertion', area: null, predicate },
    policy: { maxPredicatesPerScope: 8, maxWallSeconds: 1, maxOutputBytes: 1024, commands: {}, sandbox: null }, signal: null, evidenceDir: join(root, 'evidence'),
  };
}

function commandInput(
  root: string,
  wrapper: string,
  opts: { signal?: AbortSignal; maxWallSeconds?: number } = {},
): PredicateEvaluationInput {
  const base = input(root, { kind: 'declared-command-exits', command: 'check', expected_exit_codes: [0] });
  return {
    ...base,
    signal: opts.signal ?? null,
    policy: {
      ...base.policy,
      maxWallSeconds: opts.maxWallSeconds ?? base.policy.maxWallSeconds,
      commands: { check: { argv: [process.execPath, '-e', 'ok'] } },
      sandbox: { bin: process.execPath, argvPrefix: [wrapper] },
    },
  };
}

describe('evaluatePredicate', () => {
  it('evaluates closed bounded file predicates and persists evaluation evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: '3' } }));
    const text = await evaluatePredicate(input(root, { kind: 'text-includes', path: 'package.json', needle: 'zod', expected: true }));
    expect(text.data).toMatchObject({ outcome: 'confirmed', reason: 'predicate-true', observed: 'true' });
    expect(await readFile(text.data.evidence.path, 'utf8')).toContain('text-includes');
    const edge = await evaluatePredicate(input(root, { kind: 'dependency-edge-exists', from: 'package.json', to: 'zod', expected: true }));
    expect(edge.data.outcome).toBe('confirmed');
  });

  it('refuses escaping paths and unconfigured command predicates without spawning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const escaped = await evaluatePredicate(input(root, { kind: 'path-exists', path: '../outside', expected: true }));
    expect(escaped.data).toMatchObject({ outcome: 'inconclusive', reason: 'invalid-target' });
    const command = await evaluatePredicate(input(root, { kind: 'declared-command-exits', command: 'test', expected_exit_codes: [0] }));
    expect(command.data).toMatchObject({ outcome: 'inconclusive', reason: 'unavailable' });
  });

  it('uses the exact wrapper protocol, sanitized environment, and removes scratch output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    await writeFile(wrapper, `${CANON}\nimport { writeFile } from 'node:fs/promises';\nconst a=process.argv.slice(2); if(a[0]!=='run'||a[1]!=='--protocol'||a[2]!=='miengu-brownfield-v1'||a[3]!=='--network'||a[4]!=='none'||a[5]!=='--root-ro'||a[6]!==${JSON.stringify(root)}||a[7]!=='/workspace'||a[8]!=='--scratch-rw'||a[10]!=='/output'||a[11]!=='--workdir'||a[12]!=='/workspace'||a[13]!=='--timeout-ms'||a[14]!=='1000'||a[15]!=='--stdout-max-bytes'||a[16]!=='1024'||a[17]!=='--stderr-max-bytes'||a[18]!=='1024'||a[19]!=='--') process.exit(9); if(process.env.HOME !== '/output/home' || process.env.SECRET !== undefined) process.exit(8); await writeFile(a[9]+'/stdout.bin','out'); await writeFile(a[9]+'/stderr.bin','err'); process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:0,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:3,stderr_bytes:3,stdout_truncated:false,stderr_truncated:false}));`);
    const base = input(root, { kind: 'declared-command-exits', command: 'check', expected_exit_codes: [0] });
    process.env.SECRET = 'do-not-pass';
    const result = await evaluatePredicate({ ...base, policy: { ...base.policy, commands: { check: { argv: [process.execPath, '-e', 'ok'] } }, sandbox: { bin: process.execPath, argvPrefix: [wrapper] } } });
    delete process.env.SECRET;
    expect(result.data).toMatchObject({ outcome: 'confirmed', reason: 'predicate-true', observed: '0' });
    expect((await readdir(join(root, 'evidence'))).some((name) => name.startsWith('scratch-'))).toBe(false);
  });

  it('treats malformed control, wrapper failures, invalid stream files, and truncated output as inconclusive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    const evaluate = async (body: string) => {
      await writeFile(wrapper, `${CANON}\n${body}`);
      return evaluatePredicate(commandInput(root, wrapper));
    };
    expect((await evaluate(`process.stdout.write('{');`)).data).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    expect((await evaluate(`process.exit(7);`)).data).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    expect((await evaluate(`import { writeFile,symlink } from 'node:fs/promises';const s=process.argv[11];await writeFile(s+'/real','x');await symlink('real',s+'/stdout.bin');await writeFile(s+'/stderr.bin','');process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:0,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:1,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false}));`)).data).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    expect((await evaluate(`import { writeFile } from 'node:fs/promises';const s=process.argv[11];await writeFile(s+'/stdout.bin','too many');await writeFile(s+'/stderr.bin','');process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:0,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:1,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false}));`)).data).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    expect((await evaluate(`import { writeFile } from 'node:fs/promises';const s=process.argv[11];await writeFile(s+'/stdout.bin','');await writeFile(s+'/stderr.bin','');process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:0,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:0,stderr_bytes:0,stdout_truncated:true,stderr_truncated:false}));`)).data).toMatchObject({ outcome: 'inconclusive', reason: 'output-truncated' });
  });

  it('uses the subject exit code for completed command predicates and kills a hung wrapper after TERM grace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    await writeFile(wrapper, `${CANON}\nimport { writeFile } from 'node:fs/promises';const s=process.argv[11];await writeFile(s+'/stdout.bin','');await writeFile(s+'/stderr.bin','');process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:3,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false}));`);
    expect((await evaluatePredicate(commandInput(root, wrapper))).data).toMatchObject({ outcome: 'refuted', reason: 'predicate-false', observed: '3' });
    await writeFile(wrapper, `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`);
    const timed = await evaluatePredicate(commandInput(root, wrapper));
    expect(timed.data).toMatchObject({ outcome: 'inconclusive', reason: 'timed-out' });
  }, 6_000);

  // --- adversarial: strict exact canonical control JSON, including the signal field and key set ---

  it('rejects control JSON with a wrong key set, a mistyped signal, or a non-canonical byte form', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    const emit = async (expr: string) => {
      await writeFile(wrapper, `${CANON}\nimport { writeFile } from 'node:fs/promises';const s=process.argv[11];await writeFile(s+'/stdout.bin','');await writeFile(s+'/stderr.bin','');process.stdout.write(${expr});`);
      return (await evaluatePredicate(commandInput(root, wrapper, { maxWallSeconds: 10 }))).data;
    };
    // Extra key beyond the fixed ten.
    expect(await emit(`C({...${JSON.stringify(OK_CONTROL)},extra:1})`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // `signal` swapped for a bogus key: still exactly ten entries, so a count check would pass.
    const noSignal = { ...OK_CONTROL } as Record<string, unknown>;
    delete noSignal['signal'];
    expect(await emit(`C({...${JSON.stringify(noSignal)},bogus:null})`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // `signal` present but neither string nor null.
    expect(await emit(`C({...${JSON.stringify(OK_CONTROL)},signal:2})`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // `exit_code` not an integer or null.
    expect(await emit(`C({...${JSON.stringify(OK_CONTROL)},exit_code:1.5})`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // Well-formed object, but pretty-printed: extra whitespace is not the canonical form.
    expect(await emit(`JSON.stringify(${JSON.stringify(OK_CONTROL)},null,2)`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // Documented object followed by trailing bytes.
    expect(await emit(`C(${JSON.stringify(OK_CONTROL)})+'\\n'`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // Documented object preceded by a leading byte.
    expect(await emit(`' '+C(${JSON.stringify(OK_CONTROL)})`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // A duplicate key (parse keeps the last, but the extra bytes survive in the raw output).
    expect(await emit(`'{"status":"exited",'+C(${JSON.stringify(OK_CONTROL)}).slice(1)`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // Keys in decision 13's documented order rather than sorted order are accepted verbatim.
    expect(await emit(`JSON.stringify(${JSON.stringify(OK_CONTROL)})`)).toMatchObject({ outcome: 'confirmed', reason: 'predicate-true', observed: '0' });
    // A valid `signal` string with a non-'exited' status stays inconclusive with the mapped reason.
    expect(await emit(`C({...${JSON.stringify(OK_CONTROL)},status:'timed-out',exit_code:null,signal:'SIGKILL'})`)).toMatchObject({ outcome: 'inconclusive', reason: 'timed-out' });
  }, 10_000);

  // --- adversarial: descriptor-based, no-follow stream reads with identity/containment rechecks ---

  it('refuses stream entries that are directories or symlinks even when the metadata looks valid', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    const emit = async (setup: string) => {
      await writeFile(wrapper, `${CANON}\nimport { mkdir, writeFile, symlink } from 'node:fs/promises';const s=process.argv[11];${setup};process.stdout.write(C({protocol:'miengu-brownfield-v1',status:'exited',exit_code:0,signal:null,stdout_path:'stdout.bin',stderr_path:'stderr.bin',stdout_bytes:0,stderr_bytes:0,stdout_truncated:false,stderr_truncated:false}));`);
      return (await evaluatePredicate(commandInput(root, wrapper, { maxWallSeconds: 10 }))).data;
    };
    // stdout.bin is a directory, not a regular file.
    expect(await emit(`await mkdir(s+'/stdout.bin');await writeFile(s+'/stderr.bin','')`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // stdout.bin is a symlink to a real regular file outside the scratch directory.
    expect(await emit(`await writeFile(${JSON.stringify(join(root, 'leak'))},'x');await symlink(${JSON.stringify(join(root, 'leak'))},s+'/stdout.bin');await writeFile(s+'/stderr.bin','')`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
    // stdout.bin is a symlink pointing back inside scratch (containment alone would pass).
    expect(await emit(`await writeFile(s+'/inside','x');await symlink('inside',s+'/stdout.bin');await writeFile(s+'/stderr.bin','')`)).toMatchObject({ outcome: 'inconclusive', reason: 'spawn-error' });
  }, 10_000);

  // --- adversarial: mandatory TERM grace + SIGKILL of the whole group, even if the wrapper closes ---

  it('always waits the full TERM grace before settling when a timed-out wrapper exits on SIGTERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    // Exits immediately on SIGTERM: a naive settle-on-close would skip the grace and the SIGKILL.
    await writeFile(wrapper, `process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
    const start = performance.now();
    const timed = await evaluatePredicate(commandInput(root, wrapper));
    const elapsed = performance.now() - start;
    expect(timed.data).toMatchObject({ outcome: 'inconclusive', reason: 'timed-out' });
    expect(timed.data.duration_ms).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
  }, 8_000);

  it('always waits the full TERM grace before settling when an aborted wrapper exits on SIGTERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'miengu-falsify-')); roots.push(root);
    const wrapper = join(root, 'wrapper.mjs');
    await writeFile(wrapper, `process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const start = performance.now();
    const aborted = await evaluatePredicate(commandInput(root, wrapper, { signal: controller.signal, maxWallSeconds: 30 }));
    const elapsed = performance.now() - start;
    expect(aborted.data).toMatchObject({ outcome: 'inconclusive', reason: 'aborted' });
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
  }, 8_000);
});
