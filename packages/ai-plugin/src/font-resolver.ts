/**
 * Safe Illustrator font resolver.
 *
 * Important rule:
 *   Never call app.textFonts.getByName() unless we already know the font
 *   exists. In practice this module does not need getByName at all; it
 *   stores the actual TextFont objects found during discovery and returns
 *   those objects directly.
 */

import {
  getFontMapCandidates,
  loadFontMap,
  type LoadedFontMap,
  type FontMapRequest,
} from './fontmap';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aiModule: any = require('illustrator');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = aiModule.app;

interface DiscoveredFont {
  postScriptName: string;
  family: string;
  style: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  font: any;
}

export interface FontSubstitutionRecord {
  requested: string;
  resolved: string | null;
  count: number;
  reason: string;
}

export interface FontResolutionStats {
  discoveredFonts: number;
  substitutions: FontSubstitutionRecord[];
  warnings: string[];
}

interface FontResolutionAccumulator {
  substitutions: Map<string, FontSubstitutionRecord>;
  warnings: Set<string>;
}

const HARD_FALLBACKS = [
  'ArialMT',
  'Helvetica',
  'MyriadPro-Regular',
];

let loadedFontMap: LoadedFontMap | null = null;
let discovered = false;
let availablePostScriptNames = new Set<string>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fontsByPostScriptName = new Map<string, any>();
let discoveredFonts: DiscoveredFont[] = [];

const accumulator: FontResolutionAccumulator = {
  substitutions: new Map(),
  warnings: new Set(),
};

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isItalicStyle(value: unknown): boolean {
  return /italic|oblique/i.test(String(value ?? ''));
}

function isBoldStyle(value: unknown): boolean {
  return /semibold|demibold|bold|black|heavy|extrabold|ultra/i.test(String(value ?? ''));
}

function getTextFontPostScriptName(font: unknown): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f: any = font;
    const name = String(f?.name ?? f?.postScriptName ?? '').trim();
    return name || null;
  } catch {
    return null;
  }
}

function getTextFontFamily(font: unknown): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f: any = font;
    return String(f?.family ?? '').trim();
  } catch {
    return '';
  }
}

function getTextFontStyle(font: unknown): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f: any = font;
    return String(f?.style ?? '').trim();
  } catch {
    return '';
  }
}

function addWarning(message: string): void {
  accumulator.warnings.add(message);
}

function recordSubstitution(
  requested: string,
  resolved: string | null,
  reason: string
): void {
  const key = `${requested} -> ${resolved ?? '(not applied)'} | ${reason}`;
  const existing = accumulator.substitutions.get(key);

  if (existing) {
    existing.count += 1;
    return;
  }

  accumulator.substitutions.set(key, {
    requested,
    resolved,
    count: 1,
    reason,
  });
}

function fontRequestLabel(request: FontMapRequest): string {
  if (request.postScriptName) return request.postScriptName;

  const family = request.fontFamily || 'Unknown family';
  const weight = request.fontWeight ?? 400;
  const style = request.fontStyle || 'normal';

  return `${family} ${weight} ${style}`;
}

function getFontMap(): LoadedFontMap {
  if (!loadedFontMap) {
    loadedFontMap = loadFontMap();

    if (loadedFontMap.loadError) {
      addWarning(`[Bridge] Font map warning: ${loadedFontMap.loadError}`);
    }
  }

  return loadedFontMap;
}

export function resetFontResolutionStats(): void {
  accumulator.substitutions.clear();
  accumulator.warnings.clear();
}

export function resetFontResolverCache(): void {
  loadedFontMap = null;
  discovered = false;
  availablePostScriptNames = new Set();
  fontsByPostScriptName = new Map();
  discoveredFonts = [];
  resetFontResolutionStats();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function discoverIllustratorFonts(aiApp: any = app): void {
  if (discovered) return;

  availablePostScriptNames = new Set();
  fontsByPostScriptName = new Map();
  discoveredFonts = [];

  try {
    const textFonts = aiApp?.textFonts;
    const length = Number(textFonts?.length ?? 0);

    for (let i = 0; i < length; i++) {
      try {
        const font = textFonts[i];
        const postScriptName = getTextFontPostScriptName(font);
        if (!postScriptName) continue;

        const family = getTextFontFamily(font);
        const style = getTextFontStyle(font);

        availablePostScriptNames.add(postScriptName);
        fontsByPostScriptName.set(postScriptName, font);
        discoveredFonts.push({
          postScriptName,
          family,
          style,
          font,
        });
      } catch {
        // Skip individual font objects that Illustrator refuses to expose.
      }
    }

    discovered = true;

    if (availablePostScriptNames.size === 0) {
      addWarning('[Bridge] Illustrator font discovery returned zero fonts; text font assignment will be skipped.');
    }
  } catch (e) {
    discovered = true;
    addWarning(`[Bridge] Could not enumerate Illustrator fonts: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function hasDiscoveredFont(postScriptName: string): boolean {
  discoverIllustratorFonts();
  return availablePostScriptNames.has(postScriptName);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getDiscoveredFont(postScriptName: string): any | null {
  discoverIllustratorFonts();
  return fontsByPostScriptName.get(postScriptName) ?? null;
}

function findByFamilyStyleHeuristic(request: FontMapRequest): DiscoveredFont | null {
  const family = normalize(request.fontFamily);
  if (!family) return null;

  const wantsItalic = isItalicStyle(request.fontStyle);
  const wantsBold = Number(request.fontWeight ?? 400) >= 600;

  const exactFamily = discoveredFonts.filter((f) => normalize(f.family) === family);
  if (exactFamily.length === 0) return null;

  const styleMatch = exactFamily.find((f) => {
    const fontIsItalic = isItalicStyle(f.style);
    const fontIsBold = isBoldStyle(f.style);
    return fontIsItalic === wantsItalic && fontIsBold === wantsBold;
  });

  if (styleMatch) return styleMatch;

  // Conservative fallback inside the same family only.
  // Prefer regular for regular requests, otherwise first exact-family font.
  if (!wantsBold && !wantsItalic) {
    const regular = exactFamily.find((f) => /regular|roman|book/i.test(f.style));
    if (regular) return regular;
  }

  return exactFamily[0] ?? null;
}

function resolveDefaultFallback(requested: string): string | null {
  const fontMap = getFontMap();
  const candidates = [
    ...fontMap.defaultPostScriptNames,
    ...HARD_FALLBACKS,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (availablePostScriptNames.has(candidate)) {
      recordSubstitution(requested, candidate, 'fallback');
      return candidate;
    }
  }

  recordSubstitution(requested, null, 'missing fallback');
  addWarning(
    `[Bridge] Missing font "${requested}" and no configured fallback was available. ` +
    `Set "_default" in ~/.bridge-cache/fontmap.json to an installed PostScript font name.`
  );
  return null;
}

/**
 * Resolve an IR/Figma text run to an Illustrator TextFont object.
 *
 * Returns null when no safe font is available. Callers should simply avoid
 * assigning attrs.textFont in that case.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function resolveFont(run: FontMapRequest): any | null {
  discoverIllustratorFonts();

  const requested = fontRequestLabel(run);

  // 1. Exact PostScript name from IR.
  if (run.postScriptName && availablePostScriptNames.has(run.postScriptName)) {
    return getDiscoveredFont(run.postScriptName);
  }

  // 2. Local per-machine fontmap.
  const mappedCandidates = getFontMapCandidates(getFontMap(), run);
  for (const candidate of mappedCandidates) {
    if (availablePostScriptNames.has(candidate)) {
      if (candidate !== run.postScriptName) {
        recordSubstitution(requested, candidate, 'fontmap');
      }
      return getDiscoveredFont(candidate);
    }
  }

  // 3. Conservative family/style heuristic from already-discovered fonts.
  const heuristic = findByFamilyStyleHeuristic(run);
  if (heuristic) {
    recordSubstitution(requested, heuristic.postScriptName, 'family/style heuristic');
    return heuristic.font;
  }

  // 4. Configurable default fallback.
  const fallback = resolveDefaultFallback(requested);
  return fallback ? getDiscoveredFont(fallback) : null;
}

export function getFontResolutionStats(): FontResolutionStats {
  return {
    discoveredFonts: availablePostScriptNames.size,
    substitutions: Array.from(accumulator.substitutions.values()),
    warnings: Array.from(accumulator.warnings.values()),
  };
}
