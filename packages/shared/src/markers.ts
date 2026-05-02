/**
 * Markers used to track Bridge-managed nodes across syncs.
 *
 * Two distinct markers can co-exist on a single Illustrator item name:
 *   - ‹bridge:{uuid}›   — node identity (set on every Bridge-owned item)
 *   - ‹img:{shorthash}› — content hash for raster items (image nodes only)
 *
 * Plus M5 additions for library entries:
 *   - ‹style:colorabc-123› — global swatch (color style)
 *   - ‹style:textabc-123›  — character/paragraph style pair (text style)
 *   - ‹sym:abc-123›        — symbol (component definition)
 */

export const BRIDGE_ID_PLUGIN_KEY = 'bridgeId';

const BRIDGE_ID_MARKER = /‹bridge:([0-9a-f-]+)›/i;
const BRIDGE_IMG_MARKER = /‹img:([0-9a-f]+)›/i;

const ALL_MARKERS = /\s*‹(?:bridge|img):[0-9a-f-]+›/gi;

export const IMAGE_HASH_NAME_LENGTH = 16;

export function shortHash(fullHash: string): string {
  return fullHash.slice(0, IMAGE_HASH_NAME_LENGTH).toLowerCase();
}

export function extractBridgeIdFromName(name: string): string | null {
  const m = name.match(BRIDGE_ID_MARKER);
  return m ? m[1]! : null;
}

export function extractImageHashFromName(name: string): string | null {
  const m = name.match(BRIDGE_IMG_MARKER);
  return m ? m[1]!.toLowerCase() : null;
}

export function stripBridgeMarker(name: string): string {
  return name.replace(ALL_MARKERS, '').replace(/\s+$/, '').trim();
}

export function stampNameWithBridgeId(originalName: string, id: string): string {
  const cleaned = stripBridgeMarker(originalName);
  return cleaned.length > 0 ? `${cleaned} ‹bridge:${id}›` : `‹bridge:${id}›`;
}

export function stampNameWithBridgeIdAndImageHash(
  originalName: string,
  id: string,
  fullHashHex: string
): string {
  const cleaned = stripBridgeMarker(originalName);
  const sh = shortHash(fullHashHex);
  const base = cleaned.length > 0 ? cleaned : '';
  const lead = base.length > 0 ? `${base} ` : '';
  return `${lead}‹bridge:${id}› ‹img:${sh}›`;
}

export function imageHashMatches(itemName: string, irFullHash: string): boolean {
  const stored = extractImageHashFromName(itemName);
  if (!stored) return false;
  return stored === shortHash(irFullHash);
}

// ────────────────────────────────────────────────────────────────────────
// M5 additions: library marker scheme
// ────────────────────────────────────────────────────────────────────────

export const BRIDGE_SHARED_NAMESPACE = 'bridge';
export const BRIDGE_LIBRARY_BRIDGE_ID_KEY = 'libraryBridgeId';

const STYLE_COLOR_MARKER = /‹style:color([0-9a-f-]+)›/i;
const STYLE_TEXT_MARKER = /‹style:text([0-9a-f-]+)›/i;
const SYMBOL_MARKER = /‹sym:([0-9a-f-]+)›/i;
const ALL_M5_MARKERS = /\s*‹(?:style:(?:color|text)|sym):[0-9a-f-]+›/gi;

export function extractColorStyleIdFromName(name: string): string | null {
  const m = name.match(STYLE_COLOR_MARKER);
  return m ? m[1]! : null;
}

export function extractTextStyleIdFromName(name: string): string | null {
  const m = name.match(STYLE_TEXT_MARKER);
  return m ? m[1]! : null;
}

export function extractSymbolIdFromName(name: string): string | null {
  const m = name.match(SYMBOL_MARKER);
  return m ? m[1]! : null;
}

export function stripM5Markers(name: string): string {
  return name.replace(ALL_M5_MARKERS, '').replace(/\s+$/, '').trim();
}

export function stampNameWithColorStyleId(originalName: string, id: string): string {
  const cleaned = stripM5Markers(originalName);
  return cleaned.length > 0 ? `${cleaned} ‹style:color${id}›` : `‹style:color${id}›`;
}

export function stampNameWithTextStyleId(originalName: string, id: string): string {
  const cleaned = stripM5Markers(originalName);
  return cleaned.length > 0 ? `${cleaned} ‹style:text${id}›` : `‹style:text${id}›`;
}

export function stampNameWithSymbolId(originalName: string, id: string): string {
  const cleaned = stripM5Markers(originalName);
  return cleaned.length > 0 ? `${cleaned} ‹sym:${id}›` : `‹sym:${id}›`;
}
