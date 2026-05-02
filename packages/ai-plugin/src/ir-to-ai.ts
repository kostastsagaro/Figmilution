/**
 * ═══════════════════════════════════════════════════════════════════════
 * RECONSTRUCTION FILE — ir-to-ai.ts
 * ═══════════════════════════════════════════════════════════════════════
 *
 * IR → AI receiver. THE most heavily-patched file in the project.
 * Touched in M3, M4, M4.5, M5, M5.5, M6 — every milestone after the
 * sender was stable.
 *
 * Milestone summary:
 *   M3:    Initial implementation. rgbaToAiColor, pickFirstSolid,
 *          rebuildVectorPath, applyVectorVisuals (solid only),
 *          applyTextAttributes (single run), createText, updateText,
 *          indexBridgeOwnedItems, indexBridgeOwnedArtboards. Initial
 *          AiReconciler that always-created.
 *   M4:    Real reconciliation. AiReconciler.apply walks containers
 *          and dispatches create/update/replace/delete. Type-compat
 *          checking. Image short-circuit hadn't landed yet.
 *   M4.5:  THREE critical fixes:
 *            (a) imageHashMatches short-circuit via ‹img:hash› marker.
 *                placeAndEmbedImage gained a `replacing` parameter for
 *                z-order preservation on replacement.
 *            (b) Global bridgeId index across ALL containers
 *                (snapshotItemContainers) so cross-artboard moves
 *                don't double-create.
 *            (c) captureZOrderAnchor / restoreZOrder helper used during
 *                type-change replacements to preserve sibling order.
 *   M5:    AiLibraryReconciler runs FIRST. applyColorStyle /
 *          createColorStyle (AI swatches with Spot type), applyTextStyle
 *          / createTextStyle (AI character styles), createSymbol /
 *          updateSymbol (the temp-group dance around symbols.add()),
 *          createInstance for IR instance nodes.
 *   M5.5:  AI orphan rename: instead of .remove(), prefix orphaned
 *          swatches/styles/symbols with "[Bridge: orphan]" and strip
 *          their bridgeId marker.
 *   M6:    buildAiGradientColor (gradient apply with stop replacement
 *          dance), rebuildCompoundPath via executeMenuCommand,
 *          applyAiMultiStyleText (per-character attribute walk),
 *          createGroup with optional clipping support.
 *
 * KNOWN GAPS (search for "TODO MERGE"):
 *   1. The full M3 helpers (rgbaToAiColor with all color-mode branches,
 *      pickFirstSolid, rebuildVectorPath, indexBridgeOwnedItems/Artboards,
 *      createText/updateText, applyTextAttributes single-run path).
 *   2. The M4 AiReconciler.apply structure with create/update/replace/
 *      delete dispatch and the full deleteOrphans body.
 *   3. M4.5 placeAndEmbedImage with `replacing` parameter, captureZOrderAnchor /
 *      restoreZOrder, applyImageGeometryAndVisuals, snapshotItemContainers.
 *   4. M5 AiLibraryReconciler full class body (applyColorStyle /
 *      createColorStyle / applyTextStyle / createTextStyle /
 *      createSymbol / updateSymbol / createInstance).
 *   5. M5.5 orphanRename helper (rename instead of delete).
 *   6. M6 createGroup wiring into AiReconciler.createLeaf, plus the
 *      createLeafIntoLayer helper for nested group children.
 *
 * Pull each section against your git history at the milestone tag —
 * the patches in chat are accurate, but I don't trust myself to
 * reassemble all of them without dropping logic.
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  type Anchor,
  type BridgeDocument,
  type BridgeLibrary,
  type BridgeLinearGradientPaint,
  type BridgePaint,
  type BridgeRadialGradientPaint,
  type BridgeSolidPaint,
  type ColorRGBA,
  type ColorStyleDef,
  type ComponentDef,
  type Container,
  type GroupNode as IRGroupNode,
  type ImageNode as IRImageNode,
  type ImageRef,
  type InstanceNode as IRInstanceNode,
  type Node as IRNode,
  type Subpath,
  type TextNode as IRTextNode,
  type TextStyleDef,
  type VectorNode as IRVectorNode,
  unitEndpointsToContainerLocal,
  stampNameWithBridgeId,
  stampNameWithBridgeIdAndImageHash,
  stampNameWithColorStyleId,
  stampNameWithSymbolId,
  stampNameWithTextStyleId,
  imageHashMatches,
  extractBridgeIdFromName,
  extractColorStyleIdFromName,
  extractSymbolIdFromName,
  extractTextStyleIdFromName,
  stripM5Markers,
  stripBridgeMarker,
} from '@bridge/shared';
import {
  irPointToAiDoc,
  irRectToAiTuple,
  irCanvasRectToArtboardTuple,
  type AiRect,
} from './coords';
import { downloadAsset, deleteAsset, type DownloadedAsset } from './asset-downloader';
import { resolveFont } from './font-resolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aiModule: any = require('illustrator');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = aiModule.app;

// ════════════════════════════════════════════════════════════════════════
// Section 1: Color helpers (M3)
// TODO MERGE: full body of rgbaToAiColor from M3. The version below is
// a structural stub that returns RGBColor only; the M3 version chose
// between RGB and CMYK based on the active document's color space.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rgbaToAiColor(c: ColorRGBA): any {
  const RGBColor = aiModule.RGBColor;
  const color = new RGBColor();
  color.red = Math.round(c.r * 255);
  color.green = Math.round(c.g * 255);
  color.blue = Math.round(c.b * 255);
  return color;
  // TODO MERGE: M3 also handled CMYK doc color space. Pull full body.
}

function pickFirstSolid(paints: BridgePaint[]): BridgeSolidPaint | null {
  for (const p of paints) {
    if (p.type === 'solid') return p as BridgeSolidPaint;
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Section 2: Path geometry (M3)
// TODO MERGE: full rebuildVectorPath. Iterates ir.subpaths[0].anchors,
// calls path.pathPoints.add() for each, sets anchor/leftDirection/
// rightDirection in AI doc coords, sets pointType, sets path.closed.
// ════════════════════════════════════════════════════════════════════════

async function rebuildVectorPath(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  path: any,
  ir: IRVectorNode,
  container: AiRect
): Promise<void> {
  // STUB: clears any existing points, walks first subpath
  while (path.pathPoints.length > 0) {
    path.pathPoints[path.pathPoints.length - 1].remove();
  }
  const sp = ir.subpaths[0];
  if (!sp) return;
  for (const a of sp.anchors) {
    const acX = a.point.x + ir.position.x;
    const acY = a.point.y + ir.position.y;
    const liX = a.handleIn.x + ir.position.x;
    const liY = a.handleIn.y + ir.position.y;
    const roX = a.handleOut.x + ir.position.x;
    const roY = a.handleOut.y + ir.position.y;
    const aDoc = irPointToAiDoc(acX, acY, container);
    const liDoc = irPointToAiDoc(liX, liY, container);
    const roDoc = irPointToAiDoc(roX, roY, container);
    const pt = path.pathPoints.add();
    pt.anchor = [aDoc.x, aDoc.y];
    pt.leftDirection = [liDoc.x, liDoc.y];
    pt.rightDirection = [roDoc.x, roDoc.y];
    pt.pointType = a.type === 'smooth'
      ? aiModule.PointType?.SMOOTH ?? 'smooth'
      : aiModule.PointType?.CORNER ?? 'corner';
  }
  path.closed = sp.closed;
}

// ════════════════════════════════════════════════════════════════════════
// Section 3: Vector visuals (M3 base + M6 gradient dispatch)
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isGradientPaint(paint: BridgePaint | null | undefined): paint is BridgeLinearGradientPaint | BridgeRadialGradientPaint {
  return paint?.type === 'linearGradient' || paint?.type === 'radialGradient';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isAiGradientResource(resource: any): boolean {
  return !!resource && !!resource.gradientStops;
}

function firstGradientStopColor(paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint): ColorRGBA {
  return paint.stops[0]?.color ?? { r: 0, g: 0, b: 0, a: 1 };
}

function normalizedGradientStops(
  paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint
): Array<{ position: number; color: ColorRGBA }> {
  if (paint.stops.length >= 2) {
    return [...paint.stops]
      .map((stop) => ({
        position: Math.max(0, Math.min(1, stop.position)),
        color: stop.color,
      }))
      .sort((a, b) => a.position - b.position);
  }

  if (paint.stops.length === 1) {
    const color = paint.stops[0]!.color;
    return [
      { position: 0, color },
      { position: 1, color },
    ];
  }

  return [
    { position: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    { position: 1, color: { r: 1, g: 1, b: 1, a: 1 } },
  ];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAiGradientResource(gradient: any, paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint, name: string): any {
  const isRadial = paint.type === 'radialGradient';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const GradientType: any = aiModule.GradientType ?? {};

  gradient.type = isRadial
    ? (GradientType.RADIAL ?? 'radial')
    : (GradientType.LINEAR ?? 'linear');
  gradient.name = name;

  const stops = normalizedGradientStops(paint);
  const originalStopCount = Number(gradient.gradientStops?.length ?? 0);

  for (const stop of stops) {
    const newStop = gradient.gradientStops.add();
    newStop.rampPoint = Math.max(0, Math.min(100, stop.position * 100));
    newStop.color = rgbaToAiColor(stop.color);
    newStop.opacity = Math.max(0, Math.min(100, stop.color.a * 100));
  }

  // Illustrator gradients start with default stops. Remove those after adding
  // our own stops so the resource is never temporarily empty.
  for (let i = 0; i < originalStopCount; i++) {
    try {
      gradient.gradientStops[0].remove();
    } catch {
      // If Illustrator refuses to remove a default stop, leave it rather than
      // failing the entire sync. The inline paint fallback below still protects
      // rendered nodes.
      break;
    }
  }

  return gradient;
}

/**
 * M10.3: Create or update the reusable Illustrator Gradient resource.
 * This stores only the color ramp/type. Object-specific placement remains in
 * GradientColor and is built by buildAiGradientColorFromGradient().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAiGradientResource(doc: any, paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint, name: string): any {
  const gradient = doc.gradients.add();
  return applyAiGradientResource(gradient, paint, name);
}

/**
 * M10.3: Create the per-object Illustrator GradientColor using a reusable
 * Gradient resource plus the node's local gradient geometry.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildAiGradientColorFromGradient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gradient: any,
  paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemForBounds: any,
  container: AiRect
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const GradientColor: any = aiModule.GradientColor;
  const gc = new GradientColor();
  gc.gradient = gradient;

  const itemRect = {
    left: itemForBounds.geometricBounds[0],
    top: itemForBounds.geometricBounds[1],
    right: itemForBounds.geometricBounds[2],
    bottom: itemForBounds.geometricBounds[3],
  };
  const itemLocal = {
    x: itemRect.left - container.left,
    y: container.top - itemRect.top,
    width: itemRect.right - itemRect.left,
    height: itemRect.top - itemRect.bottom,
  };

  const isRadial = paint.type === 'radialGradient';
  const startUnit = isRadial
    ? (paint as BridgeRadialGradientPaint).centerUnit
    : (paint as BridgeLinearGradientPaint).startUnit;
  const endUnit = isRadial
    ? (paint as BridgeRadialGradientPaint).radiusEndUnit
    : (paint as BridgeLinearGradientPaint).endUnit;

  const { startContainer, endContainer } = unitEndpointsToContainerLocal(
    startUnit,
    endUnit,
    { x: itemLocal.x, y: itemLocal.y },
    { width: itemLocal.width, height: itemLocal.height }
  );

  const startDoc = irPointToAiDoc(startContainer.x, startContainer.y, container);
  const endDoc = irPointToAiDoc(endContainer.x, endContainer.y, container);

  const dx = endDoc.x - startDoc.x;
  const dy = endDoc.y - startDoc.y;
  gc.origin = [startDoc.x, startDoc.y];
  gc.length = Math.max(0.001, Math.hypot(dx, dy));
  gc.angle = (Math.atan2(dy, dx) * 180) / Math.PI;

  return gc;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildAiGradientColor(
  paint: BridgeLinearGradientPaint | BridgeRadialGradientPaint,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemForBounds: any,
  container: AiRect
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = app.activeDocument;
    const gradient = createAiGradientResource(doc, paint, `__bridge_gradient_${Date.now()}__`);
    return buildAiGradientColorFromGradient(gradient, paint, itemForBounds, container);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Inline gradient creation failed; approximating with first stop: ${e instanceof Error ? e.message : String(e)}`);
    return rgbaToAiColor(firstGradientStopColor(paint));
  }
}

function buildPaintFillColor(
  paint: BridgePaint,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemForBounds: any,
  container: AiRect,
  resolution?: AiLibraryResolution
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (paint.type === 'solid') {
    return rgbaToAiColor((paint as BridgeSolidPaint).color);
  }

  if (isGradientPaint(paint)) {
    const linkedResource = paint.styleId ? resolution?.colorStyles.get(paint.styleId) : null;
    if (isAiGradientResource(linkedResource)) {
      try {
        return buildAiGradientColorFromGradient(linkedResource, paint, itemForBounds, container);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[Bridge] Failed to apply linked gradient style ${paint.styleId}; falling back to inline gradient: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return buildAiGradientColor(paint, itemForBounds, container);
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyVectorVisuals(path: any, ir: IRVectorNode, container: AiRect, resolution?: AiLibraryResolution): void {
  const firstFill = ir.fills[0];
  if (!firstFill) {
    path.filled = false;
  } else {
    const fillColor = buildPaintFillColor(firstFill, path, container, resolution);
    if (fillColor) {
      path.filled = true;
      path.fillColor = fillColor;
    } else {
      path.filled = false;
    }
  }

  // TODO MERGE: stroke handling from M3.
  path.stroked = false;
  path.opacity = ir.opacity * 100;
  path.hidden = !ir.visible;
  path.locked = ir.locked;
  path.name = stampNameWithBridgeId(ir.name || 'Path', ir.id);
}

// ════════════════════════════════════════════════════════════════════════
// Section 4: Compound path build via executeMenuCommand (M6)
// ════════════════════════════════════════════════════════════════════════

async function rebuildCompoundPath(
  ir: IRVectorNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  resolution?: AiLibraryResolution
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (ir.subpaths.length <= 1) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = app.activeDocument;
  const memberName = `__bridge_compound_member_${ir.id}_`;

  for (let s = 0; s < ir.subpaths.length; s++) {
    const sp = ir.subpaths[s]!;
    const path = layer.pathItems.add();
    path.name = memberName + s;

    for (const a of sp.anchors) {
      const acX = a.point.x + ir.position.x;
      const acY = a.point.y + ir.position.y;
      const liX = a.handleIn.x + ir.position.x;
      const liY = a.handleIn.y + ir.position.y;
      const roX = a.handleOut.x + ir.position.x;
      const roY = a.handleOut.y + ir.position.y;
      const aDoc = irPointToAiDoc(acX, acY, container);
      const liDoc = irPointToAiDoc(liX, liY, container);
      const roDoc = irPointToAiDoc(roX, roY, container);
      const pt = path.pathPoints.add();
      pt.anchor = [aDoc.x, aDoc.y];
      pt.leftDirection = [liDoc.x, liDoc.y];
      pt.rightDirection = [roDoc.x, roDoc.y];
      pt.pointType = a.type === 'smooth'
        ? aiModule.PointType?.SMOOTH ?? 'smooth'
        : aiModule.PointType?.CORNER ?? 'corner';
    }
    path.closed = sp.closed;
    path.evenodd = ir.fillRule === 'evenodd';
  }

  const script = `
    (function() {
      var doc = app.activeDocument;
      var members = [];
      for (var i = 0; i < doc.pathItems.length; i++) {
        var n = String(doc.pathItems[i].name);
        if (n.indexOf(${JSON.stringify(memberName)}) === 0) {
          members.push(doc.pathItems[i]);
        }
      }
      if (members.length < 2) return 'INSUFFICIENT';
      doc.selection = members;
      app.executeMenuCommand('compoundPath');
      return 'OK';
    })();
  `;

  const result = await app.executeAsModalForUXP?.(script);
  if (result !== 'OK') return null;

  for (let i = 0; i < doc.compoundPathItems.length; i++) {
    const cp = doc.compoundPathItems[i];
    if (String(cp.name).startsWith(memberName)) {
      cp.name = stampNameWithBridgeId(ir.name || 'Compound', ir.id);
      const firstFill = ir.fills[0];
      if (firstFill) {
        const fillColor = buildPaintFillColor(firstFill, cp, container, resolution);
        if (fillColor) {
          cp.pathItems[0].filled = true;
          cp.pathItems[0].fillColor = fillColor;
        } else {
          cp.pathItems[0].filled = false;
        }
      }
      cp.opacity = ir.opacity * 100;
      cp.hidden = !ir.visible;
      cp.locked = ir.locked;
      return cp;
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
// Section 5: Text apply (M6 multi-style)
// TODO MERGE: applyTextAttributes had a M3 single-run version that may
// still be useful as a fast-path. Below is the M6 multi-style version.
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyAiMultiStyleText(tf: any, ir: IRTextNode): void {
  if (String(tf.contents) !== ir.characters) {
    tf.contents = ir.characters;
  }

  const allRuns = ir.paragraphs.flatMap((p) => p.runs);
  if (allRuns.length === 0) return;

  for (const run of allRuns) {
    const start = Math.max(0, Math.min(run.start, ir.characters.length));
    const end = Math.max(start, Math.min(run.end, ir.characters.length));
    if (start >= end) continue;

    for (let i = start; i < end; i++) {
      try {
        const char = tf.textRange.characters[i];
        const attrs = char.characterAttributes;

        attrs.size = run.fontSize;
        if (run.fontSize > 0) {
          attrs.tracking = Math.round((run.letterSpacing / run.fontSize) * 1000);
        }

        const resolvedFont = resolveFont({
          postScriptName: run.postScriptName,
          fontFamily: run.fontFamily,
          fontWeight: run.fontWeight,
          fontStyle: run.fontStyle,
        });

        if (resolvedFont) {
          attrs.textFont = resolvedFont;
        }

        const firstFill = run.fills[0];
        if (firstFill?.type === 'solid') {
          attrs.fillColor = rgbaToAiColor((firstFill as BridgeSolidPaint).color);
        }
      } catch {
        // skip
      }
    }
  }

  const firstPara = ir.paragraphs[0];
  if (firstPara) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Justification: any = aiModule.Justification ?? {};
    const map: Record<string, unknown> = {
      left:    Justification.LEFT       ?? 'left',
      center:  Justification.CENTER     ?? 'center',
      right:   Justification.RIGHT      ?? 'right',
      justify: Justification.FULLJUSTIFY ?? 'fulljustify',
    };
    tf.textRange.paragraphAttributes.justification = map[firstPara.alignH];

    if (firstPara.lineHeight > 0) {
      tf.textRange.characterAttributes.leading = firstPara.lineHeight;
      tf.textRange.characterAttributes.autoLeading = false;
    } else {
      tf.textRange.characterAttributes.autoLeading = true;
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyTextAttributes(tf: any, ir: IRTextNode, container: AiRect): void {
  applyAiMultiStyleText(tf, ir);

  const firstRun = ir.paragraphs[0]?.runs[0];
  const fontSize = firstRun?.fontSize ?? 12;
  const aiDoc = irPointToAiDoc(ir.position.x, ir.position.y + fontSize, container);
  tf.position = [aiDoc.x, aiDoc.y];

  tf.opacity = ir.opacity * 100;
  tf.hidden = !ir.visible;
  tf.locked = ir.locked;
  tf.name = stampNameWithBridgeId(ir.name || 'Text', ir.id);
}

// TODO MERGE: createText (M3) and updateText (M3). Stubs:
async function createText(
  ir: IRTextNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const tf = layer.textFrames.add();
  tf.contents = ir.characters;
  applyTextAttributes(tf, ir, container);
  return tf;
}

async function updateText(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tf: any,
  ir: IRTextNode,
  container: AiRect
): Promise<void> {
  applyTextAttributes(tf, ir, container);
}

// ════════════════════════════════════════════════════════════════════════
// Section 6: Image apply (M3 base + M4.5 hash short-circuit)
// TODO MERGE: full bodies. The M4.5 patches are subtle:
//   - placeAndEmbedImage gained a `replacing` parameter for z-order
//     preservation (captureZOrderAnchor before delete, restoreZOrder
//     after embed).
//   - applyImageGeometryAndVisuals stamps both bridgeId AND img:hash
//     in a single name update.
//   - updateImage returns whether it rebuilt the placed item or just
//     short-circuited (for stats accounting).
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyImageGeometryAndVisuals(item: any, ir: IRImageNode, container: AiRect): void {
  const tuple = irRectToAiTuple(
    { x: ir.position.x, y: ir.position.y, width: ir.size.width, height: ir.size.height },
    container
  );
  // PlacedItem geometry is normally controlled via boundingBox/position;
  // TODO MERGE: confirm exact API from M3.
  item.position = [tuple[0], tuple[1]];
  item.width = ir.size.width;
  item.height = ir.size.height;

  item.opacity = ir.opacity * 100;
  item.hidden = !ir.visible;
  item.locked = ir.locked;
  item.name = stampNameWithBridgeIdAndImageHash(ir.name || 'Image', ir.id, ir.image.hash);
}

// TODO MERGE: captureZOrderAnchor / restoreZOrder (M4.5). Records the
// item *immediately above* the target in the parent's pageItems and
// uses zOrder() after rebuild to restore position. Full body in M4.5
// patch.
interface ZOrderAnchor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parent: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  anchorAbove: any | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function captureZOrderAnchor(item: any): ZOrderAnchor {
  const parent = item.parent;
  let anchorAbove: any = null;
  for (let i = 0; i < parent.pageItems.length; i++) {
    if (parent.pageItems[i] === item && i > 0) {
      anchorAbove = parent.pageItems[i - 1];
      break;
    }
  }
  return { parent, anchorAbove };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function restoreZOrder(item: any, anchor: ZOrderAnchor): void {
  if (anchor.anchorAbove) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ZOrder: any = aiModule.ZOrderMethod ?? {};
      item.zOrder(ZOrder.SENDBACKWARD ?? 'sendbackward');
      // TODO MERGE: M4.5 used a different mechanism — moveAbove or
      // similar. The above is best-effort.
    } catch {
      // ignore
    }
  }
}

async function placeAndEmbedImage(
  ir: IRImageNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  assetBaseUrl: string,
  replacing?: { anchor: ZOrderAnchor }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // TODO MERGE: full M4.5 body. Sketch:
  //   1. downloadAsset(assetBaseUrl, ir.image.hash, ir.image.format)
  //   2. layer.placedItems.add()
  //   3. placed.file = File(downloaded.nativePath)
  //   4. placed.embed() inside executeAsModalForUXP
  //   5. The embed produces a RasterItem; locate it.
  //   6. apply geometry/visuals
  //   7. if replacing.anchor: restoreZOrder
  //   8. deleteAsset(downloaded)

  let downloaded: DownloadedAsset | null = null;
  try {
    downloaded = await downloadAsset(assetBaseUrl, ir.image.hash, ir.image.format);
    const placed = layer.placedItems.add();
    placed.file = new (aiModule.File ?? aiModule.UXPFile)(downloaded.nativePath);
    // TODO MERGE: embed call, executeAsModalForUXP wrapping
    applyImageGeometryAndVisuals(placed, ir, container);

    if (replacing?.anchor) {
      restoreZOrder(placed, replacing.anchor);
    }
    return placed;
  } finally {
    if (downloaded) await deleteAsset(downloaded);
  }
}

// TODO MERGE: updateImage with hash short-circuit (M4.5). Returns
// { rebuilt: boolean } so the reconciler can count "skipped" vs
// "actually re-embedded".
async function updateImage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existing: any,
  ir: IRImageNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  assetBaseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ rebuilt: boolean; item: any }> {
  if (imageHashMatches(String(existing.name ?? ''), ir.image.hash)) {
    applyImageGeometryAndVisuals(existing, ir, container);
    return { rebuilt: false, item: existing };
  }
  const anchor = captureZOrderAnchor(existing);
  existing.remove();
  const fresh = await placeAndEmbedImage(ir, container, layer, assetBaseUrl, { anchor });
  return { rebuilt: true, item: fresh };
}

// ════════════════════════════════════════════════════════════════════════
// Section 7: Group / clipping group apply (M6)
// ════════════════════════════════════════════════════════════════════════

async function createGroup(
  ir: IRGroupNode,
  container: AiRect,
  assetBaseUrl: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parentLayer: any,
  resolution: AiLibraryResolution,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  applyLeafFn: (child: IRNode, container: AiRect, layer: any) => Promise<void>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const group = parentLayer.groupItems.add();
  group.name = stampNameWithBridgeId(ir.name || 'Group', ir.id);

  for (const child of ir.children) {
    await applyLeafFn(child, container, group);
  }

  if (ir.clipPath) {
    const clipPathItem = group.pathItems.add();
    const sp = ir.clipPath.subpaths[0];
    if (sp) {
      for (const a of sp.anchors) {
        const acX = a.point.x + ir.clipPath.position.x + ir.position.x;
        const acY = a.point.y + ir.clipPath.position.y + ir.position.y;
        const liX = a.handleIn.x + ir.clipPath.position.x + ir.position.x;
        const liY = a.handleIn.y + ir.clipPath.position.y + ir.position.y;
        const roX = a.handleOut.x + ir.clipPath.position.x + ir.position.x;
        const roY = a.handleOut.y + ir.clipPath.position.y + ir.position.y;
        const aDoc = irPointToAiDoc(acX, acY, container);
        const liDoc = irPointToAiDoc(liX, liY, container);
        const roDoc = irPointToAiDoc(roX, roY, container);
        const pt = clipPathItem.pathPoints.add();
        pt.anchor = [aDoc.x, aDoc.y];
        pt.leftDirection = [liDoc.x, liDoc.y];
        pt.rightDirection = [roDoc.x, roDoc.y];
        pt.pointType = a.type === 'smooth'
          ? aiModule.PointType?.SMOOTH ?? 'smooth'
          : aiModule.PointType?.CORNER ?? 'corner';
      }
      clipPathItem.closed = sp.closed;
    }
    clipPathItem.clipping = true;
    clipPathItem.filled = false;
    clipPathItem.stroked = false;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ZOrder: any = aiModule.ZOrderMethod ?? {};
    clipPathItem.zOrder(ZOrder.BRINGTOFRONT ?? 'bringtofront');

    group.clipped = true;
  }

  group.opacity = ir.opacity * 100;
  group.hidden = !ir.visible;
  group.locked = ir.locked;
  return group;
}

// ════════════════════════════════════════════════════════════════════════
// Section 8: Library reconciler (M5 + M5.5 orphan rename)
// ════════════════════════════════════════════════════════════════════════

export interface AiLibraryResolution {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colorStyles: Map<string, any>; // bridgeId → AI Spot/Swatch or Gradient resource
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  textStyles: Map<string, any>;  // bridgeId → AI CharacterStyle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Map<string, any>;  // bridgeId → AI Symbol
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isColorStyleResourceCompatible(resource: any, paint: BridgePaint): boolean {
  if (isGradientPaint(paint)) return isAiGradientResource(resource);
  return !isAiGradientResource(resource);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function orphanRenameLibraryResource(resource: any): void {
  const cleaned = stripM5Markers(String(resource?.name ?? '')).replace(/^\[Bridge: orphan\] /, '');
  try {
    resource.name = `[Bridge: orphan] ${cleaned}`;
  } catch {
    // eslint-disable-next-line no-console
    console.warn(`[Bridge] Could not rename orphan library resource "${cleaned}" (read-only)`);
  }
}

/** M10.4: Apply a solid or gradient color style to an existing AI resource. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyColorStyle(resource: any, def: ColorStyleDef): any {
  if (!isColorStyleResourceCompatible(resource, def.paint)) {
    orphanRenameLibraryResource(resource);
    return createColorStyle(app.activeDocument, def);
  }

  const name = stampNameWithColorStyleId(def.name, def.id);
  if (isGradientPaint(def.paint)) {
    return applyAiGradientResource(resource, def.paint, name);
  }

  resource.name = name;
  if (def.paint.type === 'solid') {
    const sp = def.paint as BridgeSolidPaint;
    try {
      resource.color = rgbaToAiColor(sp.color);
    } catch {
      try {
        if (resource.spot) resource.spot.color = rgbaToAiColor(sp.color);
      } catch {
        // Some Illustrator color assets expose read-only wrappers. Keep the
        // stamped name so reconciliation still works on the next pass.
      }
    }
  }

  return resource;
}

/** M10.4: Create a reusable AI resource for a Bridge color style. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createColorStyle(doc: any, def: ColorStyleDef): any {
  const name = stampNameWithColorStyleId(def.name, def.id);
  if (isGradientPaint(def.paint)) {
    return createAiGradientResource(doc, def.paint, name);
  }

  const spot = doc.spots.add();
  spot.name = name;
  if (def.paint.type === 'solid') {
    try {
      spot.color = rgbaToAiColor((def.paint as BridgeSolidPaint).color);
    } catch {
      // Keep the named resource even if this host exposes spot.color
      // differently; node fills still carry inline color fallback.
    }
  }
  return spot;
}

class AiLibraryReconciler {
  // TODO MERGE: full bodies of all four index methods + apply/create/
  // update for color/text/component.

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private indexLocalSwatches(doc: any): Map<string, any> {
    const out = new Map();
    for (let i = 0; i < doc.swatches.length; i++) {
      const s = doc.swatches[i];
      const id = extractColorStyleIdFromName(String(s.name ?? ''));
      if (id) out.set(id, s);
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private indexLocalCharStyles(doc: any): Map<string, any> {
    const out = new Map();
    for (let i = 0; i < doc.characterStyles.length; i++) {
      const s = doc.characterStyles[i];
      const id = extractTextStyleIdFromName(String(s.name ?? ''));
      if (id) out.set(id, s);
    }
    return out;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private indexLocalSymbols(doc: any): Map<string, any> {
    const out = new Map();
    for (let i = 0; i < doc.symbols.length; i++) {
      const s = doc.symbols[i];
      const id = extractSymbolIdFromName(String(s.name ?? ''));
      if (id) out.set(id, s);
    }
    return out;
  }

  // M10.4: solid styles map to Spot resources; gradient styles map to
  // Illustrator Gradient resources.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyColorStyle(resource: any, def: ColorStyleDef): any {
    return applyColorStyle(resource, def);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async createColorStyle(doc: any, def: ColorStyleDef): Promise<any> {
    return createColorStyle(doc, def);
  }

  // TODO MERGE: applyTextStyle / createTextStyle (M5).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private applyTextStyle(style: any, def: TextStyleDef): void {
    style.name = stampNameWithTextStyleId(def.name, def.id);
    // TODO MERGE: write character attributes (size, font, leading, etc.)
    // via style.characterAttributes.
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async createTextStyle(doc: any, def: TextStyleDef): Promise<any> {
    const style = doc.characterStyles.add(`__bridge_charstyle_${Date.now()}`);
    this.applyTextStyle(style, def);
    return style;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async createSymbol(doc: any, def: ComponentDef, resolution: AiLibraryResolution, _fetchAsset: (hash: string) => Promise<Uint8Array>): Promise<any> {
    return createComponentInDoc(doc, def, resolution, '');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async updateSymbol(symbol: any, def: ComponentDef, resolution: AiLibraryResolution): Promise<void> {
    const updated = await applyComponentDefinition(symbol, def, resolution, '');
    if (updated && updated !== symbol) {
      resolution.components.set(def.id, updated);
    }
  }

  // M5.5: orphan rename (instead of .remove())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orphanRename(item: any): void {
    const cleaned = stripM5Markers(String(item.name ?? '')).replace(/^\[Bridge: orphan\] /, '');
    try {
      item.name = `[Bridge: orphan] ${cleaned}`;
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[Bridge] Could not rename orphan "${cleaned}" (read-only)`);
    }
  }

  async reconcile(
    library: BridgeLibrary,
    fetchAsset: (hash: string) => Promise<Uint8Array>
  ): Promise<AiLibraryResolution> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = app.activeDocument;

    const localSwatches = this.indexLocalSwatches(doc);
    const localCharStyles = this.indexLocalCharStyles(doc);
    const localSymbols = this.indexLocalSymbols(doc);

    const resolution: AiLibraryResolution = {
      colorStyles: new Map(),
      textStyles: new Map(),
      components: new Map(),
    };

    for (const [id, def] of Object.entries(library.colorStyles)) {
      const existing = localSwatches.get(id);
      if (existing) {
        const applied = this.applyColorStyle(existing, def);
        resolution.colorStyles.set(id, applied);
      } else {
        resolution.colorStyles.set(id, await this.createColorStyle(doc, def));
      }
    }

    for (const [id, def] of Object.entries(library.textStyles)) {
      const existing = localCharStyles.get(id);
      if (existing) {
        this.applyTextStyle(existing, def);
        resolution.textStyles.set(id, existing);
      } else {
        resolution.textStyles.set(id, await this.createTextStyle(doc, def));
      }
    }

    for (const [id, def] of Object.entries(library.components)) {
      const existing = localSymbols.get(id);
      if (existing) {
        await this.updateSymbol(existing, def, resolution);
        resolution.components.set(id, existing);
      } else {
        const created = await this.createSymbol(doc, def, resolution, fetchAsset);
        if (created) resolution.components.set(id, created);
      }
    }

    // M5.5: orphan rename
    for (const [id, swatch] of localSwatches) {
      if (!library.colorStyles[id]) this.orphanRename(swatch);
    }
    for (const [id, style] of localCharStyles) {
      if (!library.textStyles[id]) this.orphanRename(style);
    }
    for (const [id, sym] of localSymbols) {
      if (!library.components[id]) this.orphanRename(sym);
    }

    return resolution;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Section 9: Instance creation (M5)
// TODO MERGE: full body. Looks up symbol in resolution.components,
// calls symbolItems.add(symbol), positions it, sets opacity/visibility,
// stamps name with bridge id.
// ════════════════════════════════════════════════════════════════════════

function hasInlineInstanceChildren(ir: IRInstanceNode): boolean {
  // M11.2: schema supports children, but keep this runtime-safe for older IR.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const maybeChildren = (ir as any).children;
  return Array.isArray(maybeChildren) && maybeChildren.length > 0;
}

export interface InstanceOverrideWarning {
  instanceId: string;
  instanceName: string;
  componentId: string;
  mode: 'flattened' | 'symbol-with-warning' | 'placeholder';
  reason: string;
  count: number;
}

export interface InstanceOverrideStats {
  warnings: InstanceOverrideWarning[];
}

const instanceOverrideWarnings = new Map<string, InstanceOverrideWarning>();

export function resetInstanceOverrideStats(): void {
  instanceOverrideWarnings.clear();
}

export function getInstanceOverrideStats(): InstanceOverrideStats {
  return {
    warnings: Array.from(instanceOverrideWarnings.values()),
  };
}

function recordInstanceOverrideWarning(
  ir: IRInstanceNode,
  mode: InstanceOverrideWarning['mode'],
  reason: string
): void {
  const key = `${ir.id}|${mode}|${reason}`;
  const existing = instanceOverrideWarnings.get(key);

  if (existing) {
    existing.count += 1;
    return;
  }

  instanceOverrideWarnings.set(key, {
    instanceId: ir.id,
    instanceName: ir.name,
    componentId: ir.componentId,
    mode,
    reason,
    count: 1,
  });
}

function ownInstanceOverrideCount(ir: IRInstanceNode): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyIr: any = ir;
  if (Array.isArray(ir.overrides) && ir.overrides.length > 0) return ir.overrides.length;
  if (anyIr.overrideMeta?.hasOverrides === true) return Number(anyIr.overrideMeta?.overrideCount ?? 1);
  if (anyIr.sourceMeta?.hasOverrides === true) return Number(anyIr.sourceMeta?.overrideCount ?? 1);
  if (Number(anyIr.sourceMeta?.overrideCount ?? 0) > 0) return Number(anyIr.sourceMeta.overrideCount);
  return 0;
}

function hasDeepInstanceOverrides(ir: IRInstanceNode): boolean {
  if (ownInstanceOverrideCount(ir) > 0) return true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children = ((ir as any).children ?? []) as IRNode[];
  for (const child of children) {
    if (child.type === 'instance' && hasDeepInstanceOverrides(child)) return true;

    if (child.type === 'group') {
      for (const groupChild of child.children) {
        if (groupChild.type === 'instance' && hasDeepInstanceOverrides(groupChild)) return true;
      }
      if (child.clipPath?.type === 'instance' && hasDeepInstanceOverrides(child.clipPath)) {
        return true;
      }
    }
  }

  return false;
}

function describeInstanceOverrideReason(ir: IRInstanceNode): string {
  const ownCount = ownInstanceOverrideCount(ir);
  if (ownCount > 0) {
    const kinds = Array.from(
      new Set((ir.overrides ?? []).map((override) => override.kind || override.property))
    ).filter(Boolean);

    if (kinds.length > 0) {
      return `${ownCount} override(s): ${kinds.join(', ')}`;
    }

    return `${ownCount} override(s)`;
  }

  if (hasDeepInstanceOverrides(ir)) {
    return 'deep descendant override(s)';
  }

  return 'no overrides';
}

type InstanceRenderMode =
  | 'symbol'
  | 'flattened'
  | 'symbol-with-warning'
  | 'placeholder';

interface InstanceRenderDecision {
  mode: InstanceRenderMode;
  reason: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  symbol: any | null;
}

function decideInstanceRenderMode(
  ir: IRInstanceNode,
  resolution: AiLibraryResolution
): InstanceRenderDecision {
  const symbol = resolution.components.get(ir.componentId) ?? null;
  const hasSymbol = !!symbol;
  const hasChildren = hasInlineInstanceChildren(ir);
  const hasOverrides = hasDeepInstanceOverrides(ir);

  if (!hasOverrides && hasSymbol) {
    return {
      mode: 'symbol',
      reason: 'clean instance with resolved symbol',
      symbol,
    };
  }

  if (hasOverrides && hasChildren) {
    return {
      mode: 'flattened',
      reason: describeInstanceOverrideReason(ir),
      symbol,
    };
  }

  if (!hasSymbol && hasChildren) {
    return {
      mode: 'flattened',
      reason: `missing component symbol ${ir.componentId}`,
      symbol,
    };
  }

  if (hasOverrides && hasSymbol) {
    return {
      mode: 'symbol-with-warning',
      reason: `${describeInstanceOverrideReason(ir)} but no expanded children are available`,
      symbol,
    };
  }

  return {
    mode: 'placeholder',
    reason: `missing component symbol ${ir.componentId} and no inline children are available`,
    symbol,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyInstanceGeometryAndVisuals(item: any, ir: IRInstanceNode, container: AiRect): void {
  const tuple = irRectToAiTuple(
    { x: ir.position.x, y: ir.position.y, width: ir.size.width, height: ir.size.height },
    container
  );

  try {
    item.position = [tuple[0], tuple[1]];
  } catch {
    // Some symbol-like objects expose bounds but not direct position.
  }

  try {
    if (ir.size.width > 0) item.width = ir.size.width;
    if (ir.size.height > 0) item.height = ir.size.height;
  } catch {
    // Width/height assignment can be read-only for some nested symbol items.
  }

  if (Math.abs(ir.rotation ?? 0) > 0.0001) {
    try {
      item.rotate((ir.rotation * 180) / Math.PI);
    } catch {
      // Rotation support varies by host object; bounds placement is still safe.
    }
  }

  item.opacity = ir.opacity * 100;
  item.hidden = !ir.visible;
  item.locked = ir.locked;
  item.name = stampNameWithBridgeId(ir.name || 'Instance', ir.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addSymbolItemToParent(parent: any, symbol: any): any | null {
  try {
    if (parent?.symbolItems?.add) return parent.symbolItems.add(symbol);
  } catch {
    // Fall through to document-level creation + move.
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = app.activeDocument;
    const item = doc.symbolItems.add(symbol);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ElementPlacement: any = aiModule.ElementPlacement ?? {};
      item.move(parent, ElementPlacement.PLACEATEND ?? 'placeatend');
    } catch {
      // If moving into the parent fails, keep the created symbol item rather
      // than throwing. This is still better than losing the instance entirely.
    }

    return item;
  } catch {
    return null;
  }
}

async function renderInstanceInlineFallback(
  ir: IRInstanceNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string,
  reason: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (!hasInlineInstanceChildren(ir)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Cannot place instance "${ir.name}" (${reason}) and no inline children are available.`
    );
    return createMissingInstancePlaceholder(ir, container, layer, reason);
  }

  // eslint-disable-next-line no-console
  console.warn(
    `[Bridge] Rendering instance "${ir.name}" inline (${reason}). ` +
    `Nested symbol linkage is degraded for this instance only.`
  );

  const group = layer.groupItems.add();
  group.name = stampNameWithBridgeId(`${ir.name || 'Instance'} [inline]`, ir.id);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children = ((ir as any).children ?? []) as IRNode[];
  for (const child of children) {
    await createLeafAt(child, container, group, resolution, assetBaseUrl);
  }

  applyInstanceGeometryAndVisuals(group, ir, container);
  return group;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMissingInstancePlaceholder(
  ir: IRInstanceNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  reason: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any | null {
  try {
    const tuple = irRectToAiTuple(
      { x: ir.position.x, y: ir.position.y, width: ir.size.width, height: ir.size.height },
      container
    );

    const rect = layer.pathItems.rectangle(
      tuple[1],
      tuple[0],
      Math.max(1, ir.size.width),
      Math.max(1, ir.size.height)
    );
    rect.filled = false;
    rect.stroked = true;
    rect.opacity = Math.max(20, ir.opacity * 100);
    rect.hidden = !ir.visible;
    rect.locked = ir.locked;
    rect.name = stampNameWithBridgeId(
      `${ir.name || 'Missing Instance'} [missing: ${reason}]`,
      ir.id
    );
    return rect;
  } catch {
    return null;
  }
}

async function createInstance(
  ir: IRInstanceNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string = ''
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const decision = decideInstanceRenderMode(ir, resolution);

  if (decision.mode === 'flattened') {
    recordInstanceOverrideWarning(ir, 'flattened', decision.reason);
    return renderInstanceInlineFallback(
      ir,
      container,
      layer,
      resolution,
      assetBaseUrl,
      decision.reason
    );
  }

  if (decision.mode === 'placeholder') {
    recordInstanceOverrideWarning(ir, 'placeholder', decision.reason);
    return createMissingInstancePlaceholder(ir, container, layer, decision.reason);
  }

  if (decision.mode === 'symbol-with-warning') {
    recordInstanceOverrideWarning(ir, 'symbol-with-warning', decision.reason);
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Instance "${ir.name}" has ${decision.reason}; ` +
      `placing the base symbol and ignoring overrides for this instance.`
    );
  }

  const sym = addSymbolItemToParent(layer, decision.symbol);
  if (!sym) {
    recordInstanceOverrideWarning(
      ir,
      hasInlineInstanceChildren(ir) ? 'flattened' : 'placeholder',
      `Illustrator refused to place component symbol ${ir.componentId}`
    );
    return renderInstanceInlineFallback(
      ir,
      container,
      layer,
      resolution,
      assetBaseUrl,
      `Illustrator refused to place component symbol ${ir.componentId}`
    );
  }

  applyInstanceGeometryAndVisuals(sym, ir, container);
  return sym;
}

// ════════════════════════════════════════════════════════════════════════
// Section 10: AiReconciler (M4 base + M4.5 + M5 + M6)
// TODO MERGE: most of this class needs cross-milestone merging.
// ════════════════════════════════════════════════════════════════════════

interface AiReconcileStats {
  containersCreated: number;
  containersUpdated: number;
  containersDeleted: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesDeleted: number;
  nodesReplaced: number;
  imagesShortCircuited: number;
}

function makeAiStats(): AiReconcileStats {
  return {
    containersCreated: 0, containersUpdated: 0, containersDeleted: 0,
    nodesCreated: 0, nodesUpdated: 0, nodesDeleted: 0, nodesReplaced: 0,
    imagesShortCircuited: 0,
  };
}

// TODO MERGE: indexBridgeOwnedItems / indexBridgeOwnedArtboards (M3/M4),
// snapshotItemContainers (M4.5 — global cross-container index).

class AiReconciler {
  private resolution: AiLibraryResolution = {
    colorStyles: new Map(),
    textStyles: new Map(),
    components: new Map(),
  };

  private layer: any = null;

  constructor(
    private readonly assetBaseUrl: string,
    public readonly stats: AiReconcileStats = makeAiStats()
  ) {}

  // M5/M6 createLeaf
  private async createLeaf(ir: IRNode, container: AiRect): Promise<void> {
    if (ir.type === 'group') {
      await createGroup(
        ir,
        container,
        this.assetBaseUrl,
        this.layer,
        this.resolution,
        (child, c, layer) => this.createLeafIntoLayer(child, c, layer),
      );
      return;
    }
    if (ir.type === 'instance') {
      await createInstance(ir, container, this.layer, this.resolution, this.assetBaseUrl);
      return;
    }
    if (ir.type === 'vector') {
      if (ir.subpaths.length > 1) {
        await rebuildCompoundPath(ir, container, this.layer, this.resolution);
      } else {
        const path = this.layer.pathItems.add();
        await rebuildVectorPath(path, ir, container);
        applyVectorVisuals(path, ir, container, this.resolution);
      }
      return;
    }
    if (ir.type === 'text') {
      await createText(ir, container, this.layer);
      return;
    }
    if (ir.type === 'image') {
      await placeAndEmbedImage(ir, container, this.layer, this.assetBaseUrl);
      return;
    }
  }

  // M6 helper for nested groups
  private async createLeafIntoLayer(
    ir: IRNode,
    container: AiRect,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layer: any
  ): Promise<void> {
    if (ir.type === 'vector') {
      if (ir.subpaths.length > 1) {
        // TODO MERGE: nested compound path inside a group is awkward in
        // AI. M6 punted to single-subpath fallback. Confirm.
        const path = layer.pathItems.add();
        await rebuildVectorPath(path, ir, container);
        applyVectorVisuals(path, ir, container, this.resolution);
      } else {
        const path = layer.pathItems.add();
        await rebuildVectorPath(path, ir, container);
        applyVectorVisuals(path, ir, container, this.resolution);
      }
    } else if (ir.type === 'text') {
      const tf = layer.textFrames.add();
      tf.contents = ir.characters;
      applyTextAttributes(tf, ir, container);
    } else if (ir.type === 'image') {
      await placeAndEmbedImage(ir, container, layer, this.assetBaseUrl);
    } else if (ir.type === 'group') {
      await createGroup(
        ir,
        container,
        this.assetBaseUrl,
        layer,
        this.resolution,
        (child, c, l) => this.createLeafIntoLayer(child, c, l),
      );
    } else if (ir.type === 'instance') {
      await createInstance(ir, container, layer, this.resolution, this.assetBaseUrl);
    }
  }

  // TODO MERGE: updateLeaf (M4 + M5 + M6 branches).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async updateLeaf(existing: any, ir: IRNode, container: AiRect): Promise<void> {
    const tn = String(existing.typename);
    if (ir.type === 'vector' && (tn === 'PathItem' || tn === 'CompoundPathItem')) {
      // TODO MERGE: handle the compound vs single transitions, fillRule
      // changes, and the M5/M6 stroke and gradient updates.
      if (tn === 'PathItem' && ir.subpaths.length === 1) {
        await rebuildVectorPath(existing, ir, container);
        applyVectorVisuals(existing, ir, container, this.resolution);
        return;
      }
      // Otherwise force replacement
      throw new Error('updateLeaf: vector subpath count changed; replace required');
    }
    if (ir.type === 'text' && tn === 'TextFrame') {
      await updateText(existing, ir, container);
      return;
    }
    if (ir.type === 'image' && (tn === 'PlacedItem' || tn === 'RasterItem')) {
      const result = await updateImage(existing, ir, container, this.layer, this.assetBaseUrl);
      if (!result.rebuilt) this.stats.imagesShortCircuited++;
      return;
    }
    if (ir.type === 'instance' && tn === 'SymbolItem') {
      // TODO MERGE: M5 instance update — reposition + opacity. Symbol
      // swap (if componentId changed) requires replace, not update.
      const aiDoc = irPointToAiDoc(ir.position.x, ir.position.y, container);
      existing.position = [aiDoc.x, aiDoc.y];
      existing.opacity = ir.opacity * 100;
      existing.hidden = !ir.visible;
      existing.locked = ir.locked;
      return;
    }
    if (ir.type === 'group' && tn === 'GroupItem') {
      // TODO MERGE: group update is its own beast. M6 didn't fully spec
      // it; treat as replace for safety.
      throw new Error('updateLeaf: group reconciliation not implemented');
    }
    throw new Error(`updateLeaf: incompatible types ${tn} vs ${ir.type}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private isTypeCompatible(existing: any, ir: IRNode): boolean {
    const tn = String(existing.typename);
    if (ir.type === 'vector') {
      if (ir.subpaths.length > 1) return tn === 'CompoundPathItem';
      return tn === 'PathItem';
    }
    if (ir.type === 'text') return tn === 'TextFrame';
    if (ir.type === 'image') return tn === 'PlacedItem' || tn === 'RasterItem';
    if (ir.type === 'instance') return tn === 'SymbolItem';
    if (ir.type === 'group') return tn === 'GroupItem';
    return false;
  }

  // TODO MERGE: full reconcileContainer + apply from M4/M4.5/M5/M6.
  // Sketch:
  //   1. Build global index of existing bridge-owned items across ALL
  //      containers (M4.5 — for cross-container moves).
  //   2. For each incoming container, find or create the AI artboard.
  //   3. For each incoming child, look up by bridgeId in global index.
  //      If found and type-compat: updateLeaf (possibly moving across
  //      containers). If found but type-incompat: capture z-anchor,
  //      delete, recreate. If not found: createLeaf.
  //   4. Delete orphans (bridge-owned items not in incoming set).

  async apply(doc: BridgeDocument): Promise<AiReconcileStats> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const aiDoc: any = app.activeDocument;
    if (!aiDoc) throw new Error('No active document');

    // Library reconciliation runs FIRST (M5)
    const libReconciler = new AiLibraryReconciler();
    this.resolution = await libReconciler.reconcile(
      doc.library,
      async (_hash) => new Uint8Array(0) // assets fetched by image path directly
    );

    // TODO MERGE: full container reconciliation. The current stub does
    // create-only — replicating M3 always-create behavior. M4+ behavior
    // is what you actually want; pull from your milestone tags.
    this.layer = aiDoc.activeLayer;

    for (const container of doc.containers) {
      // STUB: just create everything fresh.
      const containerRect: AiRect = {
        left: 0, top: 0, right: container.size.width, bottom: -container.size.height,
      };
      // TODO MERGE: real artboard-find/create logic from M4.
      for (const child of container.children) {
        await this.createLeaf(child, containerRect);
        this.stats.nodesCreated++;
      }
      this.stats.containersCreated++;
    }

    return this.stats;
  }
}


// ════════════════════════════════════════════════════════════════════════
// M7 executor-facing top-level exports
// ════════════════════════════════════════════════════════════════════════

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyTextStyle(style: any, def: TextStyleDef): void {
  style.name = stampNameWithTextStyleId(def.name, def.id);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createTextStyle(doc: any, def: TextStyleDef): Promise<any> {
  const style = doc.characterStyles.add(`__bridge_charstyle_${Date.now()}`);
  applyTextStyle(style, def);
  return style;
}

function componentDefinitionContainer(def: ComponentDef): AiRect {
  return {
    left: 0,
    top: 0,
    right: def.size.width,
    bottom: -def.size.height,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildComponentStagingGroup(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  def: ComponentDef,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const stage = doc.groupItems.add();
  stage.name = `__bridge_component_stage_${def.id}_${Date.now()}`;
  stage.hidden = false;
  stage.locked = false;

  const container = componentDefinitionContainer(def);

  if (def.background) {
    try {
      const bg = stage.pathItems.rectangle(
        container.top,
        container.left,
        Math.max(1, def.size.width),
        Math.max(1, def.size.height)
      );
      bg.filled = true;
      bg.fillColor = rgbaToAiColor(def.background);
      bg.stroked = false;
      bg.name = `__bridge_component_background_${def.id}`;
    } catch {
      // Background is cosmetic; never fail symbol creation for it.
    }
  }

  for (const child of def.children) {
    await createLeafAt(child, container, stage, resolution, assetBaseUrl);
  }

  return stage;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createSymbolFromStage(doc: any, stage: any, def: ComponentDef): any | null {
  try {
    const symbol = doc.symbols.add(stage);
    symbol.name = stampNameWithSymbolId(def.name, def.id);
    return symbol;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Failed to create Illustrator symbol "${def.name}": ` +
      `${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  } finally {
    try {
      stage.remove();
    } catch {
      // doc.symbols.add may consume the stage; ignore cleanup failures.
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyComponentDefinition(
  symbol: any,
  def: ComponentDef,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = app.activeDocument;
  const stage = await buildComponentStagingGroup(doc, def, resolution, assetBaseUrl);

  try {
    if (typeof symbol?.redefine === 'function') {
      symbol.redefine(stage);
      symbol.name = stampNameWithSymbolId(def.name, def.id);
      try {
        stage.remove();
      } catch {
        // Some redefine implementations consume the art.
      }
      return symbol;
    }

    // Fallback for UXP builds without a symbol redefine API. This does not
    // preserve existing SymbolItem identity, but it lets parent symbols rebuild
    // against the new resource during the same child-first execution pass.
    orphanRenameLibraryResource(symbol);
    return createSymbolFromStage(doc, stage, def);
  } catch (e) {
    try {
      stage.remove();
    } catch {
      // ignore
    }

    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Failed to update component symbol "${def.name}": ` +
      `${e instanceof Error ? e.message : String(e)}`
    );
    return symbol ?? null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function createComponentInDoc(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  def: ComponentDef,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  const stage = await buildComponentStagingGroup(doc, def, resolution, assetBaseUrl);
  return createSymbolFromStage(doc, stage, def);
}

export async function createArtboardAt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  container: Container
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const tuple = irCanvasRectToArtboardTuple(
    {
      x: container.documentPosition.x,
      y: container.documentPosition.y,
      width: container.size.width,
      height: container.size.height,
    },
    { x: 0, y: 0 }
  );
  const artboard = aiDoc.artboards.add(tuple);
  applyArtboardVisuals(artboard, container);
  return artboard;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyArtboardVisuals(artboard: any, container: Container): void {
  try {
    artboard.artboardRect = irCanvasRectToArtboardTuple(
      {
        x: container.documentPosition.x,
        y: container.documentPosition.y,
        width: container.size.width,
        height: container.size.height,
      },
      { x: 0, y: 0 }
    );
  } catch {
    // Some hosts do not allow direct artboardRect assignment on all objects.
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function removeArtboardAndDetach(aiDoc: any, artboard: any): void {
  for (let i = 0; i < aiDoc.artboards.length; i++) {
    if (aiDoc.artboards[i] === artboard) {
      aiDoc.artboards.remove(i);
      return;
    }
  }
}

export async function createLeafAt(
  ir: IRNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any | null> {
  if (ir.type === 'group') {
    return createGroup(ir, container, assetBaseUrl, layer, resolution, (child, c, l) => createLeafAt(child, c, l, resolution, assetBaseUrl));
  }
  if (ir.type === 'instance') return createInstance(ir, container, layer, resolution, assetBaseUrl);
  if (ir.type === 'vector') {
    if (ir.subpaths.length > 1) return rebuildCompoundPath(ir, container, layer, resolution);
    const path = layer.pathItems.add();
    await rebuildVectorPath(path, ir, container);
    applyVectorVisuals(path, ir, container, resolution);
    return path;
  }
  if (ir.type === 'text') return createText(ir, container, layer);
  if (ir.type === 'image') return placeAndEmbedImage(ir, container, layer, assetBaseUrl);
  return null;
}

export async function updateLeafIn(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  existing: any,
  ir: IRNode,
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layer: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
): Promise<void> {
  const tn = String(existing.typename);
  if (ir.type === 'vector' && tn === 'PathItem' && ir.subpaths.length === 1) {
    await rebuildVectorPath(existing, ir, container);
    applyVectorVisuals(existing, ir, container, resolution);
    return;
  }
  if (ir.type === 'text' && tn === 'TextFrame') {
    await updateText(existing, ir, container);
    return;
  }
  if (ir.type === 'image' && (tn === 'PlacedItem' || tn === 'RasterItem')) {
    await updateImage(existing, ir, container, layer, assetBaseUrl);
    return;
  }
  throw new Error(`updateLeafIn: incompatible or unsupported update ${tn} vs ${ir.type}`);
}

// ════════════════════════════════════════════════════════════════════════
// Public entry — same signature since M3
// ════════════════════════════════════════════════════════════════════════

export async function applyDocument(
  doc: BridgeDocument,
  assetBaseUrl: string
): Promise<{ ok: true; count: number; stats: AiReconcileStats } | { ok: false; error: string }> {
  try {
    const reconciler = new AiReconciler(assetBaseUrl);
    const stats = await reconciler.apply(doc);
    const total = stats.nodesCreated + stats.nodesUpdated + stats.nodesReplaced;
    return { ok: true, count: total, stats };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
