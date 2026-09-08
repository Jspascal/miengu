import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { loadConfig } from '../../config/load.js';
import { itemPaths, listItemIds } from '../../core/log.js';
import { sha256Hex } from '../../core/hash.js';
import type { WorkItemId } from '../../core/ids.js';
import { deriveClaims } from '../../wiki/records.js';
import { isRenderedWikiPath, renderHumanView, WIKI_DIR } from '../../wiki/humanview.js';
import type { HumanViewItem } from '../../wiki/humanview.js';
import { EXIT } from '../exit.js';
import { readEventsReadOnly } from './replay.js';

export interface WikiRenderCommandOptions {
  readonly configPath?: string | undefined;
  readonly json?: boolean | undefined;
}

interface WrittenFileInfo {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/** Every file this renderer's own paths currently occupy on disk, store-relative and POSIX
 *  separated, so `isRenderedWikiPath` can be applied against them for pruning (§7). `readdir`'s
 *  own recursive listing also yields intermediate directory entries; those never match
 *  `isRenderedWikiPath`'s `.md` suffix and are excluded by that check alone. */
async function listExistingWikiPaths(storeDir: string): Promise<string[]> {
  const wikiDir = join(storeDir, WIKI_DIR);
  let entries: string[];
  try {
    entries = await readdir(wikiDir, { recursive: true });
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries.map((entry) => `${WIKI_DIR}/${entry.split(sep).join('/')}`);
}

/**
 * `loadConfig` -> `listItemIds` -> per-item read-only event load -> `renderHumanView`. Writes
 * are the sole responsibility of this command (§15/§12): `renderHumanView` itself performs no
 * I/O. A corrupt item is isolated and reported; other items still render (§6). Never acquires
 * the write lock, appends an event, writes a snapshot, or deletes a path outside
 * `<storeDir>/wiki/`.
 */
export async function wikiRenderCommand(options: WikiRenderCommandOptions): Promise<number> {
  const loaded = await loadConfig(options.configPath);
  const itemIds = await listItemIds(loaded.storeDir);

  const items: HumanViewItem[] = [];
  const corrupt: { readonly itemId: WorkItemId; readonly error: string }[] = [];
  let claims = 0;

  for (const itemId of itemIds) {
    try {
      const paths = itemPaths(loaded.storeDir, itemId);
      const events = await readEventsReadOnly(paths.eventsFile, itemId);
      items.push({ itemId, events });
      claims += deriveClaims(events).claims.length;
    } catch (err) {
      corrupt.push({ itemId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const files = renderHumanView({ language: loaded.config.wiki.language, items });

  const written: WrittenFileInfo[] = [];
  const writtenPaths = new Set<string>();
  for (const file of files) {
    const destination = join(loaded.storeDir, ...file.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
    written.push({
      path: file.path,
      sha256: sha256Hex(file.content),
      bytes: Buffer.byteLength(file.content, 'utf8'),
    });
    writtenPaths.add(file.path);
  }

  const existing = await listExistingWikiPaths(loaded.storeDir);
  const removed: string[] = [];
  for (const relPath of existing) {
    if (!isRenderedWikiPath(relPath) || writtenPaths.has(relPath)) {
      continue;
    }
    await rm(join(loaded.storeDir, ...relPath.split('/')));
    removed.push(relPath);
  }
  removed.sort();

  const anyCorrupt = corrupt.length > 0;

  if (options.json === true) {
    const payload = {
      files: written,
      removed,
      items: items.length,
      claims,
      language: loaded.config.wiki.language,
      corrupt,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return anyCorrupt ? EXIT.STORE : EXIT.OK;
  }

  const lines = written.map((f) => `wrote ${f.path}`);
  for (const relPath of removed) {
    lines.push(`removed ${relPath}`);
  }
  for (const c of corrupt) {
    lines.push(`corrupt ${c.itemId}: ${c.error}`);
  }
  lines.push(
    `${String(written.length)} files, ${String(items.length)} items, ${String(claims)} claims`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);

  return anyCorrupt ? EXIT.STORE : EXIT.OK;
}
