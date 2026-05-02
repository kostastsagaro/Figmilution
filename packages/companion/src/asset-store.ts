import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './logger';

/**
 * Content-addressed asset store. Files live on disk under
 *   <cacheDir>/assets/<sha256>.<ext>
 * keyed by the SHA-256 hash of their contents. Re-uploading identical
 * bytes is a no-op (we detect the existing file).
 *
 * No eviction: the cache grows monotonically until the user manually
 * clears it. LRU cleanup is a future maintenance milestone.
 */
export class AssetStore {
  private readonly assetDir: string;
  private readonly meta = new Map<string, { format: string; byteLength: number }>();

  constructor(cacheDir: string) {
    this.assetDir = path.join(cacheDir, 'assets');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.assetDir, { recursive: true });
    logger.info('assetStore.init', { assetDir: this.assetDir });
  }

  async put(bytes: Buffer, format: string): Promise<{ hash: string; byteLength: number }> {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const ext = mimeToExt(format);
    const filePath = path.join(this.assetDir, `${hash}.${ext}`);

    let exists = false;
    try {
      await fs.access(filePath);
      exists = true;
    } catch {
      // doesn't exist; will write below
    }

    if (!exists) {
      const tmp = `${filePath}.tmp-${process.pid}`;
      await fs.writeFile(tmp, bytes);
      await fs.rename(tmp, filePath);
      logger.info('assetStore.put', { hash, format, byteLength: bytes.length });
    } else {
      logger.debug('assetStore.put.dedup', { hash, byteLength: bytes.length });
    }

    this.meta.set(hash, { format, byteLength: bytes.length });
    return { hash, byteLength: bytes.length };
  }

  async resolve(hash: string): Promise<{ path: string; format: string; byteLength: number } | null> {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null; // path-traversal guard

    const cached = this.meta.get(hash);
    if (cached) {
      const ext = mimeToExt(cached.format);
      const p = path.join(this.assetDir, `${hash}.${ext}`);
      try {
        await fs.access(p);
        return { path: p, format: cached.format, byteLength: cached.byteLength };
      } catch {
        // fall through to disk scan
      }
    }

    const entries = await fs.readdir(this.assetDir);
    const match = entries.find((n) => n.startsWith(hash + '.'));
    if (!match) return null;

    const fullPath = path.join(this.assetDir, match);
    const ext = match.slice(hash.length + 1);
    const stat = await fs.stat(fullPath);
    const format = extToMime(ext);
    this.meta.set(hash, { format, byteLength: stat.size });
    return { path: fullPath, format, byteLength: stat.size };
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
};

function mimeToExt(mime: string): string {
  return MIME_EXT[mime.toLowerCase()] ?? 'bin';
}

function extToMime(ext: string): string {
  const lower = ext.toLowerCase();
  for (const [mime, e] of Object.entries(MIME_EXT)) {
    if (e === lower) return mime;
  }
  return 'application/octet-stream';
}
