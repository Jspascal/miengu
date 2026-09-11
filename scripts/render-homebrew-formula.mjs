import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [repository, sha256] = process.argv.slice(2);
if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repository) || sha256 === undefined || !/^[a-f0-9]{64}$/.test(sha256)) {
  throw new Error('usage: node scripts/render-homebrew-formula.mjs OWNER/REPOSITORY SHA256');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (typeof pkg.version !== 'string' || pkg.version.length === 0) throw new Error('package.json must contain a version');
const template = await readFile(join(root, 'packaging', 'homebrew', 'miengu.rb'), 'utf8');
await writeFile(
  join(root, 'release', 'miengu.rb'),
  template
    .replaceAll('__MIENGU_REPOSITORY__', repository)
    .replaceAll('__MIENGU_VERSION__', pkg.version)
    .replaceAll('__RELEASE_SHA256__', sha256),
);
