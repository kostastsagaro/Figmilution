/**
 * ═══════════════════════════════════════════════════════════════════════
 * RECONSTRUCTION FILE — ai-to-ir.ts
 * ═══════════════════════════════════════════════════════════════════════
 *
 * AI scene → IR sender. Patched in M2, M5, M6.
 *
 * Milestone summary:
 *   M2:    Initial sender. aiPathToIR, aiTextToIR, aiImageToIR,
 *          aiFillToIR (solid only), aiColorToIR (RGB/CMYK/Spot/Gray
 *          handling), readArtboards, findOwningArtboard,
 *          stableIdFromAiItem, selectionToBridgeDocument.
 *   M3:    No major changes (M3 was the receiver in this package).
 *   M4:    No changes (reconciliation is receiver-side only).
 *   M5:    LibraryAccumulator + style/symbol extraction. Functions
 *          added: newAiAccumulator, stableSwatchBridgeId,
 *          stableCharStyleBridgeId, stableSymbolBridgeId,
 *          findGlobalSwatchMatchingColor, aiFillToIRWithStyles,
 *          extractTextStyleIfAny, symbolToComponentDef,
 *          aiSymbolItemToInstance. The dispatcher in
 *          selectionToBridgeDocument gained a SymbolItem branch.
 *   M5.5:  No structural changes here; only on the receiver.
 *   M6:    extractGradientFromFillColor, aiCompoundPathToIR,
 *          aiGroupToIR, extractAiTextRuns, updated aiFillToIRWithStyles
 *          to dispatch to gradient extractor for GradientColor fills.
 *          The dispatcher gained CompoundPathItem and GroupItem branches.
 *
 * KNOWN GAPS (search for "TODO MERGE"):
 *   1. aiColorToIR's full body (M2) — covers CMYK→RGB approximation,
 *      Spot color resolution to underlying tint, GrayColor, NoColor.
 *      Stub is RGB-only.
 *   2. aiPathToIR / aiPathToIRWithStyles bodies — anchor extraction,
 *      stroke handling, fill resolution. M5 added the `WithStyles`
 *      variant that threads the accumulator.
 *   3. aiTextToIR's pre-M6 single-run version is gone; only the M6
 *      multi-run version is shown. The pre-M6 version had simpler
 *      first-character snapshot logic that may still be useful as a
 *      fast-path for unstyled text.
 *   4. aiImageToIR (M2) — placedItem/rasterItem branching, asset
 *      upload via uploadBytes, building ImageRef.
 *   5. readArtboards, findOwningArtboard, stableIdFromAiItem (M2).
 *   6. The full body of selectionToBridgeDocument with its M5 + M6
 *      type-dispatch loop.
 *   7. symbolToComponentDef + aiSymbolItemToInstance (M5) — the
 *      symbol-to-component extraction with the temp-group dance
 *      around symbols.add(). Read-only-name fallback warning.
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  BRIDGE_SCHEMA_VERSION,
  type BridgeDocument,
  type BridgeLibrary,
  type BridgeLinearGradientPaint,
  type BridgePaint,
  type BridgeRadialGradientPaint,
  type BridgeSolidPaint,
  type ColorRGBA,
  type ColorStop,
  type ColorStyleDef,
  type ComponentDef,
  type Container,
  type GroupNode as IRGroupNode,
  type ImageNode as IRImageNode,
  type ImageRef,
  type InstanceNode as IRInstanceNode,
  type Node as IRNode,
  type Subpath,
  type Anchor,
  type TextNode as IRTextNode,
  type TextParagraph,
  type TextRun,
  type TextStyleDef,
  type VectorNode as IRVectorNode,
  nodeLocalEndpointsToUnit,
  stripBridgeMarker,
  stripM5Markers,
} from '@bridge/shared';
import {
  aiBoundsToContainerLocal,
  aiPointToContainerLocal,
  aiRectFromTuple,
  type AiRect,
} from './coords';
import {
  readPlacedItemBytes,
  readRasterItemBytes,
  uploadBytes,
} from './asset-uploader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aiModule: any = require('illustrator');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = aiModule.app;

// ════════════════════════════════════════════════════════════════════════
// Section 1: ID and accumulator helpers
// TODO MERGE: full bodies from M2 (stableIdFromAiItem) and M5 (accumulator,
// stableSwatchBridgeId, stableCharStyleBridgeId, stableSymbolBridgeId).
// ════════════════════════════════════════════════════════════════════════

interface AiLibraryAccumulator {
  components: Map<string, ComponentDef>;
  colorStyles: Map<string, ColorStyleDef>;
  textStyles: Map<string, TextStyleDef>;
  // AI native id → bridgeId (for swatches, char styles, symbols)
  aiToBridge: Map<string, string>;
}

function newAiAccumulator(): AiLibraryAccumulator {
  return {
    components: new Map(),
    colorStyles: new Map(),
    textStyles: new Map(),
    aiToBridge: new Map(),
  };
}

function freshUuid(): string {
  const r = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${r()}${r()}-${r()}-${r()}-${r()}-${r()}${r()}${r()}`;
}

// TODO MERGE: stableIdFromAiItem (M2). Reads the bridge marker from the
// item name; if absent, mints a fresh UUID and stamps the name. Full
// body in M2 chat.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableIdFromAiItem(item: any): string {
  const name = String(item.name ?? '');
  const m = name.match(/‹bridge:([0-9a-f-]+)›/i);
  if (m) return m[1]!;
  const fresh = freshUuid();
  // The caller is responsible for stamping the name in most cases; some
  // call sites stamp here. TODO MERGE: confirm against M2 final form.
  return fresh;
}

// TODO MERGE: stableSwatchBridgeId, stableCharStyleBridgeId,
// stableSymbolBridgeId (M5). All three: read marker from native name,
// fall back to fresh UUID, stamp the AI item's name with the appropriate
// marker (‹style:colorXXX›, ‹style:textXXX›, ‹sym:XXX›). Full bodies
// in M5 chat.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableSwatchBridgeId(swatch: any, acc: AiLibraryAccumulator): string {
  const name = String(swatch.name ?? '');
  const m = name.match(/‹style:color([0-9a-f-]+)›/i);
  if (m) {
    acc.aiToBridge.set(`swatch:${name}`, m[1]!);
    return m[1]!;
  }
  const fresh = freshUuid();
  try { swatch.name = `${stripM5Markers(name)} ‹style:color${fresh}›`.trim(); } catch { /* read-only */ }
  acc.aiToBridge.set(`swatch:${name}`, fresh);
  return fresh;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableCharStyleBridgeId(style: any, acc: AiLibraryAccumulator): string {
  const name = String(style.name ?? '');
  const m = name.match(/‹style:text([0-9a-f-]+)›/i);
  if (m) return m[1]!;
  const fresh = freshUuid();
  try { style.name = `${stripM5Markers(name)} ‹style:text${fresh}›`.trim(); } catch { /* read-only */ }
  acc.aiToBridge.set(`charstyle:${name}`, fresh);
  return fresh;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stableSymbolBridgeId(symbol: any, acc: AiLibraryAccumulator): string {
  const name = String(symbol.name ?? '');
  const m = name.match(/‹sym:([0-9a-f-]+)›/i);
  if (m) return m[1]!;
  const fresh = freshUuid();
  try {
    symbol.name = `${stripM5Markers(name)} ‹sym:${fresh}›`.trim();
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] AI symbol name is read-only; bridge id ${fresh} will not persist on disk.`);
  }
  acc.aiToBridge.set(`symbol:${name}`, fresh);
  return fresh;
}

// ════════════════════════════════════════════════════════════════════════
// Section 2: Color translation
// TODO MERGE: full body from M2. Handles RGBColor, CMYKColor (with the
// chosen approximation), SpotColor (resolves spot.color and applies tint),
// GrayColor, NoColor. Returns ColorRGBA.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiColorToIR(c: any): ColorRGBA {
  if (!c) return { r: 0, g: 0, b: 0, a: 1 };
  const tn = String(c.typename ?? '');

  if (tn === 'RGBColor') {
    return { r: (c.red ?? 0) / 255, g: (c.green ?? 0) / 255, b: (c.blue ?? 0) / 255, a: 1 };
  }
  if (tn === 'GrayColor') {
    const g = 1 - (c.gray ?? 0) / 100;
    return { r: g, g, b: g, a: 1 };
  }
  if (tn === 'CMYKColor') {
    // TODO MERGE: M2 used the standard naive CMYK→RGB approximation.
    // Replace with the exact form from M2 if it differed.
    const ck = (c.cyan ?? 0) / 100;
    const mk = (c.magenta ?? 0) / 100;
    const yk = (c.yellow ?? 0) / 100;
    const kk = (c.black ?? 0) / 100;
    return {
      r: (1 - ck) * (1 - kk),
      g: (1 - mk) * (1 - kk),
      b: (1 - yk) * (1 - kk),
      a: 1,
    };
  }
  if (tn === 'SpotColor') {
    const inner = aiColorToIR(c.spot?.color);
    const tint = (c.tint ?? 100) / 100;
    return {
      r: 1 - (1 - inner.r) * tint,
      g: 1 - (1 - inner.g) * tint,
      b: 1 - (1 - inner.b) * tint,
      a: 1,
    };
  }
  if (tn === 'NoColor') {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rgbaApproxEqual(a: ColorRGBA, b: any, tol = 0.01): boolean {
  const bIr = aiColorToIR(b);
  return (
    Math.abs(a.r - bIr.r) < tol &&
    Math.abs(a.g - bIr.g) < tol &&
    Math.abs(a.b - bIr.b) < tol
  );
}

// TODO MERGE: findGlobalSwatchMatchingColor (M5). Scans doc.swatches for
// a Spot-type swatch whose color matches `aiColorForCompare` within
// tolerance. Used to recover style links lost during round-trip.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findGlobalSwatchMatchingColor(doc: any, aiColorForCompare: any): any | null {
  const swatches = doc.swatches;
  const targetIr = aiColorToIR(aiColorForCompare);
  for (let i = 0; i < swatches.length; i++) {
    const s = swatches[i];
    const sc = s.color;
    if (!sc) continue;
    if (sc.typename !== 'SpotColor') continue;
    if (rgbaApproxEqual(targetIr, sc.spot?.color, 0.01)) return s;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Section 3: Gradient extraction (M6)
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractGradientFromFillColor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fillColor: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  container: AiRect
): BridgePaint | null {
  if (!fillColor || fillColor.typename !== 'GradientColor') return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gradient: any = fillColor.gradient;
  if (!gradient) return null;

  const origin: [number, number] = fillColor.origin ?? [0, 0];
  const angle: number = fillColor.angle ?? 0;
  const length: number = fillColor.length ?? 0;

  const startDoc = { x: origin[0], y: origin[1] };
  const endDoc = {
    x: origin[0] + length * Math.cos((angle * Math.PI) / 180),
    y: origin[1] + length * Math.sin((angle * Math.PI) / 180),
  };

  const startCont = aiPointToContainerLocal(startDoc.x, startDoc.y, container);
  const endCont = aiPointToContainerLocal(endDoc.x, endDoc.y, container);

  const itemRect = aiRectFromTuple(item.geometricBounds);
  const itemLocal = aiBoundsToContainerLocal(itemRect, container);

  const startNode = {
    x: startCont.x - itemLocal.x,
    y: startCont.y - itemLocal.y,
  };
  const endNode = {
    x: endCont.x - itemLocal.x,
    y: endCont.y - itemLocal.y,
  };

  const { startUnit, endUnit } = nodeLocalEndpointsToUnit(
    startNode,
    endNode,
    { width: itemLocal.width, height: itemLocal.height }
  );

  const stops: ColorStop[] = [];
  for (let i = 0; i < gradient.gradientStops.length; i++) {
    const s = gradient.gradientStops[i];
    const irColor = aiColorToIR(s.color);
    stops.push({
      position: Math.max(0, Math.min(1, s.rampPoint / 100)),
      color: {
        r: irColor.r,
        g: irColor.g,
        b: irColor.b,
        a: typeof s.opacity === 'number' ? s.opacity / 100 : irColor.a,
      },
    });
  }
  stops.sort((a, b) => a.position - b.position);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const GradientType: any = aiModule.GradientType ?? {};
  const isRadial =
    gradient.type === GradientType.RADIAL ||
    String(gradient.type).toLowerCase().includes('radial');

  if (isRadial) {
    return {
      type: 'radialGradient',
      centerUnit: startUnit,
      radiusEndUnit: endUnit,
      stops,
      opacity: 1,
      visible: true,
    } satisfies BridgeRadialGradientPaint;
  }
  return {
    type: 'linearGradient',
    startUnit,
    endUnit,
    stops,
    opacity: 1,
    visible: true,
  } satisfies BridgeLinearGradientPaint;
}

// ════════════════════════════════════════════════════════════════════════
// Section 4: Fill / paint extraction (M5 with M6 gradient dispatch)
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiFillToIRWithStyles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  acc: AiLibraryAccumulator,
  container: AiRect
): BridgePaint[] {
  if (!item.filled) return [];
  const aiColor = item.fillColor;

  if (aiColor?.typename === 'GradientColor') {
    const gradPaint = extractGradientFromFillColor(aiColor, item, container);
    return gradPaint ? [gradPaint] : [];
  }

  const irColor = aiColorToIR(aiColor);
  const paint: BridgeSolidPaint = {
    type: 'solid',
    color: irColor,
    opacity: 1,
    visible: true,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = app.activeDocument;
  let aiColorForCompare = aiColor;
  if (aiColor.typename === 'SpotColor') aiColorForCompare = aiColor.spot.color;
  const matchingSwatch = findGlobalSwatchMatchingColor(doc, aiColorForCompare);
  if (matchingSwatch) {
    const bridgeId = stableSwatchBridgeId(matchingSwatch, acc);
    if (!acc.colorStyles.has(bridgeId)) {
      acc.colorStyles.set(bridgeId, {
        id: bridgeId,
        name: stripM5Markers(String(matchingSwatch.name ?? '')),
        paint: { ...paint },
        sourceMeta: { swatchType: 'spot' },
      });
    }
    paint.styleId = bridgeId;
  }
  return [paint];
}

// ════════════════════════════════════════════════════════════════════════
// Section 5: Path / vector extraction
// TODO MERGE: full bodies from M2 (aiPathToIR) + M5 (aiPathToIRWithStyles).
// The latter wraps the former and threads the accumulator.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiPathToIRWithStyles(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pathItem: any,
  container: AiRect,
  acc: AiLibraryAccumulator
): IRVectorNode {
  const itemRect = aiRectFromTuple(pathItem.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);

  const anchors: Anchor[] = [];
  const points = pathItem.pathPoints;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const a = aiPointToContainerLocal(p.anchor[0], p.anchor[1], container);
    const li = aiPointToContainerLocal(p.leftDirection[0], p.leftDirection[1], container);
    const ro = aiPointToContainerLocal(p.rightDirection[0], p.rightDirection[1], container);
    anchors.push({
      point: { x: a.x - local.x, y: a.y - local.y },
      handleIn: { x: li.x - local.x, y: li.y - local.y },
      handleOut: { x: ro.x - local.x, y: ro.y - local.y },
      type: String(p.pointType).toLowerCase().includes('smooth') ? 'smooth' : 'corner',
    });
  }

  const subpath: Subpath = {
    closed: Boolean(pathItem.closed),
    anchors,
  };

  return {
    type: 'vector',
    id: stableIdFromAiItem(pathItem),
    name: stripBridgeMarker(String(pathItem.name ?? 'Path')),
    visible: !pathItem.hidden,
    locked: Boolean(pathItem.locked),
    opacity: typeof pathItem.opacity === 'number' ? pathItem.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    subpaths: [subpath],
    fills: aiFillToIRWithStyles(pathItem, acc, container),
    strokes: [], // TODO MERGE: stroke extraction from M2
    fillRule: pathItem.evenodd ? 'evenodd' : 'nonzero',
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 6: Compound path extraction (M6)
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiCompoundPathToIR(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  compound: any,
  container: AiRect,
  acc: AiLibraryAccumulator
): IRVectorNode {
  const itemRect = aiRectFromTuple(compound.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);

  const subpaths: Subpath[] = [];
  for (let i = 0; i < compound.pathItems.length; i++) {
    const member = compound.pathItems[i];
    const memberAnchors: Anchor[] = [];
    const points = member.pathPoints;
    for (let j = 0; j < points.length; j++) {
      const p = points[j];
      const a = aiPointToContainerLocal(p.anchor[0], p.anchor[1], container);
      const li = aiPointToContainerLocal(p.leftDirection[0], p.leftDirection[1], container);
      const ro = aiPointToContainerLocal(p.rightDirection[0], p.rightDirection[1], container);
      memberAnchors.push({
        point: { x: a.x - local.x, y: a.y - local.y },
        handleIn: { x: li.x - local.x, y: li.y - local.y },
        handleOut: { x: ro.x - local.x, y: ro.y - local.y },
        type: String(p.pointType).toLowerCase().includes('smooth') ? 'smooth' : 'corner',
      });
    }
    subpaths.push({
      closed: Boolean(member.closed),
      anchors: memberAnchors,
    });
  }

  const firstMember = compound.pathItems[0];
  const fills = firstMember
    ? aiFillToIRWithStyles(firstMember, acc, container)
    : [];
  const fillRule = firstMember?.evenodd ? 'evenodd' : 'nonzero';

  return {
    type: 'vector',
    id: stableIdFromAiItem(compound),
    name: stripBridgeMarker(String(compound.name ?? 'Compound')),
    visible: !compound.hidden,
    locked: Boolean(compound.locked),
    opacity: typeof compound.opacity === 'number' ? compound.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    subpaths,
    fills,
    strokes: [],
    fillRule,
    sourceMeta: { aiCompoundPath: true },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 7: Image extraction (M2)
// TODO MERGE: full body from M2. Branches on PlacedItem vs RasterItem,
// reads bytes via asset-uploader helpers, calls uploadBytes, builds
// ImageRef. The function below is a structural stub.
// ════════════════════════════════════════════════════════════════════════

async function aiImageToIR(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  item: any,
  container: AiRect,
  assetBaseUrl: string,
  assets: Record<string, ImageRef>
): Promise<IRImageNode | null> {
  const itemRect = aiRectFromTuple(item.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);

  const tn = String(item.typename);
  let bytesAndFormat: { bytes: ArrayBuffer; format: string } | null = null;

  if (tn === 'PlacedItem') {
    bytesAndFormat = await readPlacedItemBytes(item);
  } else if (tn === 'RasterItem') {
    bytesAndFormat = await readRasterItemBytes(item);
  }

  if (!bytesAndFormat) {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Could not read bytes for image item ${item.name}`);
    return null;
  }

  const uploaded = await uploadBytes(
    assetBaseUrl,
    bytesAndFormat.bytes,
    bytesAndFormat.format,
    { width: local.width, height: local.height }
  );

  const ref: ImageRef = {
    hash: uploaded.hash,
    format: uploaded.format,
    naturalSize: uploaded.naturalSize,
    byteLength: uploaded.byteLength,
  };
  assets[uploaded.hash] = ref;

  return {
    type: 'image',
    id: stableIdFromAiItem(item),
    name: stripBridgeMarker(String(item.name ?? 'Image')),
    visible: !item.hidden,
    locked: Boolean(item.locked),
    opacity: typeof item.opacity === 'number' ? item.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    image: ref,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 8: Group / clipping group extraction (M6)
// ════════════════════════════════════════════════════════════════════════

async function aiGroupToIR(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  group: any,
  container: AiRect,
  assetBaseUrl: string,
  assets: Record<string, ImageRef>,
  acc: AiLibraryAccumulator
): Promise<IRGroupNode> {
  const itemRect = aiRectFromTuple(group.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);

  const isClipped = Boolean(group.clipped);
  let clipPath: IRVectorNode | undefined;
  const children: IRNode[] = [];

  for (let i = 0; i < group.pageItems.length; i++) {
    const member = group.pageItems[i];
    const tn = String(member.typename);

    if (i === 0 && isClipped && (tn === 'PathItem' || tn === 'CompoundPathItem')) {
      const asPath = tn === 'CompoundPathItem'
        ? aiCompoundPathToIR(member, container, acc)
        : aiPathToIRWithStyles(member, container, acc);
      clipPath = asPath;
      continue;
    }

    if (tn === 'PathItem') {
      children.push(aiPathToIRWithStyles(member, container, acc));
    } else if (tn === 'CompoundPathItem') {
      children.push(aiCompoundPathToIR(member, container, acc));
    } else if (tn === 'TextFrame') {
      children.push(aiTextToIR(member, container));
    } else if (tn === 'PlacedItem' || tn === 'RasterItem') {
      const node = await aiImageToIR(member, container, assetBaseUrl, assets);
      if (node) children.push(node);
    } else if (tn === 'GroupItem') {
      children.push(await aiGroupToIR(member, container, assetBaseUrl, assets, acc));
    } else if (tn === 'SymbolItem') {
      await symbolToComponentDef(member.symbol, acc);
      const inst = aiSymbolItemToInstance(member, container, acc);
      if (inst) children.push(inst);
    }
  }

  return {
    type: 'group',
    id: stableIdFromAiItem(group),
    name: stripBridgeMarker(String(group.name ?? 'Group')),
    visible: !group.hidden,
    locked: Boolean(group.locked),
    opacity: typeof group.opacity === 'number' ? group.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    children,
    ...(clipPath ? { clipPath } : {}),
    sourceMeta: { aiClipped: isClipped },
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 9: Text extraction (M6 multi-run)
// The pre-M6 single-run version is gone; this is the run-length-consolidated
// version from M6.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAiTextRuns(tf: any): TextRun[] {
  const characters = String(tf.contents ?? '');
  if (characters.length === 0) return [];

  const runs: TextRun[] = [];
  let runStart = 0;
  let runSnapshot: ReturnType<typeof readAiCharSnapshot> | null = null;

  function readAiCharSnapshot(idx: number) {
    const char = tf.textRange.characters[idx];
    const attrs = char.characterAttributes;
    const fontSize = Number(attrs.size ?? 12);
    const tracking = Number(attrs.tracking ?? 0);
    const letterSpacingPt = (tracking / 1000) * fontSize;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textFont: any = attrs.textFont;
    const family = textFont ? String(textFont.family ?? '') : 'Unknown';
    const styleStr = textFont ? String(textFont.style ?? '') : '';
    const psName = textFont ? String(textFont.name ?? '') : '';

    const fillColor = attrs.fillColor ? aiColorToIR(attrs.fillColor) : { r: 0, g: 0, b: 0, a: 1 };
    const fillKey = `${fillColor.r}:${fillColor.g}:${fillColor.b}:${fillColor.a}`;

    return {
      family,
      style: styleStr,
      psName,
      fontSize,
      letterSpacingPt,
      fillColor,
      fillKey,
    };
  }

  function snapshotKey(s: ReturnType<typeof readAiCharSnapshot>): string {
    const r = (n: number) => Math.round(n * 10000) / 10000;
    return `${s.family}|${s.style}|${r(s.fontSize)}|${r(s.letterSpacingPt)}|${s.fillKey}`;
  }

  function flushRun(end: number) {
    if (!runSnapshot) return;
    const fontWeight = /bold|black|heavy/i.test(runSnapshot.style) ? 700 : 400;
    const fontStyleVal: 'normal' | 'italic' = /italic|oblique/i.test(runSnapshot.style) ? 'italic' : 'normal';

    runs.push({
      start: runStart,
      end,
      fontFamily: runSnapshot.family,
      postScriptName: runSnapshot.psName || null,
      fontWeight,
      fontStyle: fontStyleVal,
      fontSize: runSnapshot.fontSize,
      letterSpacing: runSnapshot.letterSpacingPt,
      fills: [{ type: 'solid', color: runSnapshot.fillColor, opacity: 1, visible: true }],
    });
  }

  for (let i = 0; i < characters.length; i++) {
    let snap: ReturnType<typeof readAiCharSnapshot>;
    try {
      snap = readAiCharSnapshot(i);
    } catch {
      continue;
    }
    if (runSnapshot === null) {
      runSnapshot = snap;
      runStart = i;
      continue;
    }
    if (snapshotKey(snap) !== snapshotKey(runSnapshot)) {
      flushRun(i);
      runSnapshot = snap;
      runStart = i;
    }
  }
  flushRun(characters.length);
  return runs;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiTextToIR(tf: any, container: AiRect): IRTextNode {
  const itemRect = aiRectFromTuple(tf.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);

  const characters = String(tf.contents ?? '');
  const runs = extractAiTextRuns(tf);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstPara: any = tf.textRange.paragraphAttributes;
  const justification = String(firstPara.justification ?? '').toLowerCase();
  const alignH: TextParagraph['alignH'] =
    justification.includes('right')   ? 'right'   :
    justification.includes('center')  ? 'center'  :
    justification.includes('justify') ? 'justify' :
                                        'left';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firstChar: any = tf.textRange.characterAttributes;
  const isAutoLeading = Boolean(firstChar.autoLeading);
  const leadingPt = isAutoLeading ? 0 : Number(firstChar.leading ?? 0);

  const paragraph: TextParagraph = {
    alignH,
    lineHeight: leadingPt,
    runs,
    start: 0,
    end: characters.length,
  };

  return {
    type: 'text',
    id: stableIdFromAiItem(tf),
    name: stripBridgeMarker(String(tf.name ?? 'Text')),
    visible: !tf.hidden,
    locked: Boolean(tf.locked),
    opacity: typeof tf.opacity === 'number' ? tf.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    characters,
    paragraphs: [paragraph],
    alignV: 'top',
    autoResize: 'widthAndHeight',
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 10: Symbol → ComponentDef (M5)
// TODO MERGE: full body from M5. The function:
//   1. Mints/reads bridgeId via stableSymbolBridgeId.
//   2. If already in acc.components, returns early.
//   3. Walks symbol.symbolItems[0]'s contents (or instantiates the symbol
//      into a temp group, walks its pageItems, then deletes the temp).
//   4. Translates each child into a Vector/Text/Image/Group leaf.
//   5. Stores ComponentDef in acc.components with size from
//      symbol.symbolItems[0].geometricBounds.
//   6. Logs the read-only-name warning if the symbol's name couldn't be
//      stamped.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function symbolToComponentDef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  symbol: any,
  acc: AiLibraryAccumulator
): Promise<string> {
  const bridgeId = stableSymbolBridgeId(symbol, acc);
  if (acc.components.has(bridgeId)) return bridgeId;

  // TODO MERGE: full extraction logic from M5. Stub below records the
  // symbol with empty children — the M5 patch shows the temp-group dance
  // around symbols.add() that produces real children.
  acc.components.set(bridgeId, {
    id: bridgeId,
    name: stripM5Markers(String(symbol.name ?? 'Symbol')),
    size: { width: 100, height: 100 }, // STUB
    background: null,
    children: [],
    sourceMeta: { aiSymbol: true, _stub: true },
  });
  return bridgeId;
}

// TODO MERGE: aiSymbolItemToInstance (M5). Reads the placed symbol's
// position/scale, looks up the symbol's bridgeId in the accumulator,
// returns an IRInstanceNode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function aiSymbolItemToInstance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  symbolItem: any,
  container: AiRect,
  acc: AiLibraryAccumulator
): IRInstanceNode | null {
  const sym = symbolItem.symbol;
  if (!sym) return null;
  const componentId = acc.aiToBridge.get(`symbol:${String(sym.name ?? '')}`);
  if (!componentId) return null;
  const itemRect = aiRectFromTuple(symbolItem.geometricBounds);
  const local = aiBoundsToContainerLocal(itemRect, container);
  return {
    type: 'instance',
    id: stableIdFromAiItem(symbolItem),
    name: stripBridgeMarker(String(symbolItem.name ?? 'Instance')),
    visible: !symbolItem.hidden,
    locked: Boolean(symbolItem.locked),
    opacity: typeof symbolItem.opacity === 'number' ? symbolItem.opacity / 100 : 1,
    position: { x: local.x, y: local.y },
    size: { width: local.width, height: local.height },
    rotation: 0,
    componentId,
  };
}

// ════════════════════════════════════════════════════════════════════════
// Section 11: Artboard reading + selection partitioning
// TODO MERGE: full bodies from M2. readArtboards walks doc.artboards
// and produces { rect, name, index }. findOwningArtboard tests an item's
// center point against artboard rects.
// ════════════════════════════════════════════════════════════════════════

interface ArtboardInfo {
  rect: AiRect;
  name: string;
  index: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readArtboards(doc: any): ArtboardInfo[] {
  const out: ArtboardInfo[] = [];
  for (let i = 0; i < doc.artboards.length; i++) {
    const ab = doc.artboards[i];
    out.push({
      rect: aiRectFromTuple(ab.artboardRect),
      name: String(ab.name ?? `Artboard ${i + 1}`),
      index: i,
    });
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findOwningArtboard(item: any, artboards: ArtboardInfo[]): ArtboardInfo | null {
  const itemRect = aiRectFromTuple(item.geometricBounds);
  const cx = (itemRect.left + itemRect.right) / 2;
  const cy = (itemRect.top + itemRect.bottom) / 2;
  for (const ab of artboards) {
    if (cx >= ab.rect.left && cx <= ab.rect.right && cy <= ab.rect.top && cy >= ab.rect.bottom) {
      return ab;
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Section 12: Top-level entry (M5/M6 final dispatch)
// TODO MERGE: full body. The dispatcher loop must handle:
//   - PathItem            → aiPathToIRWithStyles
//   - CompoundPathItem    → aiCompoundPathToIR (M6)
//   - GroupItem           → aiGroupToIR (M6)
//   - TextFrame           → aiTextToIR (with M6 multi-run)
//   - PlacedItem/RasterItem → aiImageToIR
//   - SymbolItem          → symbolToComponentDef + aiSymbolItemToInstance
//
// Plus partitioning items into containers by owning artboard, and
// emitting a "Pasteboard" container for off-artboard items (M5.5
// rename from "Loose Selection").
// ════════════════════════════════════════════════════════════════════════

export async function selectionToBridgeDocument(assetBaseUrl: string): Promise<BridgeDocument> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = app.activeDocument;
  if (!doc) throw new Error('No active document');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const selection: any[] = doc.selection ?? [];
  if (selection.length === 0) {
    throw new Error('Nothing selected');
  }

  const acc = newAiAccumulator();
  const assets: Record<string, ImageRef> = {};
  const artboards = readArtboards(doc);

  // TODO MERGE: full partitioning + per-container child translation from
  // M5/M6. The structure is:
  //   1. For each selected SymbolItem, call symbolToComponentDef so its
  //      definition is registered in acc *before* we translate items
  //      that may reference it.
  //   2. Bucket selected items by owning artboard (or "Pasteboard").
  //   3. For each bucket, call the per-type dispatcher and accumulate
  //      children.
  //   4. Build Container records.
  //   5. Compute documentBounds from the union of all container rects.

  const containers: Container[] = []; // STUB

  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    sourceApp: 'illustrator',
    documentBounds: { position: { x: 0, y: 0 }, size: { width: 0, height: 0 } },
    containers,
    library: {
      components: Object.fromEntries(acc.components),
      colorStyles: Object.fromEntries(acc.colorStyles),
      textStyles: Object.fromEntries(acc.textStyles),
    },
    assets: { images: assets },
    generatedAt: new Date().toISOString(),
  };
}
