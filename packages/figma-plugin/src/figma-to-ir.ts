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
// Preliminary document types
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
  | IRGroupNode;

export interface PreliminaryContainer extends Omit<Container, 'children'> {
  children: PreliminaryNode[];
}

export interface PreliminaryDocument extends Omit<BridgeDocument, 'containers' | 'assets'> {
  containers: PreliminaryContainer[];
  assets: { images: Record<string, ImageRef> };
}

const DEG_TO_RAD = Math.PI / 180;

// ────────────────────────────────────────────────────────────────────────
// ID helpers
// ────────────────────────────────────────────────────────────────────────

function freshUuid(): string {
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

function stableId(node: BaseNode): string {
  const existing = node.getPluginData(BRIDGE_ID_PLUGIN_KEY);
  if (existing) return existing;
  const fresh = freshUuid();
  try { node.setPluginData(BRIDGE_ID_PLUGIN_KEY, fresh); } catch { /* read-only ctx */ }
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
// Library accumulator
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
// Image format sniffing
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
// Paint translation
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
        `approximating as circular.`
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
    return {
      type: 'solid',
      color: { r: p.color.r, g: p.color.g, b: p.color.b, a: 1 },
      opacity: p.opacity ?? 1,
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
      color: { r: firstStop.color.r, g: firstStop.color.g, b: firstStop.color.b, a: firstStop.color.a },
      opacity: p.opacity ?? 1,
      visible: p.visible ?? true,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Style extraction
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
  if (!firstPaint) return null;

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    alignH: (style as any).textAlignHorizontal === 'JUSTIFIED' ? 'justify'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (style as any).textAlignHorizontal === 'CENTER' ? 'center'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
// Component dependency helpers
// ────────────────────────────────────────────────────────────────────────

function collectComponentDependenciesFromNode(node: IRNode, out: Set<string>): void {
  if (node.type === 'instance') {
    if (node.componentId) out.add(node.componentId);
    return;
  }
  if (node.type === 'group') {
    for (const child of node.children) collectComponentDependenciesFromNode(child, out);
    if (node.clipPath) collectComponentDependenciesFromNode(node.clipPath, out);
  }
}

export function collectComponentDependencies(
  children: readonly IRNode[],
  selfId?: string
): string[] {
  const out = new Set<string>();
  for (const child of children) collectComponentDependenciesFromNode(child, out);
  if (selfId) out.delete(selfId);
  return Array.from(out).sort();
}

function withComponentDependencies(def: ComponentDef): ComponentDef {
  return { ...def, dependencies: collectComponentDependencies(def.children, def.id) };
}

function materializeComponentsWithDependencies(
  components: Map<string, ComponentDef>
): Record<string, ComponentDef> {
  const out: Record<string, ComponentDef> = {};
  for (const [id, def] of components) out[id] = withComponentDependencies(def);
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Instance override helpers
// ────────────────────────────────────────────────────────────────────────

const MAX_INSTANCE_FALLBACK_DEPTH = 3;

function normalizeOverrideProperty(raw: unknown): InstanceOverride['property'] {
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('character') || value.includes('text') || value.includes('content')) return 'text';
  if (value.includes('fill')) return 'fills';
  if (value.includes('stroke')) return 'strokes';
  if (value.includes('effect') || value.includes('shadow') || value.includes('blur')) return 'effects';
  if (value.includes('visible') || value.includes('visibility')) return 'visibility';
  if (value.includes('width') || value.includes('height') || value.includes('x') ||
      value.includes('y') || value.includes('layout') || value.includes('constraints')) return 'layout';
  if (value.includes('component') || value.includes('variant') || value.includes('property')) return 'componentProperty';
  return 'unknown';
}

function overrideKindForProperty(property: InstanceOverride['property']): InstanceOverride['kind'] {
  if (property === 'text') return 'text';
  if (property === 'fills') return 'fill';
  if (property === 'strokes' || property === 'effects' || property === 'visibility') return 'visual';
  if (property === 'layout') return 'layout';
  if (property === 'componentProperty') return 'componentProperty';
  return 'unknown';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readRawOverrideProperties(instance: any): unknown[] {
  const candidates = [instance.overrides, instance.overrideProperties, instance.componentPropertyReferences];
  for (const c of candidates) if (Array.isArray(c)) return c;
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
    const rawProperty = anyRaw?.property ?? anyRaw?.type ?? anyRaw?.field ?? anyRaw?.name ?? anyRaw?.key ?? raw;
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
      description: typeof rawProperty === 'string' ? rawProperty : `Detected ${property} override`,
    });
  }
  return out;
}

function shouldIncludeInstanceFallbackChildren(
  instance: InstanceNode,
  overrides: readonly InstanceOverride[],
  depth: number
): boolean {
  if (depth >= MAX_INSTANCE_FALLBACK_DEPTH) return false;
  if (overrides.length > 0) return true;
  return depth < 1 && Array.isArray(instance.children) && instance.children.length > 0;
}

function hasDeepInstanceOverrides(node: IRNode): boolean {
  if (node.type === 'instance') {
    if ((node.overrides?.length ?? 0) > 0) return true;
    for (const child of node.children ?? []) if (hasDeepInstanceOverrides(child)) return true;
    return false;
  }
  if (node.type === 'group') {
    for (const child of node.children) if (hasDeepInstanceOverrides(child)) return true;
    if (node.clipPath && hasDeepInstanceOverrides(node.clipPath)) return true;
  }
  return false;
}

export function finalizeInstanceOverridePayload(
  base: IRInstanceNode,
  overrides: readonly InstanceOverride[],
  children: readonly IRNode[] | null
): IRInstanceNode {
  const safeChildren = children && children.length > 0 ? Array.from(children) : undefined;
  const hasDeepOverrides = safeChildren?.some(hasDeepInstanceOverrides) ?? false;
  const mergedOverrides = Array.from(overrides);
  if (hasDeepOverrides && mergedOverrides.length === 0) {
    mergedOverrides.push({ property: 'unknown', kind: 'unknown', description: 'Nested descendant instance contains overrides' });
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

// ────────────────────────────────────────────────────────────────────────
// SVG path → anchor parser
// ────────────────────────────────────────────────────────────────────────

function parseSvgPathToAnchors(d: string): { subpaths: Subpath[] } {
  const subpaths: Subpath[] = [];
  if (!d || !d.trim()) return { subpaths };

  const normalized = d.replace(/([MLCQZHVmlcqzhv])/g, ' $1 ').trim();
  const parts = normalized.split(/[\s,]+/).filter((p) => p.length > 0);

  let i = 0;
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  let anchors: Anchor[] = [];
  let closed = false;
  let lastCmd = '';

  function num(): number { return parseFloat(parts[i++] ?? '0'); }

  function flushSubpath() {
    if (anchors.length > 0) {
      subpaths.push({ closed, anchors });
      anchors = [];
      closed = false;
    }
  }

  while (i < parts.length) {
    const tok = parts[i];
    if (!tok) { i++; continue; }

    let cmd: string;
    if (/^[MLCQZHVmlcqzhv]$/.test(tok)) {
      cmd = tok; lastCmd = cmd; i++;
    } else {
      cmd = lastCmd;
      if (!cmd) { i++; continue; }
    }

    const rel = cmd === cmd.toLowerCase() && cmd.toUpperCase() !== cmd;
    const upper = cmd.toUpperCase();

    switch (upper) {
      case 'M': {
        flushSubpath();
        const mx = rel ? cx + num() : num();
        const my = rel ? cy + num() : num();
        cx = mx; cy = my; startX = mx; startY = my;
        anchors.push({ point: { x: mx, y: my }, handleIn: { x: mx, y: my }, handleOut: { x: mx, y: my }, type: 'corner' });
        lastCmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        const lx = rel ? cx + num() : num();
        const ly = rel ? cy + num() : num();
        anchors.push({ point: { x: lx, y: ly }, handleIn: { x: lx, y: ly }, handleOut: { x: lx, y: ly }, type: 'corner' });
        cx = lx; cy = ly;
        break;
      }
      case 'H': {
        const hx = rel ? cx + num() : num();
        anchors.push({ point: { x: hx, y: cy }, handleIn: { x: hx, y: cy }, handleOut: { x: hx, y: cy }, type: 'corner' });
        cx = hx;
        break;
      }
      case 'V': {
        const vy = rel ? cy + num() : num();
        anchors.push({ point: { x: cx, y: vy }, handleIn: { x: cx, y: vy }, handleOut: { x: cx, y: vy }, type: 'corner' });
        cy = vy;
        break;
      }
      case 'C': {
        const cp1x = rel ? cx + num() : num();
        const cp1y = rel ? cy + num() : num();
        const cp2x = rel ? cx + num() : num();
        const cp2y = rel ? cy + num() : num();
        const ex  = rel ? cx + num() : num();
        const ey  = rel ? cy + num() : num();
        if (anchors.length > 0) {
          const prev = anchors[anchors.length - 1];
          prev.handleOut = { x: cp1x, y: cp1y };
          prev.type = 'smooth';
        }
        anchors.push({ point: { x: ex, y: ey }, handleIn: { x: cp2x, y: cp2y }, handleOut: { x: ex, y: ey }, type: 'smooth' });
        cx = ex; cy = ey;
        break;
      }
      case 'Q': {
        const qcx = rel ? cx + num() : num();
        const qcy = rel ? cy + num() : num();
        const qex = rel ? cx + num() : num();
        const qey = rel ? cy + num() : num();
        const qcp1x = cx + (2 / 3) * (qcx - cx);
        const qcp1y = cy + (2 / 3) * (qcy - cy);
        const qcp2x = qex + (2 / 3) * (qcx - qex);
        const qcp2y = qey + (2 / 3) * (qcy - qey);
        if (anchors.length > 0) {
          const prev = anchors[anchors.length - 1];
          prev.handleOut = { x: qcp1x, y: qcp1y };
          prev.type = 'smooth';
        }
        anchors.push({ point: { x: qex, y: qey }, handleIn: { x: qcp2x, y: qcp2y }, handleOut: { x: qex, y: qey }, type: 'smooth' });
        cx = qex; cy = qey;
        break;
      }
      case 'Z': {
        closed = true;
        cx = startX; cy = startY;
        flushSubpath();
        break;
      }
      default:
        i++;
        break;
    }
  }
  flushSubpath();
  return { subpaths };
}

// ────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ────────────────────────────────────────────────────────────────────────

function readNodePosition(
  node: SceneNode,
  originOffset: Point2D = { x: 0, y: 0 }
): { position: Point2D; size: { width: number; height: number }; rotation: number } {
  const abs = node.absoluteBoundingBox;
  const pos: Point2D = abs
    ? { x: abs.x - originOffset.x, y: abs.y - originOffset.y }
    : { x: node.x - originOffset.x, y: node.y - originOffset.y };
  return {
    position: pos,
    size: { width: node.width, height: node.height },
    rotation: ('rotation' in node ? (node as { rotation: number }).rotation : 0) * DEG_TO_RAD,
  };
}

function computeNodesBounds(
  nodes: readonly SceneNode[]
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const abs = n.absoluteBoundingBox;
    const nx = abs ? abs.x : n.x;
    const ny = abs ? abs.y : n.y;
    if (nx < minX) minX = nx;
    if (ny < minY) minY = ny;
    if (nx + n.width > maxX) maxX = nx + n.width;
    if (ny + n.height > maxY) maxY = ny + n.height;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionBounds(
  rects: Array<{ x: number; y: number; width: number; height: number }>
): { x: number; y: number; width: number; height: number } {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.width > maxX) maxX = r.x + r.width;
    if (r.y + r.height > maxY) maxY = r.y + r.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ────────────────────────────────────────────────────────────────────────
// Vector node translator
// ────────────────────────────────────────────────────────────────────────

function vectorNodeToIR(
  node: VectorNode | RectangleNode | EllipseNode | PolygonNode | StarNode | LineNode | BooleanOperationNode,
  acc: LibraryAccumulator,
  originOffset: Point2D = { x: 0, y: 0 }
): IRVectorNode {
  const { position, size, rotation } = readNodePosition(node, originOffset);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vectorPaths: VectorPaths = (node as any).vectorPaths ?? [];
  const allSubpaths: Subpath[] = [];
  let fillRule: 'nonzero' | 'evenodd' = 'nonzero';
  for (const vp of vectorPaths) {
    const parsed = parseSvgPathToAnchors(vp.data ?? '');
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
    console.info(`[Bridge] Flattened boolean operation "${node.name}" to compound path.`);
  }

  return {
    type: 'vector',
    id: stableId(node),
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: 'opacity' in node ? node.opacity : 1,
    position,
    size,
    rotation,
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
// Text node translator
// ────────────────────────────────────────────────────────────────────────

function fontWeightFromStyle(style: string): number {
  const s = style.toLowerCase();
  if (/black|heavy/.test(s)) return 900;
  if (/extrabold|ultra/.test(s)) return 800;
  if (/semibold|demi/.test(s)) return 600;
  if (/bold/.test(s)) return 700;
  if (/medium/.test(s)) return 500;
  if (/light/.test(s)) return 300;
  if (/thin|hairline/.test(s)) return 100;
  return 400;
}

function figmaAlignH(a: string): TextParagraph['alignH'] {
  if (a === 'CENTER') return 'center';
  if (a === 'RIGHT') return 'right';
  if (a === 'JUSTIFIED') return 'justify';
  return 'left';
}

function extractTextParagraphs(node: TextNode, acc: LibraryAccumulator): TextParagraph[] {
  const chars = node.characters;
  if (!chars) return [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let segments: any[] = [];
  try {
    segments = node.getStyledTextSegments([
      'fontSize', 'fontName', 'fills', 'letterSpacing',
      'lineHeight', 'textStyleId', 'fillStyleId', 'textAlignHorizontal',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
  } catch {
    // Fallback: treat the whole text as a single segment
    segments = [{
      start: 0,
      end: chars.length,
      fontSize: typeof node.fontSize === 'number' ? node.fontSize : 12,
      fontName: node.fontName !== figma.mixed ? node.fontName : { family: 'Inter', style: 'Regular' },
      fills: node.fills !== figma.mixed ? node.fills : [],
      letterSpacing: node.letterSpacing !== figma.mixed ? node.letterSpacing : { value: 0, unit: 'PIXELS' },
      lineHeight: node.lineHeight !== figma.mixed ? node.lineHeight : { unit: 'AUTO' },
      textStyleId: typeof node.textStyleId === 'string' ? node.textStyleId : '',
      fillStyleId: typeof node.fillStyleId === 'string' ? node.fillStyleId : '',
      textAlignHorizontal: node.textAlignHorizontal,
    }];
  }

  // Split into paragraph ranges (by newline)
  const paragraphRanges: Array<{ start: number; end: number }> = [];
  let pStart = 0;
  for (let c = 0; c <= chars.length; c++) {
    if (c === chars.length || chars[c] === '\n') {
      paragraphRanges.push({ start: pStart, end: c });
      pStart = c + 1;
    }
  }

  const paragraphs: TextParagraph[] = [];

  for (const pRange of paragraphRanges) {
    if (pRange.start > pRange.end) continue;

    const pSegs = segments.filter((s) => s.end > pRange.start && s.start < pRange.end);
    const firstSeg = pSegs[0];

    const alignH = figmaAlignH(firstSeg?.textAlignHorizontal ?? node.textAlignHorizontal);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lineHeightPt = 0;
    if (firstSeg) {
      const lh = firstSeg.lineHeight as LineHeight ?? { unit: 'AUTO' };
      const fs = (firstSeg.fontSize as number) ?? 12;
      if (lh.unit === 'PIXELS') lineHeightPt = lh.value;
      else if (lh.unit === 'PERCENT') lineHeightPt = (lh.value / 100) * fs;
    }

    const runs: TextRun[] = [];

    for (const seg of pSegs) {
      const segStart = Math.max(seg.start, pRange.start);
      const segEnd   = Math.min(seg.end, pRange.end);
      if (segStart >= segEnd) continue;

      const fontName   = (seg.fontName as FontName) ?? { family: 'Inter', style: 'Regular' };
      const fontSize   = (seg.fontSize as number) ?? 12;
      const ls         = (seg.letterSpacing as LetterSpacing) ?? { value: 0, unit: 'PIXELS' };
      const lsPt       = ls.unit === 'PIXELS' ? ls.value : (ls.unit === 'PERCENT' ? (ls.value / 100) * fontSize : 0);

      const fillStyleId = typeof seg.fillStyleId === 'string' ? seg.fillStyleId : '';
      const segFills    = (seg.fills as Paint[]) ?? [];
      const fills       = figmaPaintsWithStyleLink(segFills, fillStyleId, acc, node.name);

      const tsId = typeof seg.textStyleId === 'string' && seg.textStyleId
        ? extractTextStyleByFigmaId(seg.textStyleId, acc) ?? undefined
        : undefined;

      runs.push({
        start: segStart,
        end: segEnd,
        fontFamily: fontName.family,
        postScriptName: null,
        fontWeight: fontWeightFromStyle(fontName.style),
        fontStyle: /italic|oblique/i.test(fontName.style) ? 'italic' : 'normal',
        fontSize,
        letterSpacing: lsPt,
        fills,
        ...(tsId ? { textStyleId: tsId } : {}),
      });
    }

    // Ensure each paragraph has at least one run (handles empty lines)
    if (runs.length === 0) {
      const fs = typeof node.fontSize === 'number' ? node.fontSize : 12;
      runs.push({
        start: pRange.start,
        end: pRange.end,
        fontFamily: 'Inter',
        postScriptName: null,
        fontWeight: 400,
        fontStyle: 'normal',
        fontSize: fs,
        letterSpacing: 0,
        fills: [],
      });
    }

    paragraphs.push({ alignH, lineHeight: lineHeightPt, runs, start: pRange.start, end: pRange.end });
  }

  return paragraphs;
}

function textNodeToIR(node: TextNode, originOffset: Point2D, acc: LibraryAccumulator): IRTextNode {
  const { position, size, rotation } = readNodePosition(node, originOffset);
  const paragraphs = extractTextParagraphs(node, acc);

  const autoResizeMap: Record<string, IRTextNode['autoResize']> = {
    HEIGHT: 'height',
    WIDTH_AND_HEIGHT: 'widthAndHeight',
    NONE: 'none',
    TRUNCATE: 'none',
  };
  const alignVMap: Record<string, IRTextNode['alignV']> = {
    CENTER: 'middle',
    BOTTOM: 'bottom',
    TOP: 'top',
  };

  return {
    type: 'text',
    id: stableId(node),
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    position,
    size,
    rotation,
    characters: node.characters,
    paragraphs,
    alignV: alignVMap[node.textAlignVertical] ?? 'top',
    autoResize: autoResizeMap[node.textAutoResize] ?? 'none',
    sourceMeta: { figmaType: 'TEXT' },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Image node translator
// ────────────────────────────────────────────────────────────────────────

function findImagePaint(fills: readonly Paint[] | typeof figma.mixed): ImagePaint | null {
  if (fills === figma.mixed) return null;
  for (const p of fills) if (p.type === 'IMAGE' && p.visible !== false) return p as ImagePaint;
  return null;
}

async function imageBearingNodeToIR(
  node: SceneNode,
  originOffset: Point2D,
  _acc: LibraryAccumulator
): Promise<PreliminaryImageNode | null> {
  const { position, size, rotation } = readNodePosition(node, originOffset);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bytes: Uint8Array = await (node as any).exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
    const format = sniffImageFormat(bytes);
    return {
      type: 'image',
      id: stableId(node),
      name: node.name,
      visible: node.visible,
      locked: node.locked,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      opacity: 'opacity' in node ? (node as any).opacity : 1,
      position,
      size,
      rotation,
      preliminaryImage: { bytes, format, byteLength: bytes.byteLength },
      sourceMeta: { figmaType: node.type },
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Could not export image for "${node.name}":`, e);
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Component extractor (M5)
// ────────────────────────────────────────────────────────────────────────

async function extractComponent(
  component: ComponentNode,
  acc: LibraryAccumulator
): Promise<string> {
  const bridgeId = stableLibraryBridgeId(component, acc);
  if (acc.components.has(bridgeId)) return bridgeId;

  // Placeholder prevents infinite recursion on self-referencing components
  acc.components.set(bridgeId, {
    id: bridgeId,
    name: component.name,
    size: { width: component.width, height: component.height },
    background: null,
    children: [],
    dependencies: [],
  });

  const abs = component.absoluteBoundingBox;
  const childOrigin: Point2D = abs
    ? { x: abs.x, y: abs.y }
    : { x: component.x, y: component.y };

  const children: IRNode[] = [];
  for (const child of component.children) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    const ir = await translateNode(child, childOrigin, acc, 0);
    if (ir) children.push(ir as IRNode);
  }

  acc.components.set(bridgeId, {
    id: bridgeId,
    name: component.name,
    size: { width: component.width, height: component.height },
    background: null,
    children,
    dependencies: collectComponentDependencies(children, bridgeId),
    sourceMeta: { figmaId: component.id },
  });

  return bridgeId;
}

// ────────────────────────────────────────────────────────────────────────
// Group node translator (M6)
// ────────────────────────────────────────────────────────────────────────

async function groupNodeToIR(
  node: GroupNode | FrameNode | ComponentNode,
  originOffset: Point2D,
  acc: LibraryAccumulator,
  depth: number
): Promise<IRGroupNode> {
  const { position, size, rotation } = readNodePosition(node, originOffset);

  // Children positions are relative to the group/frame's absolute origin
  const abs = node.absoluteBoundingBox;
  const childOrigin: Point2D = abs
    ? { x: abs.x, y: abs.y }
    : { x: originOffset.x + node.x, y: originOffset.y + node.y };

  const children: IRNode[] = [];
  if ('children' in node) {
    for (const child of node.children) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      const ir = await translateNode(child, childOrigin, acc, depth + 1);
      if (ir) children.push(ir as IRNode);
    }
  }

  return {
    type: 'group',
    id: stableId(node),
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    opacity: 'opacity' in node ? (node as any).opacity : 1,
    position,
    size,
    rotation,
    children,
    sourceMeta: { figmaType: node.type },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Instance node translator (M5 + M11.4)
// ────────────────────────────────────────────────────────────────────────

async function instanceNodeToIR(
  node: InstanceNode,
  originOffset: Point2D,
  acc: LibraryAccumulator,
  depth: number
): Promise<IRInstanceNode> {
  const { position, size, rotation } = readNodePosition(node, originOffset);

  let componentId = '';
  try {
    const main = await node.getMainComponentAsync();
    if (main) componentId = await extractComponent(main, acc);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Could not resolve main component for "${node.name}":`, e);
  }

  const base: IRInstanceNode = {
    type: 'instance',
    id: stableId(node),
    name: node.name,
    visible: node.visible,
    locked: node.locked,
    opacity: node.opacity,
    position,
    size,
    rotation,
    componentId,
    sourceMeta: { figmaType: 'INSTANCE' },
  };

  const overrides = detectInstanceOverrides(node);

  let fallbackChildren: IRNode[] | null = null;
  if (shouldIncludeInstanceFallbackChildren(node, overrides, depth)) {
    const abs = node.absoluteBoundingBox;
    const childOrigin: Point2D = abs
      ? { x: abs.x, y: abs.y }
      : { x: originOffset.x + node.x, y: originOffset.y + node.y };
    const acc2: IRNode[] = [];
    for (const child of node.children) {
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      const ir = await translateNode(child, childOrigin, acc, depth + 1);
      if (ir) acc2.push(ir as IRNode);
    }
    if (acc2.length > 0) fallbackChildren = acc2;
  }

  return finalizeInstanceOverridePayload(base, overrides, fallbackChildren);
}

// ────────────────────────────────────────────────────────────────────────
// Main node dispatch
// ────────────────────────────────────────────────────────────────────────

async function translateNode(
  node: SceneNode,
  originOffset: Point2D,
  acc: LibraryAccumulator,
  depth: number
): Promise<PreliminaryNode | null> {
  if (!node.visible) return null;

  // Image-fill nodes first so we capture the raster content
  if ('fills' in node) {
    const imagePaint = findImagePaint((node as { fills: readonly Paint[] | typeof figma.mixed }).fills);
    if (imagePaint) return imageBearingNodeToIR(node, originOffset, acc);
  }

  switch (node.type) {
    case 'TEXT':
      return textNodeToIR(node as TextNode, originOffset, acc);

    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'POLYGON':
    case 'STAR':
    case 'LINE':
    case 'VECTOR':
    case 'BOOLEAN_OPERATION':
      return vectorNodeToIR(node as VectorNode, acc, originOffset);

    case 'GROUP':
      return groupNodeToIR(node as GroupNode, originOffset, acc, depth);

    case 'FRAME':
    case 'COMPONENT':
      // Nested frame/component inside another container — render as a group
      return groupNodeToIR(node as FrameNode, originOffset, acc, depth);

    case 'INSTANCE':
      return instanceNodeToIR(node as InstanceNode, originOffset, acc, depth);

    default:
      // eslint-disable-next-line no-console
      console.warn(`[Bridge] Skipping unsupported node type ${node.type} ("${node.name}")`);
      return null;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Frame → Container
// ────────────────────────────────────────────────────────────────────────

function isContainerLike(node: SceneNode): node is FrameNode | ComponentNode | InstanceNode {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE';
}

async function frameToContainer(
  node: FrameNode | ComponentNode | InstanceNode,
  acc: LibraryAccumulator
): Promise<PreliminaryContainer> {
  const abs = node.absoluteBoundingBox;
  const docPosition: Point2D = abs ? { x: abs.x, y: abs.y } : { x: node.x, y: node.y };
  const childOrigin: Point2D = docPosition;

  const children: PreliminaryNode[] = [];
  if ('children' in node) {
    for (const child of node.children) {
      const ir = await translateNode(child, childOrigin, acc, 0);
      if (ir) children.push(ir);
    }
  }

  // Determine kind: top-level frames on the page are artboards
  const parentIsPage = node.parent?.type === 'PAGE';
  const kind: Container['kind'] =
    node.type === 'COMPONENT' ? 'artboard' :
    node.type === 'FRAME' && parentIsPage ? 'artboard' :
    'frame';

  // Background from first solid fill
  let background: ColorRGBA | null = null;
  if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
    const solid = (node.fills as Paint[]).find((p) => p.type === 'SOLID' && p.visible !== false) as SolidPaint | undefined;
    if (solid) {
      background = { r: solid.color.r, g: solid.color.g, b: solid.color.b, a: solid.opacity ?? 1 };
    }
  }

  return {
    id: stableIdContainer(node),
    kind,
    name: node.name,
    documentPosition: docPosition,
    size: { width: node.width, height: node.height },
    background,
    clipsContent: 'clipsContent' in node ? (node as FrameNode).clipsContent : false,
    children,
    sourceMeta: { figmaType: node.type },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Entry point
// ────────────────────────────────────────────────────────────────────────

export async function selectionToPreliminaryDocument(): Promise<PreliminaryDocument> {
  const selection = figma.currentPage.selection;
  if (selection.length === 0) throw new Error('Nothing selected');

  const acc = newAccumulator();
  const containers: PreliminaryContainer[] = [];

  const frameNodes: Array<FrameNode | ComponentNode | InstanceNode> = [];
  const looseNodes: SceneNode[] = [];

  for (const node of selection) {
    if (isContainerLike(node)) {
      frameNodes.push(node);
    } else {
      looseNodes.push(node);
    }
  }

  // Each top-level frame / component / instance becomes its own container
  for (const frame of frameNodes) {
    containers.push(await frameToContainer(frame, acc));
  }

  // Loose nodes (text, shapes, etc.) go into a synthetic "Pasteboard" container
  if (looseNodes.length > 0) {
    const bounds = computeNodesBounds(looseNodes);
    const origin: Point2D = { x: bounds.x, y: bounds.y };
    const children: PreliminaryNode[] = [];
    for (const node of looseNodes) {
      const ir = await translateNode(node, origin, acc, 0);
      if (ir) children.push(ir);
    }
    if (children.length > 0) {
      containers.push({
        id: freshUuid(),
        kind: 'pasteboard',
        name: 'Pasteboard',
        documentPosition: origin,
        size: { width: bounds.width, height: bounds.height },
        background: null,
        clipsContent: false,
        children,
        sourceMeta: { synthetic: true },
      });
    }
  }

  const docBounds = unionBounds(
    containers.map((c) => ({ x: c.documentPosition.x, y: c.documentPosition.y, width: c.size.width, height: c.size.height }))
  );

  // eslint-disable-next-line no-console
  console.log(`[Bridge] selectionToPreliminaryDocument: ${containers.length} container(s), ` +
    `${containers.reduce((n, c) => n + c.children.length, 0)} top-level child(ren)`);

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    sourceApp: 'figma',
    documentBounds: { position: { x: docBounds.x, y: docBounds.y }, size: { width: docBounds.width, height: docBounds.height } },
    containers,
    library: {
      components: materializeComponentsWithDependencies(acc.components),
      colorStyles: Object.fromEntries(acc.colorStyles),
      textStyles: Object.fromEntries(acc.textStyles),
    },
    assets: { images: {} },
    generatedAt: new Date().toISOString(),
  };
}
