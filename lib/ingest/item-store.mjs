/**
 * Item store — per-item atomic cache for ingest results.
 * Replaces the old shared metadata.json array pattern.
 *
 * Storage layout:
 *   cache/ingest/items/<CODE>.json   — per-item metadata
 *   cache/ingest/covers/<CODE>.jpg   — cover images
 *   ingest-index.json                — rebuilt from items after run
 */

import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { log, getSkillPath, writeJsonAtomic, readJson } from '../shared.mjs';

const ITEMS_DIR = () => getSkillPath('cache/ingest/items');
const COVERS_DIR = () => getSkillPath('cache/ingest/covers');
const INDEX_FILE = () => getSkillPath('ingest-index.json');

/**
 * Write a single item to per-item cache.
 * @param {object} metadata - scraped item metadata
 * @param {{ runId?: string, maker?: string }} [context]
 */
export async function writeItem(metadata, context = {}) {
  if (!metadata?.code) return;

  const code = metadata.code;
  const itemsDir = ITEMS_DIR();

  try {
    if (!existsSync(itemsDir)) mkdirSync(itemsDir, { recursive: true });

    const entry = {
      code,
      cachedAt: new Date().toISOString(),
      runId: context.runId || null,
      source: metadata.source || 'unknown',
      maker: context.maker || null,
      metadata,
    };

    const filePath = join(itemsDir, `${code}.json`);
    writeJsonAtomic(filePath, entry);
    log(`[item-store] Cached item ${code}`, 'debug');
  } catch (error) {
    log(`[item-store] Failed to cache item ${code}: ${error.message}`, 'error');
  }
}

/**
 * Read a single item from cache.
 * @param {string} code
 * @returns {object|null}
 */
export function readItem(code) {
  try {
    return readJson(join(ITEMS_DIR(), `${code}.json`));
  } catch {
    return null;
  }
}

/**
 * Read all items from the items directory.
 * @returns {Array<object>}
 */
export function readAllItems() {
  const itemsDir = ITEMS_DIR();
  if (!existsSync(itemsDir)) return [];

  try {
    const files = readdirSync(itemsDir).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      try {
        return readJson(join(itemsDir, f));
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Merge all per-item files into a single metadata.json (backward-compat
 * for Stage 6 notify and Stage 7 delete). Called after rebuildIngestIndex().
 */
export async function writeMergedMetadata() {
  const items = readAllItems();
  if (items.length === 0) return;

  const metadataPath = getSkillPath('cache/ingest/metadata.json');
  await writeJsonAtomic(metadataPath, items);
  log(`[item-store] Merged ${items.length} items → metadata.json`, 'info');
}

/**
 * Rebuild ingest-index.json from all per-item files.
 * Should be called once after the entire run completes.
 */
export async function rebuildIngestIndex() {
  const items = readAllItems();

  if (items.length === 0) {
    log('[item-store] No items to rebuild index from', 'debug');
    return;
  }

  // Deduplicate by code (latest write wins)
  const map = new Map();
  for (const item of items) {
    if (!item?.code) continue;
    map.set(item.code, {
      code: item.code,
      scrapedAt: item.metadata?.scrapedAt || item.cachedAt || new Date().toISOString(),
      title: item.metadata?.title || item.metadata?.cleanTitle || '',
      source: item.source || item.metadata?.source || 'unknown',
    });
  }

  const updatedItems = Array.from(map.values()).sort(
    (a, b) => new Date(b.scrapedAt) - new Date(a.scrapedAt)
  );

  await writeJsonAtomic(INDEX_FILE(), {
    updatedAt: new Date().toISOString(),
    items: updatedItems,
  });

  log(`[item-store] Rebuilt ingest index with ${updatedItems.length} items`, 'info');
}

/**
 * Ensure cover directory exists. Returns the cover directory path.
 * @returns {string}
 */
export function ensureCoverDir() {
  const dir = COVERS_DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
