/**
 * AI Live Effect XML templates — M8.5 PHASE B VERIFIED
 *
 * Wire format verified empirically: <LiveEffect><Dict data="..."/></LiveEffect>
 * with type-prefixed key-value pairs, parsed by applyEffect() under both
 * ExtendScript and UXP. Dictionary keys (`blur`, `opac`, `horz`, `vert`,
 * `csrc`, `dark`) verified by extracting them from the on-disk PostScript
 * appearance stream of a saved .ai document, then confirming the same
 * keys parse correctly through the XML wire format.
 *
 * VERIFIED IN PHASE B:
 *   - Drop shadow via csrc=1 (darkness mode): color derived from fill,
 *     scaled by `dark` percentage. Renders correctly.
 *   - Gaussian blur with `blur` parameter alone. Renders correctly.
 *   - Inner glow with `blur` and `opac` alone; defaults to white/screen/edge.
 *
 * KNOWN PHASE B LIMITATIONS (each is a fidelity loss, not a failure):
 *   1. Drop shadow color: Figma supplies an explicit RGBA color; we
 *      ignore it and use AI's darkness-mode shadow. The shadow renders
 *      as a darker version of the shape's fill, not as the Figma color.
 *      Hardcoded `dark = 50` matches AI's default.
 *
 *   2. Drop shadow opacity: Figma's color.a × Figma's effect opacity is
 *      mapped to the dict `opac` field directly. This works.
 *
 *   3. Inner glow color: same story as drop shadow — Figma's color is
 *      ignored, defaults to white. Inner shadow on Figma's side that
 *      uses non-white color will lose color fidelity on AI.
 *
 *   4. Inner glow center vs edge: defaults to edge. Figma doesn't have a
 *      center/edge distinction, so this is fine for one-way Figma → AI
 *      sync.
 *
 *   5. Blend modes: not propagated. AI's `blnd` integer enum hasn't been
 *      decoded; effect blend mode in IR is dropped on the AI side.
 *
 * PHASE C (future polish, NOT in this milestone):
 *   - /FillStyle injection for explicit drop shadow / inner glow color
 *     (will require csrc=0 on drop shadow and a different inner glow form).
 *   - blnd enum decoding for blend modes.
 *   - PrevDocScale / PrevDres handling for non-72-DPI documents (current
 *     code omits them; appears to default correctly for standard docs,
 *     but high-DPI work may render at wrong blur radii).
 */

export type TemplateStatus = 'unverified' | 'verified';

export const TEMPLATE_STATUS: TemplateStatus = 'verified';

// ────────────────────────────────────────────────────────────────────────
// Drop shadow
// ────────────────────────────────────────────────────────────────────────

export interface DropShadowParams {
  /** RGB color components in 0..255. Currently UNUSED — see file header. */
  red: number;
  green: number;
  blue: number;
  /** Opacity in 0..100 (AI convention). Internally divided to 0..1. */
  opacity: number;
  /** Offset in points. Mapped to AI's `horz` and `vert` dict keys. */
  offsetX: number;
  offsetY: number;
  /** Blur radius in points. */
  radius: number;
}

/**
 * Phase B drop shadow: uses darkness mode (csrc=1, dark=50). Color from
 * Figma is ignored. Shadow appears as a darker version of the shape's fill.
 *
 * Dict key reference (verified):
 *   B usePSLBlur  — use PostScript Library blur algorithm (1 = yes)
 *   I blnd        — blend mode (1 = multiply, the AI default; other values
 *                   not yet decoded)
 *   R dark        — darkness percentage when csrc=1, 0..100
 *   B pair        — paired offsets boolean (1 = yes; appears in extraction
 *                   but UI doesn't expose it; defensive default)
 *   R horz        — X offset in points
 *   R vert        — Y offset in points
 *   I csrc        — color source (0 = explicit /FillStyle, 1 = darkness-from-fill)
 *   R blur        — blur radius in points
 *   R opac        — opacity, 0..1
 */
export function buildDropShadowXml(p: DropShadowParams): string {
  const opac = Math.max(0, Math.min(1, p.opacity / 100));
  return `<LiveEffect name="Adobe Drop Shadow"><Dict data="R blur ${p.radius} R horz ${p.offsetX} R vert ${p.offsetY} R opac ${opac} R dark 50 I blnd 1 I csrc 1 B pair 1 B usePSLBlur 1 "/></LiveEffect>`;
}

// ────────────────────────────────────────────────────────────────────────
// Inner shadow (rendered as Adobe Inner Glow)
// ────────────────────────────────────────────────────────────────────────

export interface InnerShadowParams {
  /** RGB 0..255. Currently UNUSED — inner glow defaults to white. */
  red: number;
  green: number;
  blue: number;
  /** Opacity in 0..100. */
  opacity: number;
  /**
   * Offset in points. Currently UNUSED — Inner Glow has no offset,
   * it's a uniform glow. Kept in the param shape for IR compatibility
   * with Figma's directional inner shadow.
   */
  offsetX: number;
  offsetY: number;
  /** Blur radius in points. */
  radius: number;
}

/**
 * Phase B inner shadow: rendered as Adobe Inner Glow with default white
 * color, screen blend, edge mode. Figma's offset/color/blend are dropped.
 *
 * Dict keys verified to parse:
 *   R blur  — blur radius in points
 *   R opac  — opacity, 0..1
 *
 * (Other UI fields — Mode, Color, Center/Edge — use AI defaults when
 * not in the dict. Their dict keys are not yet decoded.)
 */
export function buildInnerShadowXml(p: InnerShadowParams): string {
  const opac = Math.max(0, Math.min(1, p.opacity / 100));
  return `<LiveEffect name="Adobe Inner Glow"><Dict data="R blur ${p.radius} R opac ${opac} "/></LiveEffect>`;
}

// ────────────────────────────────────────────────────────────────────────
// Gaussian blur
// ────────────────────────────────────────────────────────────────────────

export interface BlurParams {
  /** Blur radius in points. */
  radius: number;
}

/**
 * Phase B Gaussian blur: minimal dict with just the radius. PrevDocScale
 * and PrevDres environmental params omitted — they default correctly for
 * standard 72 DPI documents in tested cases. High-DPI documents may
 * render at unexpected radii; not yet verified.
 *
 * Effect name is "Adobe PSL Gaussian Blur" — note the "PSL" (PostScript
 * Library) prefix. The shorter "Adobe Gaussian Blur" name does NOT work.
 */
export function buildBlurXml(p: BlurParams): string {
  return `<LiveEffect name="Adobe PSL Gaussian Blur"><Dict data="R blur ${p.radius} "/></LiveEffect>`;
}
