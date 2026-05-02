/**
 * ═══════════════════════════════════════════════════════════════════════
 * RECONSTRUCTION FILE — figma-to-ir.ts
 * ═══════════════════════════════════════════════════════════════════════
 *
 * This file received patches across M3, M4, M5, M5.5, and M6. The chat
 * showed deltas for each milestone but never a single end-to-end version.
 * I'm assembling what I'm confident about with explicit MERGE markers
 * where I had to choose between possible patch states.
 *
 * Milestone summary:
 *   M3:    Initial sender. selectionToPreliminaryDocument, frame walk,
 *          per-leaf translators (vector, text, image), SVG path parser.
 *   M4:    No changes here (reconciliation was receiver-side).
 *   M4.5:  No changes here.
 *   M5:    LibraryAccumulator, stableId via pluginData, component
 *          extraction, instance translation, style-aware paint extraction.
 *   M5.5:  Renamed "Loose Selection" → "Pasteboard".
 *   M6:    Gradient extraction, multi-style text run-length consolidation,
 *          group/clip path translation, container.clipsContent.
 *
 * KNOWN GAPS (search for "TODO MERGE"):
 *   1. Some helpers (uuid, parseSvgPathToAnchors, readNodePosition,
 *      sniffImageFormat, imageBearingNodeToIR) were defined in M3 but
 *      not re-shown in later milestones. I've stubbed them with TODO
 *      markers; pull from your M3 git checkout.
 *   2. The `PreliminaryDocument` type lived in this file but its full
 *      definition was never re-shown after M3. Stub at top.
 *   3. Several function signatures changed across milestones (e.g.,
 *      figmaPaintToBridge gained nodeName parameter in M6). I've taken
 *      the M6 version as canonical.
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  BRIDGE_ID_PLUGIN_KEY,
  BRIDGE_SHARED_NAMESPACE,
  BRIDGE_LIBRARY_BRIDGE_ID_KEY,
  BRIDGE_SCHEMA_VERSION,
  type Affine2x3,
  type Anchor,
  type BridgeDocument,
  type BridgeLibrary,
  type BridgeLinearGradientPaint,
  type BridgePaint,
  type BridgeRadialGradientPaint,
  type ColorRGBA,
  type ColorStop,
  type ColorStyleDef,
  type ComponentDef,
  type Container,
  type GroupNode as IRGroupNode,
  type ImageNode as IRImageNode,
  type ImageRef,
  type InstanceNode as IRInstanceNode,
  type InstanceOverride,
  type Node as IRNode,
  type Point2D,
  type Subpath,
  type TextNode as IRTextNode,
  type TextParagraph,
  type TextRun,
  type TextStyleDef,
  type VectorNode as IRVectorNode,
  figmaLinearTransformToUnitEndpoints,
  figmaRadialTransformToUnitEndpoints,
  isFigmaRadialApproximatelyCircular,
} from '@bridge/shared';

// ────────────────────────────────────────────────────────────────────────
// Preliminary document types — TODO MERGE: full definitions from M3
// The preliminary doc is what the sandbox emits before the iframe
// uploads images and rewrites them as final ImageRefs.
// ────────────────────────────────────────────────────────────────────────

export interface PreliminaryImageRef {
  bytes: Uint8Array;
  format: string;
  byteLength: number;
}

export interface PreliminaryImageNode extends Omit<IRImageNode, 'image'> {
  preliminaryImage: PreliminaryImageRef;
}

export type PreliminaryNode =
  | IRVectorNode
  | IRTextNode
  | PreliminaryImageNode
  | IRInstanceNode
  | IRGroupNode; // M6 addition; verify GroupNode children also need PreliminaryNode handling

export interface PreliminaryContainer extends Omit<Container, 'children'> {
  children: PreliminaryNode[];
}

export interface PreliminaryDocument extends Omit<BridgeDocument, 'containers' | 'assets'> {
  containers: PreliminaryContainer[];
  assets: { images: Record<string, ImageRef> };
}

const DEG_TO_RAD = Math.PI / 180;

// ────────────────────────────────────────────────────────────────────────
// TODO MERGE: stableId, freshUuid (M5)
// These were shown in the M5 patch as a "replace the M3 uuid() block".
// Pull from git: src/figma-to-ir.ts in your M5 checkout.
// ────────────────────────────────────────────────────────────────────────

function freshUuid(): string {
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

function stableId(node: BaseNode): string {
  const existing = node.getPluginData(BRIDGE_ID_PLUGIN_KEY);
  if (existing) return existing;
  const fresh = freshUuid();
  try {
    node.setPluginData(BRIDGE_ID_PLUGIN_KEY, fresh);
  } catch {
    // ignore in read-only contexts
  }
  return fresh;
}

function stableIdContainer(node: BaseNode): string {
  return stableId(node);
}

function stableLibraryBridgeId(
  figmaItem: BaseStyle | ComponentNode,
  acc: LibraryAccumulator
): string {
  const cached = acc.figmaToBridge.get(figmaItem.id);
  if (cached) return cached;
  const stored = figmaItem.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
  if (stored) {
    acc.figmaToBridge.set(figmaItem.id, stored);
    return stored;
  }
  const fresh = freshUuid();
  try {
    figmaItem.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, fresh);
  } catch { /* ignore */ }
  acc.figmaToBridge.set(figmaItem.id, fresh);
  return fresh;
}

// ────────────────────────────────────────────────────────────────────────
// Library accumulator (M5)
// ────────────────────────────────────────────────────────────────────────

interface LibraryAccumulator {
  components: Map<string, ComponentDef>;
  colorStyles: Map<string, ColorStyleDef>;
  textStyles: Map<string, TextStyleDef>;
  figmaToBridge: Map<string, string>;
}

function newAccumulator(): LibraryAccumulator {
  return {
    components: new Map(),
    colorStyles: new Map(),
    textStyles: new Map(),
    figmaToBridge: new Map(),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Image format sniffing (M3) — TODO MERGE: verify against your M3 file
// ────────────────────────────────────────────────────────────────────────

function sniffImageFormat(bytes: Uint8Array): string {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 &&
      bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

// ────────────────────────────────────────────────────────────────────────
// Paint translation (M6: gradient-aware)
// ────────────────────────────────────────────────────────────────────────

function gradientPaintToBridge(
  p: GradientPaint,
  nodeName: string
): BridgeLinearGradientPaint | BridgeRadialGradientPaint | null {
  const transform: Affine2x3 = p.gradientTransform as unknown as Affine2x3;
  const stops: ColorStop[] = p.gradientStops.map((s) => ({
    position: s.position,
    color: { r: s.color.r, g: s.color.g, b: s.color.b, a: s.color.a },
  }));

  if (p.type === 'GRADIENT_LINEAR') {
    const { startUnit, endUnit } = figmaLinearTransformToUnitEndpoints(transform);
    return {
      type: 'linearGradient',
      startUnit,
      endUnit,
      stops,
      opacity: p.opacity ?? 1,
      visible: p.visible ?? true,
    };
  }

  if (p.type === 'GRADIENT_RADIAL') {
    if (!isFigmaRadialApproximatelyCircular(transform)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Bridge] Radial gradient on "${nodeName}" is elliptical; ` +
        `approximating as circular for cross-app compatibility.`
      );
    }
    const { centerUnit, radiusEndUnit } = figmaRadialTransformToUnitEndpoints(transform);
    return {
      type: 'radialGradient',
      centerUnit,
      radiusEndUnit,
      stops,
      opacity: p.opacity ?? 1,
      visible: p.visible ?? true,
    };
  }

  return null;
}

function figmaPaintToBridge(p: Paint, nodeName: string = ''): BridgePaint | null {
  if (p.type === 'SOLID') {
    const opacity = p.opacity ?? 1;
    return {
      type: 'solid',
      color: { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 },
      opacity,
      visible: p.visible ?? true,
    };
  }
  if (p.type === 'GRADIENT_LINEAR' || p.type === 'GRADIENT_RADIAL') {
    return gradientPaintToBridge(p, nodeName);
  }
  if (p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND') {
    const firstStop = p.gradientStops[0];
    if (!firstStop) return null;
    return {
      type: 'solid',
      color: {
        r: firstStop.color.r,
        g: firstStop.color.g,
        b: firstStop.color.b,
        a: firstStop.color.a,
      },
      opacity: p.opacity ?? 1,
      visible: p.visible ?? true,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Color/text style extraction (M5)
// TODO MERGE: full bodies from M5 patch
// ────────────────────────────────────────────────────────────────────────

function isSupportedPaintStylePaint(p: Paint): boolean {
  return p.type === 'SOLID'
    || p.type === 'GRADIENT_LINEAR'
    || p.type === 'GRADIENT_RADIAL'
    || p.type === 'GRADIENT_ANGULAR'
    || p.type === 'GRADIENT_DIAMOND';
}

function extractColorStyleByFigmaId(
  figmaStyleId: string,
  acc: LibraryAccumulator
): string | null {
  if (!figmaStyleId) return null;
  const cleanId = figmaStyleId.replace(/,\s*$/, '');
  const style = figma.getStyleById(cleanId) as PaintStyle | null;
  if (!style || style.type !== 'PAINT') return null;

  const bridgeId = stableLibraryBridgeId(style, acc);
  if (acc.colorStyles.has(bridgeId)) return bridgeId;

  const visiblePaints = style.paints.filter((p) => p.visible !== false);
  const supportedPaints = visiblePaints.filter(isSupportedPaintStylePaint);
  const firstPaint = supportedPaints[0];

  if (!firstPaint) {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Paint style "${style.name}" has no supported visible paint; skipping style.`);
    return null;
  }

  if (supportedPaints.length > 1) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Paint style "${style.name}" has multiple visible paints; ` +
      `using the first supported paint for the library style.`
    );
  }

  if (firstPaint.type === 'GRADIENT_ANGULAR' || firstPaint.type === 'GRADIENT_DIAMOND') {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Paint style "${style.name}" uses ${firstPaint.type}; ` +
      `approximating the library style with its first gradient stop.`
    );
  }

  const paint = figmaPaintToBridge(firstPaint, style.name);
  if (!paint) return null;

  acc.colorStyles.set(bridgeId, {
    id: bridgeId,
    name: style.name,
    paint,
    sourceMeta: { figmaId: style.id },
  });
  return bridgeId;
}

function extractTextStyleByFigmaId(
  figmaStyleId: string,
  acc: LibraryAccumulator
): string | null {
  // TODO MERGE: full body from M5. The M5 patch shows complete
  // implementation including unit conversions for letterSpacing and
  // lineHeight, weight detection from style string, and writing the
  // TextStyleDef into the accumulator.
  if (!figmaStyleId) return null;
  const cleanId = figmaStyleId.replace(/,\s*$/, '');
  const style = figma.getStyleById(cleanId) as TextStyle | null;
  if (!style || style.type !== 'TEXT') return null;

  const bridgeId = stableLibraryBridgeId(style, acc);
  if (acc.textStyles.has(bridgeId)) return bridgeId;

  const fontSize = style.fontSize;
  let letterSpacingPt = 0;
  if (style.letterSpacing.unit === 'PIXELS') {
    letterSpacingPt = style.letterSpacing.value;
  } else if (style.letterSpacing.unit === 'PERCENT') {
    letterSpacingPt = (style.letterSpacing.value / 100) * fontSize;
  }
  let lineHeightPt = 0;
  if (style.lineHeight.unit === 'PIXELS') lineHeightPt = style.lineHeight.value;
  else if (style.lineHeight.unit === 'PERCENT') lineHeightPt = (style.lineHeight.value / 100) * fontSize;

  const styleStr = style.fontName.style;
  const fontWeight = /bold|black|heavy|extrabold|semibold/i.test(styleStr) ? 700 : 400;
  const fontStyleVal: 'normal' | 'italic' = /italic|oblique/i.test(styleStr) ? 'italic' : 'normal';

  acc.textStyles.set(bridgeId, {
    id: bridgeId,
    name: style.name,
    fontFamily: style.fontName.family,
    postScriptName: null,
    fontWeight,
    fontStyle: fontStyleVal,
    fontSize,
    letterSpacing: letterSpacingPt,
    lineHeight: lineHeightPt,
    alignH: (style as any).textAlignHorizontal === 'JUSTIFIED' ? 'justify'
      : (style as any).textAlignHorizontal === 'CENTER' ? 'center'
      : (style as any).textAlignHorizontal === 'RIGHT' ? 'right'
      : 'left',
    fillPaint: null,
    sourceMeta: { figmaId: style.id },
  });
  return bridgeId;
}

function figmaPaintsWithStyleLink(
  fills: readonly Paint[] | typeof figma.mixed,
  fillStyleId: string | typeof figma.mixed,
  acc: LibraryAccumulator,
  nodeName: string = ''
): BridgePaint[] {
  if (fills === figma.mixed) return [];
  const linkedBridgeId = (typeof fillStyleId === 'string' && fillStyleId.length > 0)
    ? extractColorStyleByFigmaId(fillStyleId, acc)
    : null;
  const out: BridgePaint[] = [];
  for (const p of fills) {
    const fp = figmaPaintToBridge(p, nodeName);
    if (!fp) continue;
    if (linkedBridgeId && out.length === 0) {
      fp.styleId = linkedBridgeId;
    }
    out.push(fp);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Component dependency extraction — M11.1
// ────────────────────────────────────────────────────────────────────────

function collectComponentDependenciesFromNode(
  node: IRNode,
  out: Set<string>
): void {
  if (node.type === 'instance') {
    if (node.componentId) out.add(node.componentId);
    return;
  }

  if (node.type === 'group') {
    for (const child of node.children) {
      collectComponentDependenciesFromNode(child, out);
    }
    if (node.clipPath) {
      collectComponentDependenciesFromNode(node.clipPath, out);
    }
  }
}

export function collectComponentDependencies(
  children: readonly IRNode[],
  selfId?: string
): string[] {
  const out = new Set<string>();

  for (const child of children) {
    collectComponentDependenciesFromNode(child, out);
  }

  if (selfId) out.delete(selfId);

  return Array.from(out).sort();
}

function withComponentDependencies(def: ComponentDef): ComponentDef {
  return {
    ...def,
    dependencies: collectComponentDependencies(def.children, def.id),
  };
}

function materializeComponentsWithDependencies(
  components: Map<string, ComponentDef>
): Record<string, ComponentDef> {
  const out: Record<string, ComponentDef> = {};

  for (const [id, def] of components) {
    out[id] = withComponentDependencies(def);
  }

  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Instance override extraction — M11.4
// ────────────────────────────────────────────────────────────────────────

const MAX_INSTANCE_FALLBACK_DEPTH = 3;

function normalizeOverrideProperty(raw: unknown): InstanceOverride['property'] {
  const value = String(raw ?? '').toLowerCase();

  if (value.includes('character') || value.includes('text') || value.includes('content')) {
    return 'text';
  }
  if (value.includes('fill')) return 'fills';
  if (value.includes('stroke')) return 'strokes';
  if (value.includes('effect') || value.includes('shadow') || value.includes('blur')) {
    return 'effects';
  }
  if (value.includes('visible') || value.includes('visibility')) return 'visibility';
  if (
    value.includes('width') ||
    value.includes('height') ||
    value.includes('x') ||
    value.includes('y') ||
    value.includes('layout') ||
    value.includes('constraints')
  ) {
    return 'layout';
  }
  if (value.includes('component') || value.includes('variant') || value.includes('property')) {
    return 'componentProperty';
  }

  return 'unknown';
}

function overrideKindForProperty(
  property: InstanceOverride['property']
): InstanceOverride['kind'] {
  if (property === 'text') return 'text';
  if (property === 'fills') return 'fill';
  if (property === 'strokes' || property === 'effects' || property === 'visibility') {
    return 'visual';
  }
  if (property === 'layout') return 'layout';
  if (property === 'componentProperty') return 'componentProperty';
  return 'unknown';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRawOverrideProperties(instance: any): unknown[] {
  const candidates = [
    instance.overrides,
    instance.overrideProperties,
    instance.componentPropertyReferences,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  // Some Figma API versions expose componentProperties as an object. Treat
  // explicit non-default values as conservative component-property overrides
  // when the metadata is present.
  if (instance.componentProperties && typeof instance.componentProperties === 'object') {
    return Object.entries(instance.componentProperties).map(([key, value]) => ({
      property: 'componentProperty',
      targetNodeId: key,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: (value as any)?.value,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      preferredValues: (value as any)?.preferredValues,
    }));
  }

  return [];
}

export function detectInstanceOverrides(instance: InstanceNode): InstanceOverride[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawProperties = readRawOverrideProperties(instance as any);
  const out: InstanceOverride[] = [];

  for (const raw of rawProperties) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyRaw: any = raw;
    const rawProperty =
      anyRaw?.property ??
      anyRaw?.type ??
      anyRaw?.field ??
      anyRaw?.name ??
      anyRaw?.key ??
      raw;

    const property = normalizeOverrideProperty(rawProperty);
    const kind = overrideKindForProperty(property);

    const targetNodeId =
      typeof anyRaw?.node_id === 'string' ? anyRaw.node_id :
      typeof anyRaw?.nodeId === 'string' ? anyRaw.nodeId :
      typeof anyRaw?.targetNodeId === 'string' ? anyRaw.targetNodeId :
      typeof anyRaw?.id === 'string' ? anyRaw.id :
      undefined;

    out.push({
      targetNodeId,
      property,
      kind,
      description: typeof rawProperty === 'string'
        ? rawProperty
        : `Detected ${property} override`,
    });
  }

  return out;
}

function instanceHasOverrides(instance: InstanceNode): boolean {
  return detectInstanceOverrides(instance).length > 0;
}

function shouldIncludeInstanceFallbackChildren(
  instance: InstanceNode,
  overrides: readonly InstanceOverride[],
  depth: number
): boolean {
  if (depth >= MAX_INSTANCE_FALLBACK_DEPTH) return false;

  // Figma children on an InstanceNode represent the current rendered state,
  // including text/fill overrides. Preserve them when overrides are known.
  if (overrides.length > 0) return true;

  // Also keep a shallow fallback for nested instances inside components. This
  // lets the AI renderer degrade gracefully if a symbol is missing during a
  // nested component build.
  return depth < 1 && Array.isArray(instance.children) && instance.children.length > 0;
}

function hasDeepInstanceOverrides(node: IRNode): boolean {
  if (node.type === 'instance') {
    if ((node.overrides?.length ?? 0) > 0) return true;
    for (const child of node.children ?? []) {
      if (hasDeepInstanceOverrides(child)) return true;
    }
    return false;
  }

  if (node.type === 'group') {
    for (const child of node.children) {
      if (hasDeepInstanceOverrides(child)) return true;
    }
    if (node.clipPath && hasDeepInstanceOverrides(node.clipPath)) return true;
  }

  return false;
}

/**
 * M11.4 helper for the real instance translator.
 *
 * The reconstructed handover file keeps the original instance translator as a
 * merge point. Wire this helper into that translator after the base
 * InstanceNode is assembled:
 *
 *   const overrides = detectInstanceOverrides(instance);
 *   const children = await collectInstanceFallbackChildren(instance, acc, depth);
 *   return finalizeInstanceOverridePayload(base, overrides, children);
 */
export function finalizeInstanceOverridePayload(
  base: IRInstanceNode,
  overrides: readonly InstanceOverride[],
  children: readonly IRNode[] | null
): IRInstanceNode {
  const safeChildren = children && children.length > 0 ? Array.from(children) : undefined;
  const hasDeepOverrides = safeChildren?.some(hasDeepInstanceOverrides) ?? false;
  const mergedOverrides = Array.from(overrides);

  if (hasDeepOverrides && mergedOverrides.length === 0) {
    mergedOverrides.push({
      property: 'unknown',
      kind: 'unknown',
      description: 'Nested descendant instance contains overrides',
    });
  }

  return {
    ...base,
    ...(safeChildren ? { children: safeChildren } : {}),
    ...(mergedOverrides.length > 0 ? { overrides: mergedOverrides } : {}),
    sourceMeta: {
      ...(base.sourceMeta ?? {}),
      hasOverrides: mergedOverrides.length > 0 || hasDeepOverrides,
      overrideCount: mergedOverrides.length,
      hasExpandedChildren: !!safeChildren,
      instanceFallbackDepthGuard: MAX_INSTANCE_FALLBACK_DEPTH,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════
// TODO MERGE: the following large blocks are needed from prior milestones
// ════════════════════════════════════════════════════════════════════════
//
// FROM M3:
//   - readNodePosition(node): { position, size, rotation }
//   - parseSvgPathToAnchors(d: string): { subpaths }   — the SVG path
//     parser handling M, L, C, Q, Z (absolute and relative).
//   - imageBearingNodeToIR(node): Promise<PreliminaryImageNode | null>
//   - findImagePaint(fills): ImagePaint | null
//
// FROM M5:
//   - extractComponent(component, acc): Promise<string>
//   - instanceHasStructuralOverrides(instance): boolean
//   - instanceToInstanceNode(instance, originOffset, acc): Promise<...>
//
// FROM M6:
//   - figmaGroupToIRGroup(group, originOffset, acc): Promise<IRGroupNode>
//   - extractTextRuns(node, acc): TextRun[]   — run-length consolidation
//   - The updated translateLeafNode that handles GROUP, INSTANCE, image,
//     text, and vector branches.
//
// All of these were defined inline in their respective milestone messages
// but I cannot reliably reconstruct them all here without risking
// transcription errors.
// ════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────
// Vector node translator — M6 final form
// ────────────────────────────────────────────────────────────────────────

function vectorNodeToIR(
  node: VectorNode | RectangleNode | EllipseNode | PolygonNode | StarNode | LineNode | BooleanOperationNode,
  acc: LibraryAccumulator
): IRVectorNode {
  // TODO MERGE: readNodePosition from M3
  const pos = { position: { x: node.x, y: node.y }, size: { width: node.width, height: node.height }, rotation: ('rotation' in node ? node.rotation : 0) * DEG_TO_RAD };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vectorPaths: VectorPaths = (node as any).vectorPaths ?? [];
  const allSubpaths: Subpath[] = [];
  let fillRule: 'nonzero' | 'evenodd' = 'nonzero';
  for (const vp of vectorPaths) {
    // TODO MERGE: parseSvgPathToAnchors from M3
    const parsed = { subpaths: [] as Subpath[] }; // STUB — replace with parseSvgPathToAnchors(vp.data)
    for (const sp of parsed.subpaths) allSubpaths.push(sp);
    if (vp.windingRule === 'EVENODD') fillRule = 'evenodd';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fillStyleId = ('fillStyleId' in node) ? (node as any).fillStyleId : '';
  const fills = 'fills' in node
    ? figmaPaintsWithStyleLink(node.fills, fillStyleId, acc, node.name)
    : [];

  if (node.type === 'BOOLEAN_OPERATION') {
    // eslint-disable-next-line no-console
    console.info(
      `[Bridge] Flattened boolean operation "${node.name}" to compound path.`
    );
  }

  return {
    type: 'vector',
    id: stableId(node),
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: 'opacity' in node ? node.opacity : 1,
    position: pos.position,
    size: pos.size,
    rotation: pos.rotation,
    subpaths: allSubpaths,
    fills,
    strokes: [],
    fillRule,
    sourceMeta: {
      figmaType: node.type,
      ...(node.type === 'BOOLEAN_OPERATION' ? { booleanFlattened: true } : {}),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Top-level entry — assembles library + containers
// TODO MERGE: this is the M5 → M6 final form. Recheck:
//   - that "Pasteboard" (M5.5) is the synthetic container name, not "Loose Selection"
//   - that the loop dispatches GROUP types correctly (M6)
//   - that frameToContainer threads accumulator and sets clipsContent (M6)
// ────────────────────────────────────────────────────────────────────────

function isContainerLike(node: SceneNode): node is FrameNode | ComponentNode | InstanceNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

export async function selectionToPreliminaryDocument(): Promise<PreliminaryDocument> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) {
    throw new Error('Nothing selected');
  }

  const acc = newAccumulator();

  // TODO MERGE: full body from M5/M6 — frame bucketing, loose item
  // collection into "Pasteboard" container, document bounds calc,
  // accumulator → library materialization.

  // STUB return — replace with the full M5/M6 implementation.
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    sourceApp: 'figma',
    documentBounds: { position: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
    containers: [],
    library: {
      components: materializeComponentsWithDependencies(acc.components),
      colorStyles: Object.fromEntries(acc.colorStyles),
      textStyles: Object.fromEntries(acc.textStyles),
    },
    assets: { images: {} },
    generatedAt: new Date().toISOString(),
  };
}
