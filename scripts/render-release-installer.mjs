import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = process.argv[2];
if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
  throw new Error('usage: node scripts/render-release-installer.mjs OWNER/REPOSITORY');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = await readFile(join(root, 'scripts', 'install.sh'), 'utf8');
await writeFile(join(root, 'release', 'miengu-install.sh'), template.replaceAll('__MIENGU_REPOSITORY__', repository), { mode: 0o755 });
