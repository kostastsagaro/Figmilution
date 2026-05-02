/**
 * Figma planner — M7
 *
 * Pure read against the Figma document. Produces a DocumentPlan that
 * the executor will apply. No mutations to figma.* anywhere in this
 * file. Any helper that calls a setter is forbidden from this module.
 *
 * The planner reads existing bridge-owned nodes via their plugin data
 * (cheap traversals) and emits ops describing what should change.
 * The executor in figma-executor.ts walks the plan and uses the leaf
 * appliers from ir-to-figma.ts to mutate.
 */

import {
  BRIDGE_ID_PLUGIN_KEY,
  BRIDGE_SHARED_NAMESPACE,
  BRIDGE_LIBRARY_BRIDGE_ID_KEY,
  type BridgeDocument,
  type ColorStyleOp,
  type ComponentOp,
  type ContainerOp,
  type DocumentPlan,
  type LibraryPlan,
  type Node as IRNode,
  type NodeOp,
  type ReplaceReason,
  type TextStyleOp,
  type UpdateReason,
  imageHashMatches,
} from '@bridge/shared';

const COMPONENT_SCAN_WARN_THRESHOLD_MS = 1500;

// ────────────────────────────────────────────────────────────────────────
// Document-wide existing-state indexes (read-only)
// ────────────────────────────────────────────────────────────────────────

interface ExistingState {
  containers: Map<string, FrameNode>;
  childrenByContainerId: Map<string, Map<string, SceneNode>>;
  paintStyles: Map<string, PaintStyle>;
  textStyles: Map<string, TextStyle>;
  components: Map<string, ComponentNode>;
}

async function indexExistingState(): Promise<ExistingState> {
  const containers = new Map<string, FrameNode>();
  for (const child of figma.currentPage.children) {
    if (child.type !== 'FRAME') continue;
    const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
    if (id) containers.set(id, child);
  }

  const paintStyles = new Map<string, PaintStyle>();
  for (const s of figma.getLocalPaintStyles()) {
    const id = s.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
    if (id) paintStyles.set(id, s);
  }

  const textStyles = new Map<string, TextStyle>();
  for (const s of figma.getLocalTextStyles()) {
    const id = s.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
    if (id) textStyles.set(id, s);
  }

  const componentsStart = Date.now();
  if (typeof figma.loadAllPagesAsync === 'function') {
    await figma.loadAllPagesAsync();
  }
  const components = new Map<string, ComponentNode>();
  const found = figma.root.findAllWithCriteria({ types: ['COMPONENT'] });
  for (const c of found) {
    const id = c.getSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY);
    if (id) components.set(id, c);
  }
  const componentsElapsed = Date.now() - componentsStart;
  if (componentsElapsed > COMPONENT_SCAN_WARN_THRESHOLD_MS) {
    // eslint-disable-next-line no-console
    console.warn(
      `[Bridge] Component scan took ${componentsElapsed}ms across ${figma.root.children.length} pages.`
    );
  }

  return {
    containers,
    childrenByContainerId: new Map(),
    paintStyles,
    textStyles,
    components,
  };
}

function indexFrameChildren(frame: FrameNode): Map<string, SceneNode> {
  const map = new Map<string, SceneNode>();
  for (const child of frame.children) {
    const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
    if (id) map.set(id, child);
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────
// Compatibility & change detection — pure
// ────────────────────────────────────────────────────────────────────────

function isTypeCompatible(existing: SceneNode, ir: IRNode): boolean {
  if (ir.type === 'vector')   return existing.type === 'VECTOR';
  if (ir.type === 'text')     return existing.type === 'TEXT';
  if (ir.type === 'image')    return existing.type === 'RECTANGLE';
  if (ir.type === 'instance') return existing.type === 'INSTANCE';
  if (ir.type === 'group')    return existing.type === 'FRAME';
  return false;
}

/**
 * Decide whether an existing node matching by bridgeId+type can be
 * "kept" (no operation) or requires update.
 *
 * Conservative: any chance of visual difference → update. False positives
 * waste an op (re-applying identical data); false negatives leave stale
 * visuals on the canvas. Prefer false positives.
 *
 * Returns null if the node can be kept; otherwise an UpdateReason for
 * summary classification.
 */
function classifyChange(existing: SceneNode, ir: IRNode): UpdateReason | null {
  let positionalChange = false;
  if ('x' in existing && existing.x !== ir.position.x) positionalChange = true;
  if ('y' in existing && existing.y !== ir.position.y) positionalChange = true;
  if ('width' in existing && Math.abs(existing.width - ir.size.width) > 0.001) positionalChange = true;
  if ('height' in existing && Math.abs(existing.height - ir.size.height) > 0.001) positionalChange = true;
  if ('opacity' in existing && Math.abs(existing.opacity - ir.opacity) > 0.001) positionalChange = true;

  if (ir.type === 'image') {
    if (imageHashMatches(existing.name, ir.image.hash)) {
      return positionalChange ? 'transform' : null;
    }
    return 'imageHashChanged';
  }

  if (ir.type === 'text') {
    if (existing.type !== 'TEXT') return 'mixed';
    const tn = existing as TextNode;
    if (tn.characters !== ir.characters) return 'textContent';
    if (positionalChange) return 'transform';
    return 'visuals';
  }

  if (ir.type === 'vector') {
    if (positionalChange) return 'transform';
    return 'geometry';
  }

  if (ir.type === 'instance') {
    if (positionalChange) return 'transform';
    return 'visuals';
  }

  if (ir.type === 'group') {
    return 'mixed';
  }

  return 'mixed';
}

function classifyReplaceReason(existing: SceneNode, ir: IRNode): ReplaceReason {
  if (!isTypeCompatible(existing, ir)) return 'typeChanged';
  if (ir.type === 'vector' && existing.type === 'VECTOR') {
    if (ir.subpaths.length !== existing.vectorPaths.length) return 'subpathCountChanged';
  }
  if (ir.type === 'instance') return 'componentChanged';
  if (ir.type === 'group') return 'groupStructureChanged';
  return 'typeChanged';
}

// ────────────────────────────────────────────────────────────────────────
// Library planning
// ────────────────────────────────────────────────────────────────────────

function planLibrary(
  doc: BridgeDocument,
  state: ExistingState
): LibraryPlan {
  const colorStyles: ColorStyleOp[] = [];
  const textStyles: TextStyleOp[] = [];
  const components: ComponentOp[] = [];

  for (const [id, def] of Object.entries(doc.library.colorStyles)) {
    const existing = state.paintStyles.get(id);
    if (existing) {
      colorStyles.push({ kind: 'updateColorStyle', def, existingHandle: existing });
    } else {
      colorStyles.push({ kind: 'createColorStyle', def });
    }
  }
  for (const [id, style] of state.paintStyles) {
    if (!doc.library.colorStyles[id]) {
      colorStyles.push({
        kind: 'renameOrphanColorStyle',
        bridgeId: id,
        existingHandle: style,
        currentName: style.name,
      });
    }
  }

  for (const [id, def] of Object.entries(doc.library.textStyles)) {
    const existing = state.textStyles.get(id);
    if (existing) {
      textStyles.push({ kind: 'updateTextStyle', def, existingHandle: existing });
    } else {
      textStyles.push({ kind: 'createTextStyle', def });
    }
  }
  for (const [id, style] of state.textStyles) {
    if (!doc.library.textStyles[id]) {
      textStyles.push({
        kind: 'renameOrphanTextStyle',
        bridgeId: id,
        existingHandle: style,
        currentName: style.name,
      });
    }
  }

  for (const [id, def] of Object.entries(doc.library.components)) {
    const existing = state.components.get(id);
    if (existing) {
      components.push({ kind: 'updateComponent', def, existingHandle: existing });
    } else {
      components.push({ kind: 'createComponent', def });
    }
  }
  for (const [id, comp] of state.components) {
    if (!doc.library.components[id]) {
      components.push({
        kind: 'renameOrphanComponent',
        bridgeId: id,
        existingHandle: comp,
        currentName: comp.name,
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
  existingChildren: Map<string, SceneNode>
): NodeOp[] {
  const ops: NodeOp[] = [];
  const seenIds = new Set<string>();

  for (const irChild of irChildren) {
    seenIds.add(irChild.id);
    const existing = existingChildren.get(irChild.id);

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

    if (irChild.type === 'vector' && existing.type === 'VECTOR') {
      if (irChild.subpaths.length !== existing.vectorPaths.length) {
        ops.push({
          kind: 'replaceNode',
          ir: irChild,
          existingHandle: existing,
          reason: 'subpathCountChanged',
        });
        continue;
      }
    }

    const reason = classifyChange(existing, irChild);
    if (reason === null) {
      ops.push({ kind: 'keepNode', bridgeId: irChild.id, irKind: irChild.type });
    } else {
      ops.push({ kind: 'updateNode', ir: irChild, existingHandle: existing, reason });
    }
  }

  for (const [id, node] of existingChildren) {
    if (!seenIds.has(id)) {
      ops.push({
        kind: 'deleteNode',
        bridgeId: id,
        existingHandle: node,
        currentName: node.name,
      });
    }
  }

  return ops;
}

// ────────────────────────────────────────────────────────────────────────
// M8: Z-order reconciliation flag
// ────────────────────────────────────────────────────────────────────────

/**
 * Compare existing children's bridge-id z-order against IR children
 * order. Returns true if both subsequences (intersection of bridge-owned
 * items present in both) match. User-authored siblings are ignored.
 */
function existingOrderMatchesIR(frame: FrameNode, irChildren: IRNode[]): boolean {
  const existingBridgeOrder: string[] = [];
  for (const child of frame.children) {
    const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
    if (id) existingBridgeOrder.push(id);
  }

  const irOrder = irChildren.map((c) => c.id);
  const irSet = new Set(irOrder);
  const existingFiltered = existingBridgeOrder.filter((id) => irSet.has(id));
  const existingSet = new Set(existingBridgeOrder);
  const irFiltered = irOrder.filter((id) => existingSet.has(id));

  if (existingFiltered.length !== irFiltered.length) return false;
  for (let i = 0; i < existingFiltered.length; i++) {
    if (existingFiltered[i] !== irFiltered[i]) return false;
  }
  return true;
}

/**
 * Cheap signal-first decision. If we can short-circuit on the op kinds
 * we avoid the order-comparison scan entirely.
 */
function computeRequiresReorder(
  frame: FrameNode,
  irChildren: IRNode[],
  childOps: NodeOp[]
): boolean {
  for (const op of childOps) {
    if (op.kind === 'createNode' || op.kind === 'replaceNode') return true;
  }
  return !existingOrderMatchesIR(frame, irChildren);
}

function planContainers(
  doc: BridgeDocument,
  state: ExistingState
): ContainerOp[] {
  const ops: ContainerOp[] = [];
  const seenIds = new Set<string>();

  for (const container of doc.containers) {
    seenIds.add(container.id);
    const existing = state.containers.get(container.id);

    if (!existing) {
      const childOps: NodeOp[] = container.children.map((ir) => ({
        kind: 'createNode' as const,
        ir,
      }));
      ops.push({
        kind: 'createContainer',
        ir: container,
        children: childOps,
        requiresReorder: false, // M8: new container order is correct by construction
      });
      continue;
    }

    const childIndex = indexFrameChildren(existing);
    state.childrenByContainerId.set(container.id, childIndex);
    const childOps = planContainerChildren(container.children, childIndex);

    const allKept = childOps.every((c) => c.kind === 'keepNode');
    const containerChanged =
      existing.name !== `[Bridge] ${container.name}` ||
      Math.abs(existing.width - container.size.width) > 0.001 ||
      Math.abs(existing.height - container.size.height) > 0.001 ||
      existing.clipsContent !== container.clipsContent;

    if (allKept && !containerChanged) {
      ops.push({ kind: 'keepContainer', bridgeId: container.id });
    } else {
      ops.push({
        kind: 'updateContainer',
        ir: container,
        existingHandle: existing,
        children: childOps,
        requiresReorder: computeRequiresReorder(existing, container.children, childOps), // M8
      });
    }
  }

  for (const [id, frame] of state.containers) {
    if (!seenIds.has(id)) {
      const existingChildren = indexFrameChildren(frame);
      ops.push({
        kind: 'deleteContainer',
        bridgeId: id,
        existingHandle: frame,
        currentName: frame.name,
        affectedNodeCount: existingChildren.size,
      });
    }
  }

  return ops;
}

// ────────────────────────────────────────────────────────────────────────
// Top-level planner
// ────────────────────────────────────────────────────────────────────────

export async function planDocument(doc: BridgeDocument): Promise<DocumentPlan> {
  const state = await indexExistingState();
  const library = planLibrary(doc, state);
  const containers = planContainers(doc, state);
  return {
    schemaVersion: doc.schemaVersion,
    library,
    containers,
    generatedAt: new Date().toISOString(),
  };
}
