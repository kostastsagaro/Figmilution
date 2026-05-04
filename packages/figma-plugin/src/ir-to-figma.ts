/**
 * ═══════════════════════════════════════════════════════════════════════
 * RECONSTRUCTION FILE — ir-to-figma.ts
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Patched in M2, M3, M4, M4.5, M5, M5.5, M6. The most heavily-revised
 * file in the project. Every milestone touched parts of this.
 *
 * Milestone summary:
 *   M2:    Initial receiver. Created vector/text/image leaves into a
 *          frame container.
 *   M3:    No major changes (this is the receiver; M3 added the AI
 *          receiver and the Figma sender path).
 *   M4:    The big rewrite. Introduced FigmaReconciler class with
 *          create/update/delete passes by bridgeId. Added type-compat
 *          checking and replace-on-type-change.
 *   M4.5:  Verified Figma side already had global delete pass; no
 *          structural changes here.
 *   M5:    LibraryReconciler runs first; resolution map threaded into
 *          createLeaf/updateLeaf. createInstanceLeaf added. *Resolved
 *          variants of leaf appliers (applyVectorVisualsResolved etc).
 *   M5.5:  indexLocalComponents now scans figma.root with timing warning;
 *          Bridge Components page used for parking new components.
 *   M6:    Gradient apply, multi-style text apply (applyMultiStyleText),
 *          GroupNode creation with optional clipPath, container.clipsContent
 *          threaded through, orphan rename for paint/text styles
 *          (replacing the M5 .remove() calls — symmetry with AI side).
 *
 * KNOWN GAPS:
 *   1. The full M4 FigmaReconciler class with all its methods (apply,
 *      reconcileFrameChildren, indexFrameChildren, indexPageContainers,
 *      detachUserChildrenAndDelete, etc.) was shown across M4, M5, M6
 *      with overlapping changes. I have the structure but not every
 *      method body.
 *   2. The leaf appliers (applyVectorGeometry, applyVectorVisuals/Resolved,
 *      applyTextContent/Resolved, applyTextLayout, applyImageGeometry,
 *      applyImageFill, subpathToSvgD, deriveFigmaFontStyle,
 *      colorRgbaToFigmaSolid) appeared in pieces. I've stubbed the
 *      ones I'm least sure about.
 *   3. createGroupNode (M6) has a recursion pattern via applyLeafFn
 *      that needs careful integration with FigmaReconciler.createLeaf.
 *      I've sketched it but the wiring needs review.
 * ═══════════════════════════════════════════════════════════════════════
 */

import {
  BRIDGE_ID_PLUGIN_KEY,
  BRIDGE_SHARED_NAMESPACE,
  BRIDGE_LIBRARY_BRIDGE_ID_KEY,
  type Anchor,
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
  type InstanceNode as IRInstanceNode,
  type Node as IRNode,
  type TextRun,
  type TextStyleDef,
  type TextNode as IRTextNode,
  type VectorNode as IRVectorNode,
  unitEndpointsToFigmaLinearTransform,
  unitEndpointsToFigmaRadialTransform,
} from '@bridge/shared';

// ════════════════════════════════════════════════════════════════════════
// Section 1: Paint / color / image helpers
// TODO MERGE: most of these have stable bodies from M4 onward, but the
// final M6 versions are scattered. Pull from your M4.5 → M6 git diffs.
// ════════════════════════════════════════════════════════════════════════

function colorRgbaToFigmaSolid(c: ColorRGBA): SolidPaint {
  return {
    type: 'SOLID',
    color: { r: c.r, g: c.g, b: c.b },
    opacity: c.a,
    visible: true,
  };
}

function colorStopsToFigma(stops: ColorStop[]): ColorStop[] {
  return [...stops].sort((a, b) => a.position - b.position).map((s) => ({
    position: s.position,
    color: s.color,
  }));
}

function bridgePaintToFigma(p: BridgePaint): Paint | null {
  if (p.type === 'solid') {
    const sp = p as BridgeSolidPaint;
    return {
      type: 'SOLID',
      color: { r: sp.color.r, g: sp.color.g, b: sp.color.b },
      opacity: sp.opacity * sp.color.a,
      visible: sp.visible,
    };
  }
  if (p.type === 'linearGradient') {
    const g = p as BridgeLinearGradientPaint;
    const transform = unitEndpointsToFigmaLinearTransform(g.startUnit, g.endUnit);
    return {
      type: 'GRADIENT_LINEAR',
      gradientTransform: transform as unknown as Transform,
      gradientStops: colorStopsToFigma(g.stops),
      opacity: g.opacity,
      visible: g.visible,
    };
  }
  if (p.type === 'radialGradient') {
    const g = p as BridgeRadialGradientPaint;
    const transform = unitEndpointsToFigmaRadialTransform(g.centerUnit, g.radiusEndUnit);
    return {
      type: 'GRADIENT_RADIAL',
      gradientTransform: transform as unknown as Transform,
      gradientStops: colorStopsToFigma(g.stops),
      opacity: g.opacity,
      visible: g.visible,
    };
  }
  return null;
}

function bridgePaintsToFigma(paints: BridgePaint[]): Paint[] {
  const out: Paint[] = [];
  for (const p of paints) {
    const fp = bridgePaintToFigma(p);
    if (fp) out.push(fp);
  }
  return out;
}

// TODO MERGE: subpathToSvgD from M2 (stable through all later milestones)
function subpathToSvgD(anchors: Anchor[], closed: boolean): string {
  if (anchors.length === 0) return '';
  const first = anchors[0]!;
  const cmds: string[] = [`M ${first.point.x} ${first.point.y}`];
  for (let i = 1; i < anchors.length; i++) {
    const prev = anchors[i - 1]!;
    const curr = anchors[i]!;
    cmds.push(
      `C ${prev.handleOut.x} ${prev.handleOut.y}, ` +
      `${curr.handleIn.x} ${curr.handleIn.y}, ` +
      `${curr.point.x} ${curr.point.y}`
    );
  }
  if (closed) {
    const last = anchors[anchors.length - 1]!;
    cmds.push(
      `C ${last.handleOut.x} ${last.handleOut.y}, ` +
      `${first.handleIn.x} ${first.handleIn.y}, ` +
      `${first.point.x} ${first.point.y}`
    );
    cmds.push('Z');
  }
  return cmds.join(' ');
}

function applyVectorGeometry(node: VectorNode, ir: IRVectorNode): void {
  const paths: VectorPaths = ir.subpaths.map((sp) => ({
    windingRule: ir.fillRule === 'evenodd' ? 'EVENODD' : 'NONZERO',
    data: subpathToSvgD(sp.anchors, sp.closed),
  }));
  node.vectorPaths = paths;
  node.x = ir.position.x;
  node.y = ir.position.y;
}

function applyVectorVisuals(node: VectorNode, ir: IRVectorNode): void {
  node.name = ir.name;
  node.visible = ir.visible;
  node.locked = ir.locked;
  node.opacity = ir.opacity;
  const fills = bridgePaintsToFigma(ir.fills);
  node.fills = fills.length > 0 ? fills : [];
}

// TODO MERGE: applyVectorVisualsResolved (M5) — wraps applyVectorVisuals
// with style-link resolution. Body shown in M5; pull from git.
function applyVectorVisualsResolved(
  node: VectorNode,
  ir: IRVectorNode,
  resolution: LibraryResolution
): void {
  applyVectorVisuals(node, ir);
  const firstStyledFill = ir.fills.find((p) => 'styleId' in p && p.styleId) as BridgeSolidPaint | undefined;
  if (firstStyledFill?.styleId) {
    const style = resolution.colorStyles.get(firstStyledFill.styleId);
    if (style) {
      try { node.fillStyleId = style.id; } catch { /* fallback to literal */ }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════
// Section 2: Text (M6 multi-style apply)
// ════════════════════════════════════════════════════════════════════════

function deriveFigmaFontStyle(run: TextRun | undefined | { fontWeight: number; fontStyle: string }): string {
  if (!run) return 'Regular';
  const isBold = run.fontWeight >= 600;
  const isItalic = run.fontStyle === 'italic';
  if (isBold && isItalic) return 'Bold Italic';
  if (isBold) return 'Bold';
  if (isItalic) return 'Italic';
  return 'Regular';
}

// TODO MERGE: applyMultiStyleText (M6) full body. The M6 version
// pre-loads all fonts used in any run, then applies per-range attributes.
async function applyMultiStyleText(node: TextNode, ir: IRTextNode): Promise<void> {
  const allRuns = ir.paragraphs.flatMap((p) => p.runs);

  const fontNames: FontName[] = allRuns.map((run) => ({
    family: run.fontFamily,
    style: deriveFigmaFontStyle(run),
  }));

  const uniqueFonts = new Map<string, FontName>();
  for (const fn of fontNames) {
    uniqueFonts.set(`${fn.family}|${fn.style}`, fn);
  }
  if (node.fontName !== figma.mixed) {
    const cur = node.fontName as FontName;
    uniqueFonts.set(`${cur.family}|${cur.style}`, cur);
  }

  const fallback: FontName = { family: 'Inter', style: 'Regular' };
  await figma.loadFontAsync(fallback);
  const loaded = new Set<string>();
  loaded.add(`${fallback.family}|${fallback.style}`);
  for (const fn of uniqueFonts.values()) {
    try {
      await figma.loadFontAsync(fn);
      loaded.add(`${fn.family}|${fn.style}`);
    } catch { /* font unavailable */ }
  }

  const firstRun = allRuns[0];
  const firstFont: FontName = firstRun
    ? { family: firstRun.fontFamily, style: deriveFigmaFontStyle(firstRun) }
    : fallback;
  node.fontName = loaded.has(`${firstFont.family}|${firstFont.style}`) ? firstFont : fallback;

  node.characters = ir.characters;

  for (const run of allRuns) {
    const start = Math.max(0, Math.min(run.start, ir.characters.length));
    const end = Math.max(start, Math.min(run.end, ir.characters.length));
    if (start >= end) continue;

    const fn: FontName = { family: run.fontFamily, style: deriveFigmaFontStyle(run) };
    const fnEffective = loaded.has(`${fn.family}|${fn.style}`) ? fn : fallback;

    try {
      node.setRangeFontName(start, end, fnEffective);
      node.setRangeFontSize(start, end, run.fontSize);
      node.setRangeLetterSpacing(start, end, { unit: 'PIXELS', value: run.letterSpacing });

      const figmaFills = bridgePaintsToFigma(run.fills);
      if (figmaFills.length > 0) {
        node.setRangeFills(start, end, figmaFills as Paint[]);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[Bridge] Failed to apply run ${start}-${end} on "${node.name}":`, e);
    }
  }
}

async function applyTextContent(node: TextNode, ir: IRTextNode): Promise<void> {
  await applyMultiStyleText(node, ir);
}

async function applyTextContentResolved(
  node: TextNode,
  ir: IRTextNode,
  resolution: LibraryResolution
): Promise<void> {
  await applyTextContent(node, ir);
  const firstRun = ir.paragraphs[0]?.runs[0];
  if (firstRun?.textStyleId) {
    const style = resolution.textStyles.get(firstRun.textStyleId);
    if (style) {
      try { node.textStyleId = style.id; } catch { /* fallback to literal */ }
    }
  }
  const firstFillWithStyle = firstRun?.fills.find((p) => 'styleId' in p && p.styleId) as BridgeSolidPaint | undefined;
  if (firstFillWithStyle?.styleId) {
    const colorStyle = resolution.colorStyles.get(firstFillWithStyle.styleId);
    if (colorStyle) {
      try { node.fillStyleId = colorStyle.id; } catch { /* ignore */ }
    }
  }
}

function applyTextLayout(node: TextNode, ir: IRTextNode): void {
  node.name = ir.name;
  node.visible = ir.visible;
  node.locked = ir.locked;
  node.opacity = ir.opacity;

  const firstPara = ir.paragraphs[0];
  if (firstPara) {
    node.textAlignHorizontal = firstPara.alignH.toUpperCase() as
      | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
    if (firstPara.lineHeight > 0) {
      node.lineHeight = { unit: 'PIXELS', value: firstPara.lineHeight };
    } else {
      node.lineHeight = { unit: 'AUTO' };
    }
  }

  node.textAlignVertical = ir.alignV.toUpperCase() as 'TOP' | 'CENTER' | 'BOTTOM';
  node.textAutoResize =
    ir.autoResize === 'widthAndHeight' ? 'WIDTH_AND_HEIGHT' :
    ir.autoResize === 'height'         ? 'HEIGHT' :
                                         'NONE';
  node.x = ir.position.x;
  node.y = ir.position.y;
}

// ════════════════════════════════════════════════════════════════════════
// Section 3: Image (M4 with hash short-circuit)
// ════════════════════════════════════════════════════════════════════════

// Pure-JS base64 decoder — atob is not available in the Figma sandbox.
const _b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const _b64lookup: Record<string, number> = {};
for (let _bi = 0; _bi < _b64chars.length; _bi++) _b64lookup[_b64chars[_bi]!] = _bi;

function base64ToBytes(b64str: string): Uint8Array {
  const str = b64str.replace(/^data:[^;]+;base64,/, '').replace(/[^A-Za-z0-9+/=]/g, '');
  const len = str.length;
  let outputLen = Math.floor(len * 3 / 4);
  if (str[len - 1] === '=') outputLen--;
  if (str[len - 2] === '=') outputLen--;
  const bytes = new Uint8Array(outputLen);
  let byteIdx = 0;
  for (let i = 0; i < len; i += 4) {
    const a = _b64lookup[str[i]] ?? 0;
    const b = _b64lookup[str[i + 1]] ?? 0;
    const c = _b64lookup[str[i + 2]] ?? 0;
    const d = _b64lookup[str[i + 3]] ?? 0;
    bytes[byteIdx++] = (a << 2) | (b >> 4);
    if (byteIdx < outputLen) bytes[byteIdx++] = ((b & 15) << 4) | (c >> 2);
    if (byteIdx < outputLen) bytes[byteIdx++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

async function applyImageFill(
  rect: RectangleNode,
  ir: IRImageNode,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<void> {
  const previousHash = rect.getPluginData('bridgeImageHash');
  if (previousHash === ir.image.hash) return;
  try {
    let bytes: Uint8Array;
    if (ir.image.dataBase64) {
      // Inline base64 path — used when Illustrator embeds image data directly
      // (no companion server upload needed; works for AI→Figma transfers).
      bytes = base64ToBytes(ir.image.dataBase64);
    } else {
      bytes = await fetchAsset(ir.image.hash);
    }
    const figmaImage = figma.createImage(bytes);
    rect.fills = [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: figmaImage.hash }];
    rect.setPluginData('bridgeImageHash', ir.image.hash);
  } catch (e) {
    figma.notify(
      `Bridge: image ${ir.image.hash.slice(0, 8)} unavailable (${e instanceof Error ? e.message : 'fetch failed'})`,
      { error: true }
    );
  }
}

function applyImageGeometry(rect: RectangleNode, ir: IRImageNode): void {
  rect.name = ir.name;
  rect.visible = ir.visible;
  rect.locked = ir.locked;
  rect.opacity = ir.opacity;
  rect.resize(ir.size.width, ir.size.height);
  rect.x = ir.position.x;
  rect.y = ir.position.y;
}

// ════════════════════════════════════════════════════════════════════════
// Section 4: Library reconciler (M5 + M5.5 + M6 orphan rename)
// TODO MERGE: full bodies from M5/M5.5/M6 patches.
// ════════════════════════════════════════════════════════════════════════

export interface LibraryResolution {
  colorStyles: Map<string, PaintStyle>;
  textStyles: Map<string, TextStyle>;
  components: Map<string, ComponentNode>;
}

// ════════════════════════════════════════════════════════════════════════
// Section 4a: M7 top-level exports (lifted from class private methods)
// ════════════════════════════════════════════════════════════════════════

export function applyColorStyle(style: PaintStyle, def: ColorStyleDef): void {
  style.name = def.name;
  if (def.paint.type === 'solid') {
    const sp = def.paint as BridgeSolidPaint;
    style.paints = [{
      type: 'SOLID',
      color: { r: sp.color.r, g: sp.color.g, b: sp.color.b },
      opacity: sp.opacity * sp.color.a,
      visible: sp.visible,
    }];
  }
}

export async function createColorStyle(def: ColorStyleDef): Promise<PaintStyle> {
  const style = figma.createPaintStyle();
  applyColorStyle(style, def);
  style.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, def.id);
  return style;
}

export async function applyTextStyle(style: TextStyle, def: TextStyleDef): Promise<void> {
  style.name = def.name;
  const fontName: FontName = {
    family: def.fontFamily,
    style: deriveFigmaFontStyle({ fontWeight: def.fontWeight, fontStyle: def.fontStyle }),
  };
  try {
    await figma.loadFontAsync(fontName);
    style.fontName = fontName;
  } catch {
    const fb: FontName = { family: 'Inter', style: 'Regular' };
    await figma.loadFontAsync(fb);
    style.fontName = fb;
  }
  style.fontSize = def.fontSize;
  style.letterSpacing = { unit: 'PIXELS', value: def.letterSpacing };
  if (def.lineHeight > 0) {
    style.lineHeight = { unit: 'PIXELS', value: def.lineHeight };
  } else {
    style.lineHeight = { unit: 'AUTO' };
  }
  (style as any).textAlignHorizontal = def.alignH.toUpperCase() as
    | 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED';
}

export async function createTextStyle(def: TextStyleDef): Promise<TextStyle> {
  const style = figma.createTextStyle();
  await applyTextStyle(style, def);
  return style;
}

export async function applyComponentDefinition(
  component: ComponentNode,
  def: ComponentDef,
  resolution: LibraryResolution,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<void> {
  component.name = def.name;
  component.resize(def.size.width, def.size.height);
  if (def.background) {
    component.fills = [colorRgbaToFigmaSolid(def.background)];
  } else {
    component.fills = [];
  }
  for (const child of [...component.children]) child.remove();
  for (const ir of def.children) {
    if (ir.type === 'vector') {
      const v = figma.createVector();
      component.appendChild(v);
      applyVectorGeometry(v, ir);
      applyVectorVisualsResolved(v, ir, resolution);
      v.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
    } else if (ir.type === 'text') {
      const t = figma.createText();
      component.appendChild(t);
      await applyTextContentResolved(t, ir, resolution);
      applyTextLayout(t, ir);
      t.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
    } else if (ir.type === 'image') {
      const r = figma.createRectangle();
      component.appendChild(r);
      applyImageGeometry(r, ir);
      await applyImageFill(r, ir, fetchAsset);
      r.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
    }
  }
}

export async function createComponentInPark(
  def: ComponentDef,
  pageName: string,
  resolution: LibraryResolution,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<ComponentNode> {
  let page: PageNode | undefined;
  for (const child of figma.root.children) {
    if (child.type === 'PAGE' && child.name === pageName) {
      if (typeof (child as PageNode).loadAsync === 'function') {
        await (child as PageNode).loadAsync();
      }
      page = child as PageNode;
      break;
    }
  }
  if (!page) {
    page = figma.createPage();
    page.name = pageName;
  }

  let lowestBottom = 0;
  for (const child of page.children) {
    if ('y' in child && 'height' in child) {
      const bottom = (child as { y: number; height: number }).y + (child as { y: number; height: number }).height;
      if (bottom > lowestBottom) lowestBottom = bottom;
    }
  }

  const component = figma.createComponent();
  component.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, def.id);
  page.appendChild(component);
  component.x = 0;
  component.y = lowestBottom + 50;

  await applyComponentDefinition(component, def, resolution, fetchAsset);
  return component;
}

export function applyContainerVisuals(frame: FrameNode, ir: Container): void {
  frame.name = `[Bridge] ${ir.name}`;
  frame.resize(ir.size.width, ir.size.height);
  frame.clipsContent = ir.clipsContent;
  if (ir.background) {
    frame.fills = [colorRgbaToFigmaSolid(ir.background)];
  } else {
    frame.fills = [];
  }
  if (ir.kind === 'pasteboard') {
    frame.strokes = [{
      type: 'SOLID', color: { r: 0.6, g: 0.6, b: 0.6 }, opacity: 1, visible: true,
    }];
    frame.strokeWeight = 1;
    frame.dashPattern = [4, 4];
  } else {
    frame.strokes = [];
    frame.dashPattern = [];
  }
}

export function detachUserChildrenAndDelete(frame: FrameNode): void {
  const pageOrigin = { x: frame.x, y: frame.y };
  const childrenSnapshot = [...frame.children];
  for (const child of childrenSnapshot) {
    const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
    if (!id) {
      const worldX = pageOrigin.x + ('x' in child ? (child as { x: number }).x : 0);
      const worldY = pageOrigin.y + ('y' in child ? (child as { y: number }).y : 0);
      figma.currentPage.appendChild(child);
      if ('x' in child) (child as { x: number }).x = worldX;
      if ('y' in child) (child as { y: number }).y = worldY;
    }
  }
  frame.remove();
}

export async function createLeafAt(
  ir: IRNode,
  parent: FrameNode,
  resolution: LibraryResolution,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<SceneNode> {
  if (ir.type === 'group') {
    return await createGroupNode(
      ir,
      parent,
      resolution,
      fetchAsset,
      (child, p) => createLeafAt(child, p, resolution, fetchAsset),
    );
  }
  if (ir.type === 'instance') {
    const inst = await createInstanceLeaf(ir, parent, resolution);
    if (!inst) {
      const f = figma.createFrame();
      parent.appendChild(f);
      f.x = ir.position.x; f.y = ir.position.y;
      f.resize(ir.size.width, ir.size.height);
      f.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
      return f;
    }
    return inst;
  }
  if (ir.type === 'vector') {
    const v = figma.createVector();
    parent.appendChild(v);
    applyVectorGeometry(v, ir);
    applyVectorVisualsResolved(v, ir, resolution);
    v.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
    return v;
  }
  if (ir.type === 'text') {
    const t = figma.createText();
    parent.appendChild(t);
    await applyTextContentResolved(t, ir, resolution);
    applyTextLayout(t, ir);
    t.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
    return t;
  }
  const r = figma.createRectangle();
  parent.appendChild(r);
  applyImageGeometry(r, ir);
  await applyImageFill(r, ir, fetchAsset);
  r.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
  return r;
}

export async function updateLeafIn(
  existing: SceneNode,
  ir: IRNode,
  resolution: LibraryResolution,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<void> {
  if (ir.type === 'instance' && existing.type === 'INSTANCE') {
    const inst = existing as InstanceNode;
    inst.x = ir.position.x;
    inst.y = ir.position.y;
    inst.resize(ir.size.width, ir.size.height);
    inst.rotation = ir.rotation * (180 / Math.PI);
    inst.opacity = ir.opacity;
    inst.visible = ir.visible;
    inst.locked = ir.locked;
    inst.name = ir.name;
    const mainComponent = resolution.components.get(ir.componentId);
    const currentMain = await inst.getMainComponentAsync();
    if (mainComponent && currentMain?.id !== mainComponent.id) {
      inst.swapComponent(mainComponent);
    }
    return;
  }
  if (ir.type === 'vector' && existing.type === 'VECTOR') {
    applyVectorGeometry(existing, ir);
    applyVectorVisualsResolved(existing, ir, resolution);
    return;
  }
  if (ir.type === 'text' && existing.type === 'TEXT') {
    await applyTextContentResolved(existing, ir, resolution);
    applyTextLayout(existing, ir);
    return;
  }
  if (ir.type === 'image' && existing.type === 'RECTANGLE') {
    applyImageGeometry(existing, ir);
    await applyImageFill(existing, ir, fetchAsset);
    return;
  }
  throw new Error(`updateLeafIn: incompatible types ${existing.type} vs ${ir.type}`);
}

const COMPONENT_SCAN_WARN_THRESHOLD_MS = 1500;
const BRIDGE_COMPONENTS_PAGE_NAME = 'Bridge Components';

class FigmaLibraryReconciler {
  private componentParkOffset = 0;

  private indexLocalStyles(): { paint: Map<string, PaintStyle>; text: Map<string, TextStyle> } {
    const paint = new Map<string, PaintStyle>();
    const text = new Map<string, TextStyle>();
    for (const s of figma.getLocalPaintStyles()) {
      const id = s.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
      if (id) paint.set(id, s);
    }
    for (const s of figma.getLocalTextStyles()) {
      const id = s.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
      if (id) text.set(id, s);
    }
    return { paint, text };
  }

  // M5.5: document-wide scan with timing warning
  private async indexLocalComponents(): Promise<Map<string, ComponentNode>> {
    const out = new Map<string, ComponentNode>();
    const start = Date.now();

    if (typeof figma.loadAllPagesAsync === 'function') {
      await figma.loadAllPagesAsync();
    }

    const components = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
    for (const c of components) {
      const id = c.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
      if (id) out.set(id, c);
    }

    const elapsed = Date.now() - start;
    if (elapsed > COMPONENT_SCAN_WARN_THRESHOLD_MS) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Bridge] Component scan took ${elapsed}ms across ${figma.root.children.length} pages.`
      );
    }
    return out;
  }

  // M5.5: dedicated parking page
  private async getOrCreateComponentsPage(): Promise<PageNode> {
    for (const child of figma.root.children) {
      if (child.type === 'PAGE' && child.name === BRIDGE_COMPONENTS_PAGE_NAME) {
        if (typeof child.loadAsync === 'function') {
          await child.loadAsync();
        }
        return child;
      }
    }
    const page = figma.createPage();
    page.name = BRIDGE_COMPONENTS_PAGE_NAME;
    return page;
  }

  // TODO MERGE: applyColorStyle, createColorStyle (M5)
  private applyColorStyle(style: PaintStyle, def: ColorStyleDef): void {
    applyColorStyle(style, def);
  }

  private async createColorStyle(def: ColorStyleDef): Promise<PaintStyle> {
    const style = await createColorStyle(def);
    return style;
  }

  // TODO MERGE: applyTextStyle, createTextStyle (M5)
  private async applyTextStyle(style: TextStyle, def: TextStyleDef): Promise<void> {
    await applyTextStyle(style, def);
  }

  private async createTextStyle(def: TextStyleDef): Promise<TextStyle> {
    const style = figma.createTextStyle();
    await applyTextStyle(style, def);
    style.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, def.id);
    return style;
  }

  // TODO MERGE: applyComponent, createComponent (M5/M5.5).
  // M5.5 added: park on Bridge Components page using
  // computeComponentLayoutPosition.
  private async applyComponent(
    component: ComponentNode,
    def: ComponentDef,
    resolution: LibraryResolution,
    fetchAsset: (hash: string) => Promise<Uint8Array>
  ): Promise<void> {
    await applyComponentDefinition(component, def, resolution, fetchAsset);
  }

  private async createComponent(
    def: ComponentDef,
    resolution: LibraryResolution,
    fetchAsset: (hash: string) => Promise<Uint8Array>
  ): Promise<ComponentNode> {
    return createComponentInPark(def, BRIDGE_COMPONENTS_PAGE_NAME, resolution, fetchAsset);
  }

  private computeComponentLayoutPosition(page: PageNode): { x: number; y: number } {
    let lowestBottom = 0;
    for (const child of page.children) {
      if ('y' in child && 'height' in child) {
        const bottom = child.y + child.height;
        if (bottom > lowestBottom) lowestBottom = bottom;
      }
    }
    return { x: 0, y: lowestBottom + 50 };
  }

  // M6: orphan rename for paint and text styles (symmetry with AI side)
  async reconcile(
    library: BridgeLibrary,
    fetchAsset: (hash: string) => Promise<Uint8Array>
  ): Promise<LibraryResolution> {
    const local = this.indexLocalStyles();
    const localComponents = await this.indexLocalComponents();

    const resolution: LibraryResolution = {
      colorStyles: new Map(),
      textStyles: new Map(),
      components: new Map(),
    };

    for (const [id, def] of Object.entries(library.colorStyles)) {
      const existing = local.paint.get(id);
      if (existing) {
        this.applyColorStyle(existing, def);
        resolution.colorStyles.set(id, existing);
      } else {
        const created = await this.createColorStyle(def);
        resolution.colorStyles.set(id, created);
      }
    }

    for (const [id, def] of Object.entries(library.textStyles)) {
      const existing = local.text.get(id);
      if (existing) {
        await this.applyTextStyle(existing, def);
        resolution.textStyles.set(id, existing);
      } else {
        const created = await this.createTextStyle(def);
        resolution.textStyles.set(id, created);
      }
    }

    for (const [id, def] of Object.entries(library.components)) {
      const existing = localComponents.get(id);
      if (existing) {
        await this.applyComponent(existing, def, resolution, fetchAsset);
        resolution.components.set(id, existing);
      } else {
        const created = await this.createComponent(def, resolution, fetchAsset);
        resolution.components.set(id, created);
      }
    }

    // M6 orphan rename
    const orphanRenameStyle = (style: BaseStyle): void => {
      const cleaned = style.name.replace(/^\[Bridge: orphan\] /, '');
      style.name = `[Bridge: orphan] ${cleaned}`;
      try {
        style.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, '');
      } catch { /* ignore */ }
    };

    for (const [id, style] of local.paint) {
      if (!library.colorStyles[id]) orphanRenameStyle(style);
    }
    for (const [id, style] of local.text) {
      if (!library.textStyles[id]) orphanRenameStyle(style);
    }
    for (const [id, comp] of localComponents) {
      if (!library.components[id]) {
        comp.name = `[Bridge: orphan] ${comp.name.replace(/^\[Bridge: orphan\] /, '')}`;
        try {
          comp.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, '');
        } catch { /* ignore */ }
      }
    }

    return resolution;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Section 5: Group / instance creation (M5 + M6)
// ════════════════════════════════════════════════════════════════════════

async function createInstanceLeaf(
  ir: IRInstanceNode,
  parent: FrameNode,
  resolution: LibraryResolution
): Promise<InstanceNode | null> {
  const component = resolution.components.get(ir.componentId);
  if (!component) {
    figma.notify(`[Bridge] Missing component for instance "${ir.name}"`, { error: true });
    return null;
  }
  const instance = component.createInstance();
  parent.appendChild(instance);
  instance.x = ir.position.x;
  instance.y = ir.position.y;
  instance.resize(ir.size.width, ir.size.height);
  instance.rotation = ir.rotation * (180 / Math.PI);
  instance.opacity = ir.opacity;
  instance.visible = ir.visible;
  instance.locked = ir.locked;
  instance.name = ir.name;
  instance.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
  return instance;
}

// TODO MERGE: createGroupNode (M6). Full body in M6 message. Recurses
// via applyLeafFn (passed by FigmaReconciler) to handle group children.
async function createGroupNode(
  ir: IRGroupNode,
  parent: FrameNode,
  resolution: LibraryResolution,
  fetchAsset: (hash: string) => Promise<Uint8Array>,
  applyLeafFn: (child: IRNode, parent: FrameNode) => Promise<SceneNode>
): Promise<FrameNode> {
  const frame = figma.createFrame();
  parent.appendChild(frame);
  frame.name = ir.name;
  frame.x = ir.position.x;
  frame.y = ir.position.y;
  frame.resize(ir.size.width, ir.size.height);
  frame.fills = [];
  frame.opacity = ir.opacity;
  frame.visible = ir.visible;
  frame.locked = ir.locked;
  frame.clipsContent = ir.clipPath !== undefined;

  if (ir.clipPath) {
    const mask = figma.createVector();
    frame.appendChild(mask);
    applyVectorGeometry(mask, ir.clipPath);
    applyVectorVisualsResolved(mask, ir.clipPath, resolution);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mask as any).isMask = true;
    mask.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.clipPath.id);
  }

  for (const child of ir.children) {
    await applyLeafFn(child, frame);
  }

  frame.setPluginData(BRIDGE_ID_PLUGIN_KEY, ir.id);
  return frame;
}

// ════════════════════════════════════════════════════════════════════════
// Section 6: FigmaReconciler — M4 base, M5 library threading, M6 group
// ════════════════════════════════════════════════════════════════════════

interface ReconcileStats {
  containersCreated: number;
  containersUpdated: number;
  containersDeleted: number;
  nodesCreated: number;
  nodesUpdated: number;
  nodesDeleted: number;
  nodesReplaced: number;
}

function makeStats(): ReconcileStats {
  return {
    containersCreated: 0, containersUpdated: 0, containersDeleted: 0,
    nodesCreated: 0, nodesUpdated: 0, nodesDeleted: 0, nodesReplaced: 0,
  };
}

class FigmaReconciler {
  private resolution: LibraryResolution = {
    colorStyles: new Map(),
    textStyles: new Map(),
    components: new Map(),
  };

  constructor(
    private readonly fetchAsset: (hash: string) => Promise<Uint8Array>,
    public readonly stats: ReconcileStats = makeStats()
  ) {}

  // TODO MERGE: indexFrameChildren, indexPageContainers from M4.
  private indexFrameChildren(frame: FrameNode): Map<string, SceneNode> {
    const map = new Map<string, SceneNode>();
    for (const child of frame.children) {
      const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
      if (id) map.set(id, child);
    }
    return map;
  }

  private indexPageContainers(): Map<string, FrameNode> {
    const map = new Map<string, FrameNode>();
    for (const child of figma.currentPage.children) {
      if (child.type !== 'FRAME') continue;
      const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
      if (id) map.set(id, child);
    }
    return map;
  }

  // M5/M6 isTypeCompatible
  private isTypeCompatible(existing: SceneNode, ir: IRNode): boolean {
    if (ir.type === 'vector') return existing.type === 'VECTOR';
    if (ir.type === 'text') return existing.type === 'TEXT';
    if (ir.type === 'image') return existing.type === 'RECTANGLE';
    if (ir.type === 'instance') return existing.type === 'INSTANCE';
    if (ir.type === 'group') return existing.type === 'FRAME';
    return false;
  }

  // M5/M6 createLeaf
  private async createLeaf(ir: IRNode, parent: FrameNode): Promise<SceneNode> {
    return createLeafAt(ir, parent, this.resolution, this.fetchAsset);
  }

  // TODO MERGE: updateLeaf with all M5/M6 type branches.
  private async updateLeaf(existing: SceneNode, ir: IRNode): Promise<void> {
    return updateLeafIn(existing, ir, this.resolution, this.fetchAsset);
  }

  // TODO MERGE: reconcileFrameChildren — M4 implementation. Walks
  // existingById vs incomingIds, dispatches to update/replace/create/delete.
  private async reconcileFrameChildren(frame: FrameNode, irChildren: IRNode[]): Promise<void> {
    const existingById = this.indexFrameChildren(frame);
    const incomingIds = new Set(irChildren.map((c) => c.id));

    for (const irChild of irChildren) {
      const existing = existingById.get(irChild.id);
      if (existing && this.isTypeCompatible(existing, irChild)) {
        await this.updateLeaf(existing, irChild);
        this.stats.nodesUpdated++;
      } else if (existing) {
        existing.remove();
        await this.createLeaf(irChild, frame);
        this.stats.nodesReplaced++;
      } else {
        await this.createLeaf(irChild, frame);
        this.stats.nodesCreated++;
      }
    }

    for (const [id, node] of existingById) {
      if (!incomingIds.has(id)) {
        node.remove();
        this.stats.nodesDeleted++;
      }
    }
  }

  // TODO MERGE: applyContainerVisuals — M4 base, M6 added clipsContent.
  private applyContainerVisuals(frame: FrameNode, ir: Container): void {
    applyContainerVisuals(frame, ir);
  }

  // TODO MERGE: detachUserChildrenAndDelete (M4)
  private detachUserChildrenAndDelete(frame: FrameNode): void {
    detachUserChildrenAndDelete(frame);
  }

  // M5: library reconciler runs first
  async apply(doc: BridgeDocument): Promise<ReconcileStats> {
    const libReconciler = new FigmaLibraryReconciler();
    this.resolution = await libReconciler.reconcile(doc.library, this.fetchAsset);

    const existingContainers = this.indexPageContainers();
    const incomingContainerIds = new Set(doc.containers.map((c) => c.id));

    const center = figma.viewport.center;
    const pageOrigin = {
      x: center.x - doc.documentBounds.size.width / 2,
      y: center.y - doc.documentBounds.size.height / 2,
    };

    for (const container of doc.containers) {
      let frame = existingContainers.get(container.id);
      if (frame) {
        this.applyContainerVisuals(frame, container);
        await this.reconcileFrameChildren(frame, container.children);
        this.stats.containersUpdated++;
      } else {
        frame = figma.createFrame();
        figma.currentPage.appendChild(frame);
        frame.x = pageOrigin.x + container.documentPosition.x;
        frame.y = pageOrigin.y + container.documentPosition.y;
        frame.setPluginData(BRIDGE_ID_PLUGIN_KEY, container.id);
        this.applyContainerVisuals(frame, container);
        await this.reconcileFrameChildren(frame, container.children);
        this.stats.containersCreated++;
      }
    }

    for (const [id, frame] of existingContainers) {
      if (!incomingContainerIds.has(id)) {
        this.detachUserChildrenAndDelete(frame);
        this.stats.containersDeleted++;
      }
    }

    return this.stats;
  }
}

// ════════════════════════════════════════════════════════════════════════
// Public entry — same signature since M2
// ════════════════════════════════════════════════════════════════════════

export async function applyDocument(
  doc: BridgeDocument,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<{ ok: true; count: number; stats: ReconcileStats } | { ok: false; error: string }> {
  try {
    const reconciler = new FigmaReconciler(fetchAsset);
    const stats = await reconciler.apply(doc);
    const total = stats.nodesCreated + stats.nodesUpdated + stats.nodesReplaced;
    figma.notify(
      `Bridge: ${stats.nodesCreated} new, ${stats.nodesUpdated} updated, ${stats.nodesDeleted} removed`
    );
    return { ok: true, count: total, stats };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    figma.notify(`Bridge error: ${msg}`, { error: true });
    return { ok: false, error: msg };
  }
}
