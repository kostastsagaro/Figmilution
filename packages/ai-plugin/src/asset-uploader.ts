/**
 * Uploads raster bytes from Illustrator to the companion's asset store.
 * Established in M2.
 *
 * Sources bytes from PlacedItem (linked file on disk) or RasterItem
 * (embedded — exported via ExtendScript bridge). The latter path is
 * the version-fragile one; we use executeAsModalForUXP and accept that
 * older AI versions may not support it.
 */

import type { Size2D } from '@bridge/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const uxp: any = require('uxp');
const localFileSystem = uxp.storage.localFileSystem;

export interface UploadedAsset {
  hash: string;
  format: string;
  byteLength: number;
  naturalSize: Size2D;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readPlacedItemBytes(placedItem: any): Promise<{ bytes: ArrayBuffer; format: string } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file: any = placedItem.file;
    if (!file) return null;
    const nativePath: string | undefined = file.fsName ?? file.nativePath ?? file.fullName;
    if (!nativePath) return null;
    const entry = await localFileSystem.getEntryWithUrl(`file:${nativePath}`);
    const bytes = await entry.read({ format: uxp.storage.formats.binary });
    const format = mimeFromPath(nativePath);
    return { bytes, format };
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readRasterItemBytes(rasterItem: any): Promise<{ bytes: ArrayBuffer; format: string } | null> {
  try {
    const tempFolder = await localFileSystem.getTemporaryFolder();
    const tempName = `bridge-raster-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`;
    const tempEntry = await tempFolder.createFile(tempName, { overwrite: true });
    const tempPath = tempEntry.nativePath;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const app: any = require('illustrator').app;
    const itemName: string = String(rasterItem.name ?? '');

    const script = `
      (function() {
        var doc = app.activeDocument;
        var target = null;
        for (var i = 0; i < doc.rasterItems.length; i++) {
          if (doc.rasterItems[i].name === ${JSON.stringify(itemName)}) {
            target = doc.rasterItems[i];
            break;
          }
        }
        if (!target) return 'NOT_FOUND';
        var f = new File(${JSON.stringify(tempPath)});
        var opts = new ExportOptionsPNG24();
        opts.transparency = true;
        opts.artBoardClipping = false;
        doc.exportFile(f, ExportType.PNG24, opts);
        return 'OK';
      })();
    `;

    const result = await app.executeAsModalForUXP?.(script) ?? 'UNSUPPORTED';
    if (result === 'NOT_FOUND' || result === 'UNSUPPORTED') {
      await tempEntry.delete();
      return null;
    }

    const bytes = await tempEntry.read({ format: uxp.storage.formats.binary });
    await tempEntry.delete().catch(() => undefined);
    return { bytes, format: 'image/png' };
  } catch {
    return null;
  }
}

export async function uploadBytes(
  assetBaseUrl: string,
  bytes: ArrayBuffer,
  format: string,
  naturalSize: Size2D
): Promise<UploadedAsset> {
  const response = await fetch(`${assetBaseUrl}/assets`, {
    method: 'POST',
    headers: { 'Content-Type': format },
    body: bytes,
  });
  if (!response.ok) {
    throw new Error(`asset upload failed: HTTP ${response.status}`);
  }
  const json = (await response.json()) as { hash: string; byteLength: number };
  return {
    hash: json.hash,
    format,
    byteLength: json.byteLength,
    naturalSize,
  };
}

function mimeFromPath(p: string): string {
  const ext = p.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'tif':
    case 'tiff': return 'image/tiff';
    case 'bmp': return 'image/bmp';
    default: return 'application/octet-stream';
  }
}
