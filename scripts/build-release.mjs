import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (typeof version !== 'string' || version.length === 0) throw new Error('package.json must contain a version');

const releaseDir = join(root, 'release');
const bundleName = `miengu-v${version}`;
const bundleDir = join(releaseDir, bundleName);
const archive = `${bundleName}.tar.gz`;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(join(bundleDir, 'bin'), { recursive: true });
await cp(join(root, 'dist'), join(bundleDir, 'dist'), { recursive: true });
await cp(join(root, 'bin', 'miengu'), join(bundleDir, 'bin', 'miengu'));
await cp(join(root, 'miengu.config.example.yaml'), join(bundleDir, 'miengu.config.example.yaml'));
await cp(join(root, 'README.md'), join(bundleDir, 'README.md'));
await cp(join(root, 'package.json'), join(bundleDir, 'package.json'));
await cp(join(root, 'package-lock.json'), join(bundleDir, 'package-lock.json'));
await chmod(join(bundleDir, 'bin', 'miengu'), 0o755);

// The release artifact is self-contained apart from the Node 20+ runtime provided by Homebrew
// or the operator. Ignore lifecycle scripts so packaging does not execute dependency code.
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--prefix', bundleDir]);

run('tar', ['-C', releaseDir, '-czf', join(releaseDir, archive), bundleName]);
await cp(join(releaseDir, archive), join(releaseDir, 'miengu.tar.gz'));
const digest = createHash('sha256').update(await readFile(join(releaseDir, archive))).digest('hex');
await writeFile(join(releaseDir, 'SHA256SUMS'), `${digest}  ${archive}\n${digest}  miengu.tar.gz\n`);

console.log(`Created release/${archive}`);
console.log(`SHA256 ${digest}`);
