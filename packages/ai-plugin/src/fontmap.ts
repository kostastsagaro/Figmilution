/**
 * Font map loader for Bridge.
 *
 * Reads a local, per-machine cache:
 *
 *   ~/.bridge-cache/fontmap.json
 *
 * Supported shape:
 *
 * {
 *   "_default": "ArialMT",
 *   "Inter": "Inter-Regular",
 *   "Inter|Regular": "Inter-Regular",
 *   "Inter|700|normal": "Inter-Bold",
 *   "Inter|italic": "Inter-Italic"
 * }
 *
 * Keys are matched case-insensitively after whitespace normalization.
 * Values may be strings or arrays of strings. Arrays are tried in order.
 */

export interface FontMapRequest {
  fontFamily?: string | null;
  fontStyle?: string | null;
  fontWeight?: number | null;
  postScriptName?: string | null;
}

export interface LoadedFontMap {
  path: string | null;
  raw: Record<string, unknown>;
  normalized: Map<string, string[]>;
  defaultPostScriptNames: string[];
  loadError?: string;
}

const FONTMAP_FILE = 'fontmap.json';

function normalizePart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function normalizeFontMapKey(value: unknown): string {
  return normalizePart(value);
}

function toCandidateList(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  return [];
}

function getEnv(name: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proc: any = typeof process !== 'undefined' ? process : null;
    const value = proc?.env?.[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function joinPath(...parts: string[]): string {
  const cleaned = parts
    .filter(Boolean)
    .map((p, idx) => {
      if (idx === 0) return p.replace(/[\\/]+$/, '');
      return p.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    });

  const first = cleaned[0] ?? '';
  const sep = first.includes('\\') ? '\\' : '/';
  return cleaned.join(sep);
}

export function getBridgeCacheDir(): string | null {
  const userProfile = getEnv('USERPROFILE');
  if (userProfile) return joinPath(userProfile, '.bridge-cache');

  const homeDrive = getEnv('HOMEDRIVE');
  const homePath = getEnv('HOMEPATH');
  if (homeDrive && homePath) return joinPath(`${homeDrive}${homePath}`, '.bridge-cache');

  const home = getEnv('HOME');
  if (home) return joinPath(home, '.bridge-cache');

  return null;
}

export function getFontMapPath(): string | null {
  const dir = getBridgeCacheDir();
  return dir ? joinPath(dir, FONTMAP_FILE) : null;
}

function tryReadFileSync(path: string): string | null {
  try {
    // UXP availability varies by host/version. If Node-style fs is not
    // available, fail closed and continue with discovered/default fonts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fs: any = require('fs');
    if (!fs?.existsSync?.(path)) return null;
    return String(fs.readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function loadFontMap(): LoadedFontMap {
  const path = getFontMapPath();

  if (!path) {
    return {
      path: null,
      raw: {},
      normalized: new Map(),
      defaultPostScriptNames: [],
      loadError: 'Could not resolve user home directory for ~/.bridge-cache/fontmap.json',
    };
  }

  const text = tryReadFileSync(path);
  if (!text) {
    return {
      path,
      raw: {},
      normalized: new Map(),
      defaultPostScriptNames: [],
    };
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const normalized = new Map<string, string[]>();

    for (const [key, value] of Object.entries(parsed)) {
      const candidates = toCandidateList(value);
      if (candidates.length === 0) continue;
      normalized.set(normalizeFontMapKey(key), candidates);
    }

    return {
      path,
      raw: parsed,
      normalized,
      defaultPostScriptNames: toCandidateList(parsed._default),
    };
  } catch (e) {
    return {
      path,
      raw: {},
      normalized: new Map(),
      defaultPostScriptNames: [],
      loadError: e instanceof Error ? e.message : String(e),
    };
  }
}

function styleAliasFromWeightAndItalic(weight?: number | null, style?: string | null): string {
  const normalizedStyle = normalizePart(style);
  const isItalic = normalizedStyle.includes('italic') || normalizedStyle.includes('oblique');
  const w = Number(weight ?? 400);

  if (w >= 800 && isItalic) return 'Black Italic';
  if (w >= 800) return 'Black';
  if (w >= 700 && isItalic) return 'Bold Italic';
  if (w >= 700) return 'Bold';
  if (w >= 600 && isItalic) return 'SemiBold Italic';
  if (w >= 600) return 'SemiBold';
  if (isItalic) return 'Italic';
  return 'Regular';
}

export function getFontMapCandidates(
  fontMap: LoadedFontMap,
  request: FontMapRequest
): string[] {
  const family = request.fontFamily?.trim();
  if (!family) return [];

  const style = request.fontStyle?.trim() || '';
  const weight = request.fontWeight ?? 400;
  const weightStyle = styleAliasFromWeightAndItalic(weight, style);

  const keys = [
    `${family}|${request.postScriptName ?? ''}`,
    `${family}|${weight}|${style || 'normal'}`,
    `${family}|${weightStyle}`,
    `${family}|${style}`,
    family,
  ]
    .map(normalizeFontMapKey)
    .filter(Boolean);

  const out: string[] = [];

  for (const key of keys) {
    const candidates = fontMap.normalized.get(key);
    if (!candidates) continue;

    for (const candidate of candidates) {
      if (!out.includes(candidate)) out.push(candidate);
    }
  }

  return out;
}
