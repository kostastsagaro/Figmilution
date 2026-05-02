/**
 * Download an asset from the companion app to a temp file on the local
 * filesystem, returning the path. The path is suitable for passing to
 * Illustrator's PlacedItem.file = File(path) sequence.
 *
 * Established M3. Caller is responsible for calling deleteAsset() after
 * the embed completes — we don't auto-clean because embed() needs the
 * file to persist until it reads the bytes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const uxp: any = require('uxp');
const localFileSystem = uxp.storage.localFileSystem;

export interface DownloadedAsset {
  nativePath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  entry: any;
  format: string;
  byteLength: number;
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]?.trim();
  switch (m) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/tiff': return 'tiff';
    case 'image/bmp': return 'bmp';
    default: return 'bin';
  }
}

export async function downloadAsset(
  assetBaseUrl: string,
  hash: string,
  format: string
): Promise<DownloadedAsset> {
  const res = await fetch(`${assetBaseUrl}/assets/${hash}`);
  if (!res.ok) throw new Error(`asset ${hash}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const tempFolder = await localFileSystem.getTemporaryFolder();
  const ext = extFromMime(format);
  const filename = `bridge-tmp-${hash.slice(0, 16)}-${Date.now()}.${ext}`;
  const entry = await tempFolder.createFile(filename, { overwrite: true });
  await entry.write(buf, { format: uxp.storage.formats.binary });

  return {
    nativePath: entry.nativePath,
    entry,
    format,
    byteLength: buf.byteLength,
  };
}

export async function deleteAsset(asset: DownloadedAsset): Promise<void> {
  try {
    await asset.entry.delete();
  } catch {
    // Non-fatal: temp folder will eventually be cleaned by the OS.
  }
}
