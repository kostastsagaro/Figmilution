/**
 * Illustrator planner — M7
 *
 * Pure read against the AI document. Produces a DocumentPlan that the
 * executor will apply. No mutations to the AI doc anywhere in this file.
 *
 * The planner does not need executeAsModalForUXP because it only reads
 * properties (item.name, item.geometricBounds, etc.). UXP allows reads
 * outside modal scope.
 *
 * AI-specific design notes:
 *   - Existing items are identified by ‹bridge:uuid› markers in their
 *     `name` property. We scan ALL artboards + the pasteboard once,
 *     building a global bridgeId → item index. Cross-artboard moves
 *     are correctly classified as Update, not Delete-and-Create
 *     (M4.5 design carried over).
 *   - Image-skip detection uses the ‹img:hash› marker. If the marker
 *     matches the IR's image.hash, we plan a Keep (or Update-with-
 *     transform if geometry moved).
 *   - Library entries carry their bridge ids via ‹style:colorXXX›,
 *     ‹style:textXXX›, ‹sym:XXX› markers in the asset's `name`.
 *   - Symbol contents cannot be cheaply diffed without instantiating
 *     the symbol. For M7 every UpdateComponentOp is conservatively
 *     emitted whenever the symbol exists; the executor's apply path
 *     re-builds the symbol's contents.
 */

import {
  type BridgeDocument,
  type ColorStyleOp,
  type ComponentDef,
  type ComponentOp,
  type ContainerOp,
  type DocumentPlan,
  type LibraryPlan,
  type Node as IRNode,
  type NodeOp,
  type ReplaceReason,
  type TextStyleOp,
  type UpdateReason,
  extractBridgeIdFromName,
  extractColorStyleIdFromName,
  extractSymbolIdFromName,
  extractTextStyleIdFromName,
  imageHashMatches,
} from '@bridge/shared';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aiModule: any = require('illustrator');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = aiModule.app;

// ────────────────────────────────────────────────────────────────────────
// Existing state index
// ────────────────────────────────────────────────────────────────────────

interface ExistingState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemsByBridgeId: Map<string, any>;
  itemContainerByBridgeId: Map<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artboardsByBridgeId: Map<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  swatchesByBridgeId: Map<string, any>; // solid swatches/spots and gradient resources
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  charStylesByBridgeId: Map<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  symbolsByBridgeId: Map<string, any>;
}

function indexExistingState(): ExistingState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = app.activeDocument;
  if (!doc) {
    return {
      itemsByBridgeId: new Map(),
      itemContainerByBridgeId: new Map(),
      artboardsByBridgeId: new Map(),
      swatchesByBridgeId: new Map(),
      charStylesByBridgeId: new Map(),
      symbolsByBridgeId: new Map(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artboardsByBridgeId = new Map<string, any>();
  for (let i = 0; i < doc.artboards.length; i++) {
    const ab = doc.artboards[i];
    const id = extractBridgeIdFromName(String(ab.name ?? ''));
    if (id) artboardsByBridgeId.set(id, ab);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const itemsByBridgeId = new Map<string, any>();
  const itemContainerByBridgeId = new Map<string, string>();

  for (let i = 0; i < doc.pageItems.length; i++) {
    const item = doc.pageItems[i];
    const id = extractBridgeIdFromName(String(item.name ?? ''));
    if (!id) continue;
    itemsByBridgeId.set(id, item);

    // Center-point-in-artboard ownership (M2 heuristic).
    const bounds = item.geometricBounds;
    const cx = (bounds[0] + bounds[2]) / 2;
    const cy = (bounds[1] + bounds[3]) / 2;
    let owningContainerId = 'pasteboard';
    for (let j = 0; j < doc.artboards.length; j++) {
      const ab = doc.artboards[j];
      const r = ab.artboardRect;
      if (cx >= r[0] && cx <= r[2] && cy <= r[1] && cy >= r[3]) {
        const abId = extractBridgeIdFromName(String(ab.name ?? ''));
        if (abId) owningContainerId = abId;
        break;
      }
    }
    itemContainerByBridgeId.set(id, owningContainerId);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const swatchesByBridgeId = new Map<string, any>();
  for (let i = 0; i < doc.swatches.length; i++) {
    const s = doc.swatches[i];
    const id = extractColorStyleIdFromName(String(s.name ?? ''));
    if (id) swatchesByBridgeId.set(id, s);
  }
  // M10.4: gradient color styles are stored as Illustrator Gradient resources,
  // not swatches. Index them in the same color-style map so the planner can
  // update/orphan them using the existing ColorStyleOp pipeline.
  for (let i = 0; i < (doc.gradients?.length ?? 0); i++) {
    const g = doc.gradients[i];
    const id = extractColorStyleIdFromName(String(g.name ?? ''));
    if (id) swatchesByBridgeId.set(id, g);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const charStylesByBridgeId = new Map<string, any>();
  for (let i = 0; i < doc.characterStyles.length; i++) {
    const s = doc.characterStyles[i];
    const id = extractTextStyleIdFromName(String(s.name ?? ''));
    if (id) charStylesByBridgeId.set(id, s);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const symbolsByBridgeId = new Map<string, any>();
  for (let i = 0; i < doc.symbols.length; i++) {
    const s = doc.symbols[i];
    const id = extractSymbolIdFromName(String(s.name ?? ''));
    if (id) symbolsByBridgeId.set(id, s);
  }

  return {
    itemsByBridgeId,
    itemContainerByBridgeId,
    artboardsByBridgeId,
    swatchesByBridgeId,
    charStylesByBridgeId,
    symbolsByBridgeId,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Compatibility & change classification
// ────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isTypeCompatible(existing: any, ir: IRNode): boolean {
  const tn = String(existing.typename);
  if (ir.type === 'vector') {
    if (ir.subpaths.length > 1) return tn === 'CompoundPathItem';
    return tn === 'PathItem';
  }
  if (ir.type === 'text')     return tn === 'TextFrame';
  if (ir.type === 'image')    return tn === 'PlacedItem' || tn === 'RasterItem';
  if (ir.type === 'instance') return tn === 'SymbolItem';
  if (ir.type === 'group')    return tn === 'GroupItem';
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyChange(existing: any, ir: IRNode, container: { left: number; top: number }): UpdateReason | null {
  const bounds = existing.geometricBounds;
  const itemLeft = bounds[0];
  const itemTop = bounds[1];
  const itemWidth = bounds[2] - bounds[0];
  const itemHeight = bounds[1] - bounds[3];

  const irX = ir.position.x + container.left;
  const irY = container.top - ir.position.y;
  const positionalDelta =
    Math.abs(itemLeft - irX) > 0.5 ||
    Math.abs(itemTop - irY) > 0.5 ||
    Math.abs(itemWidth - ir.size.width) > 0.5 ||
    Math.abs(itemHeight - ir.size.height) > 0.5;

  const irOpacityPct = ir.opacity * 100;
  const opacityDelta = Math.abs((existing.opacity ?? 100) - irOpacityPct) > 0.1;

  if (ir.type === 'image') {
    if (imageHashMatches(String(existing.name ?? ''), ir.image.hash)) {
      return positionalDelta || opacityDelta ? 'transform' : null;
    }
    return 'imageHashChanged';
  }

  if (ir.type === 'text') {
    const tnContents = String(existing.contents ?? '');
    if (tnContents !== ir.characters) return 'textContent';
    if (positionalDelta) return 'transform';
    return 'visuals';
  }

  if (ir.type === 'vector') {
    if (positionalDelta) return 'transform';
    return 'geometry';
  }

  if (ir.type === 'instance') {
    if (positionalDelta) return 'transform';
    return 'visuals';
  }

  if (ir.type === 'group') {
    return 'mixed';
  }

  return 'mixed';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyReplaceReason(existing: any, ir: IRNode): ReplaceReason {
  if (!isTypeCompatible(existing, ir)) {
    if (ir.type === 'vector') {
      const tn = String(existing.typename);
      const wasPath = tn === 'PathItem' || tn === 'CompoundPathItem';
      if (wasPath) return 'subpathCountChanged';
    }
    return 'typeChanged';
  }
  if (ir.type === 'instance') return 'componentChanged';
  if (ir.type === 'group') return 'groupStructureChanged';
  return 'typeChanged';
}

// ────────────────────────────────────────────────────────────────────────
// Component dependency ordering — M11.1
// ────────────────────────────────────────────────────────────────────────

function collectComponentDependenciesForPlanner(def: ComponentDef): string[] {
  const explicit = Array.isArray(def.dependencies) ? def.dependencies : [];
  const out = new Set<string>();

  for (const dep of explicit) {
    if (dep && dep !== def.id) out.add(dep);
  }

  return Array.from(out).sort();
}

function topologicallySortComponentIds(
  componentsById: Map<string, ComponentDef>
): string[] {
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const output: string[] = [];
  const cycleEdges: string[] = [];

  function visit(id: string, stack: string[]): void {
    if (permanent.has(id)) return;

    if (temporary.has(id)) {
      cycleEdges.push([...stack, id].join(' -> '));
      return;
    }

    const def = componentsById.get(id);
    if (!def) return;

    temporary.add(id);

    for (const depId of collectComponentDependenciesForPlanner(def)) {
      if (!componentsById.has(depId)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[Bridge] Component "${def.name}" depends on missing component ${depId}; ` +
          `it will fall back during symbol rendering if no resolved symbol exists.`
        );
        continue;
      }

      visit(depId, [...stack, id]);
    }

    temporary.delete(id);
    permanent.add(id);
    output.push(id);
  }

  for (const id of Array.from(componentsById.keys()).sort()) {
    visit(id, []);
  }

  for (const edge of cycleEdges) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Component dependency cycle detected (${edge}); ` +
      `continuing with deterministic best-effort ordering.`
    );
  }

  return output;
}

function buildComponentDependentsIndex(
  componentsById: Map<string, ComponentDef>
): Map<string, Set<string>> {
  const dependents = new Map<string, Set<string>>();

  for (const id of componentsById.keys()) {
    dependents.set(id, new Set());
  }

  for (const [id, def] of componentsById) {
    for (const depId of collectComponentDependenciesForPlanner(def)) {
      if (!componentsById.has(depId)) continue;
      const bucket = dependents.get(depId) ?? new Set<string>();
      bucket.add(id);
      dependents.set(depId, bucket);
    }
  }

  return dependents;
}

function expandDirtyComponentsToDependents(
  baseDirty: Set<string>,
  componentsById: Map<string, ComponentDef>
): Set<string> {
  const dependents = buildComponentDependentsIndex(componentsById);
  const dirty = new Set(baseDirty);
  const queue = Array.from(baseDirty).sort();

  while (queue.length > 0) {
    const id = queue.shift()!;
    const directDependents = Array.from(dependents.get(id) ?? []).sort();

    for (const dependentId of directDependents) {
      if (dirty.has(dependentId)) continue;
      dirty.add(dependentId);
      queue.push(dependentId);
    }
  }

  return dirty;
}


// ────────────────────────────────────────────────────────────────────────
// Library planning
// ────────────────────────────────────────────────────────────────────────

function planLibrary(doc: BridgeDocument, state: ExistingState): LibraryPlan {
  const colorStyles: ColorStyleOp[] = [];
  const textStyles: TextStyleOp[] = [];
  const components: ComponentOp[] = [];

  for (const [id, def] of Object.entries(doc.library.colorStyles)) {
    const existing = state.swatchesByBridgeId.get(id);
    if (existing) {
      colorStyles.push({ kind: 'updateColorStyle', def, existingHandle: existing });
    } else {
      colorStyles.push({ kind: 'createColorStyle', def });
    }
  }
  for (const [id, swatch] of state.swatchesByBridgeId) {
    if (!doc.library.colorStyles[id]) {
      colorStyles.push({
        kind: 'renameOrphanColorStyle',
        bridgeId: id,
        existingHandle: swatch,
        currentName: String(swatch.name ?? ''),
      });
    }
  }

  for (const [id, def] of Object.entries(doc.library.textStyles)) {
    const existing = state.charStylesByBridgeId.get(id);
    if (existing) {
      textStyles.push({ kind: 'updateTextStyle', def, existingHandle: existing });
    } else {
      textStyles.push({ kind: 'createTextStyle', def });
    }
  }
  for (const [id, style] of state.charStylesByBridgeId) {
    if (!doc.library.textStyles[id]) {
      textStyles.push({
        kind: 'renameOrphanTextStyle',
        bridgeId: id,
        existingHandle: style,
        currentName: String(style.name ?? ''),
      });
    }
  }

  const componentsById = new Map<string, ComponentDef>(
    Object.entries(doc.library.components)
  );
  const orderedComponentIds = topologicallySortComponentIds(componentsById);

  // M11.3: The current planner is intentionally conservative and treats every
  // existing component as update-worthy because symbol definitions are not
  // cheaply diffed. We still route the dirty set through transitive-dependent
  // expansion so future hash/diff-based planning can mark only changed
  // components and automatically rebuild their parents.
  const baseDirtyComponentIds = new Set<string>();
  for (const id of orderedComponentIds) {
    baseDirtyComponentIds.add(id);
  }
  const dirtyComponentIds = expandDirtyComponentsToDependents(
    baseDirtyComponentIds,
    componentsById
  );

  for (const id of orderedComponentIds) {
    if (!dirtyComponentIds.has(id)) continue;

    const def = componentsById.get(id);
    if (!def) continue;

    const existing = state.symbolsByBridgeId.get(id);
    if (existing) {
      components.push({ kind: 'updateComponent', def, existingHandle: existing });
    } else {
      components.push({ kind: 'createComponent', def });
    }
  }

  for (const [id, sym] of state.symbolsByBridgeId) {
    if (!doc.library.components[id]) {
      components.push({
        kind: 'renameOrphanComponent',
        bridgeId: id,
        existingHandle: sym,
        currentName: String(sym.name ?? ''),
      });
    }
  }

  return { colorStyles, textStyles, components };
}

// ────────────────────────────────────────────────────────────────────────
// Container + child planning
// ────────────────────────────────────────────────────────────────────────

function planContainerChildren(
  irChildren: IRNode[],
  containerId: string,
  state: ExistingState,
  containerOrigin: { left: number; top: number }
): NodeOp[] {
  const ops: NodeOp[] = [];
  const seenIds = new Set<string>();

  for (const irChild of irChildren) {
    seenIds.add(irChild.id);
    const existing = state.itemsByBridgeId.get(irChild.id);

    if (!existing) {
      ops.push({ kind: 'createNode', ir: irChild });
      continue;
    }

    if (!isTypeCompatible(existing, irChild)) {
      ops.push({
        kind: 'replaceNode',
        ir: irChild,
        existingHandle: existing,
        reason: classifyReplaceReason(existing, irChild),
      });
      continue;
    }

    const reason = classifyChange(existing, irChild, containerOrigin);
    if (reason === null) {
      ops.push({ kind: 'keepNode', bridgeId: irChild.id, irKind: irChild.type });
    } else {
      ops.push({ kind: 'updateNode', ir: irChild, existingHandle: existing, reason });
    }
  }

  for (const [bridgeId, ownerId] of state.itemContainerByBridgeId) {
    if (ownerId !== containerId) continue;
    if (seenIds.has(bridgeId)) continue;
    const item = state.itemsByBridgeId.get(bridgeId);
    if (!item) continue;
    ops.push({
      kind: 'deleteNode',
      bridgeId,
      existingHandle: item,
      currentName: String(item.name ?? ''),
    });
  }

  return ops;
}

// ────────────────────────────────────────────────────────────────────────
// M8: Z-order reconciliation flag
// ────────────────────────────────────────────────────────────────────────

/**
 * Read existing bridge-owned items inside an artboard, in z-order.
 *
 * AI's pageItems[] is the document's flat list, top-to-bottom. We
 * filter to items whose center sits inside the artboard, in pageItems
 * iteration order.
 *
 * Latency note: ~200 synchronous name reads per 200-item layer.
 * Empirically 50-150ms. Acceptable for the dry-run phase per M8 design.
 */
function readExistingZOrderInArtboard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artboard: any
): string[] {
  const r = artboard.artboardRect;
  const order: string[] = [];

  for (let i = 0; i < doc.pageItems.length; i++) {
    const item = doc.pageItems[i];
    const id = extractBridgeIdFromName(String(item.name ?? ''));
    if (!id) continue;

    const b = item.geometricBounds;
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    if (cx >= r[0] && cx <= r[2] && cy <= r[1] && cy >= r[3]) {
      order.push(id);
    }
  }

  return order;
}

function existingOrderMatchesIR(existingOrder: string[], irChildren: IRNode[]): boolean {
  const irOrder = irChildren.map((c) => c.id);
  const irSet = new Set(irOrder);
  const existingFiltered = existingOrder.filter((id) => irSet.has(id));
  const existingSet = new Set(existingOrder);
  const irFiltered = irOrder.filter((id) => existingSet.has(id));

  if (existingFiltered.length !== irFiltered.length) return false;
  for (let i = 0; i < existingFiltered.length; i++) {
    if (existingFiltered[i] !== irFiltered[i]) return false;
  }
  return true;
}

function computeRequiresReorder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artboard: any,
  irChildren: IRNode[],
  childOps: NodeOp[]
): boolean {
  for (const op of childOps) {
    if (op.kind === 'createNode' || op.kind === 'replaceNode') return true;
  }
  const existingOrder = readExistingZOrderInArtboard(doc, artboard);
  return !existingOrderMatchesIR(existingOrder, irChildren);
}

function planContainers(
  doc: BridgeDocument,
  state: ExistingState
): ContainerOp[] {
  const ops: ContainerOp[] = [];
  const seenContainerIds = new Set<string>();

  for (const container of doc.containers) {
    seenContainerIds.add(container.id);
    const existing = state.artboardsByBridgeId.get(container.id);

    if (!existing) {
      const childOps: NodeOp[] = container.children.map((ir) => ({
        kind: 'createNode' as const,
        ir,
      }));
      ops.push({
        kind: 'createContainer',
        ir: container,
        children: childOps,
        requiresReorder: false, // M8: new artboard order is correct by construction
      });
      continue;
    }

    const r = existing.artboardRect;
    const containerOrigin = { left: r[0], top: r[1] };
    const childOps = planContainerChildren(
      container.children,
      container.id,
      state,
      containerOrigin
    );

    const allKept = childOps.every((c) => c.kind === 'keepNode');
    const containerWidth = r[2] - r[0];
    const containerHeight = r[1] - r[3];
    const containerSizeChanged =
      Math.abs(containerWidth - container.size.width) > 0.5 ||
      Math.abs(containerHeight - container.size.height) > 0.5;

    if (allKept && !containerSizeChanged) {
      ops.push({ kind: 'keepContainer', bridgeId: container.id });
    } else {
      ops.push({
        kind: 'updateContainer',
        ir: container,
        existingHandle: existing,
        children: childOps,
        requiresReorder: computeRequiresReorder(app.activeDocument, existing, container.children, childOps), // M8
      });
    }
  }

  for (const [bridgeId, ab] of state.artboardsByBridgeId) {
    if (seenContainerIds.has(bridgeId)) continue;
    let affected = 0;
    for (const owner of state.itemContainerByBridgeId.values()) {
      if (owner === bridgeId) affected++;
    }
    ops.push({
      kind: 'deleteContainer',
      bridgeId,
      existingHandle: ab,
      currentName: String(ab.name ?? ''),
      affectedNodeCount: affected,
    });
  }

  return ops;
}

// ────────────────────────────────────────────────────────────────────────
// Top-level planner
// ────────────────────────────────────────────────────────────────────────

export async function planDocument(doc: BridgeDocument): Promise<DocumentPlan> {
  const state = indexExistingState();
  const library = planLibrary(doc, state);
  const containers = planContainers(doc, state);
  return {
    schemaVersion: doc.schemaVersion,
    library,
    containers,
    generatedAt: new Date().toISOString(),
  };
}
