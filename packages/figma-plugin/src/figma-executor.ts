/**
 * Figma executor — M7
 *
 * Walks a DocumentPlan and applies each op. This is where bridgeId
 * stamping happens (deferred from the planner). All mutations go
 * through the leaf appliers in ir-to-figma.ts.
 *
 * Order:
 *   1. Library ops in order: color → text → component (component
 *      definitions reference styles we just created).
 *   2. Container ops in document order. Within each container, ops
 *      run in IR order so creates/updates that share z-stack ordering
 *      land contiguously.
 *
 * Failure handling: if an op throws, abort and bubble. No rollback —
 * partial application is the known cost of mid-execute failure. The
 * abstraction makes a future transactional upgrade easy without
 * rewriting callers.
 *
 * IMPORTANT: This file imports leaf appliers from ir-to-figma.ts
 * AS TOP-LEVEL EXPORTS. The pre-M7 ir-to-figma.ts had these as
 * `private` methods on FigmaReconciler / FigmaLibraryReconciler.
 * The M7 stitching step lifts them to top-level exports — see the
 * "What ir-to-figma.ts needs to expose" notes in the M7 chat.
 */

import {
  BRIDGE_ID_PLUGIN_KEY,
  BRIDGE_SHARED_NAMESPACE,
  BRIDGE_LIBRARY_BRIDGE_ID_KEY,
  type BridgeDocument,
  type DocumentPlan,
  type Node as IRNode,
  type NodeOp,
} from '@bridge/shared';
import {
  // TODO MERGE: lift these from FigmaReconciler / FigmaLibraryReconciler
  // private methods to top-level exports in ir-to-figma.ts.
  applyContainerVisuals,
  createLeafAt,
  updateLeafIn,
  applyComponentDefinition,
  createComponentInPark,
  applyColorStyle,
  createColorStyle,
  applyTextStyle,
  createTextStyle,
  detachUserChildrenAndDelete,
} from './ir-to-figma';

interface ExecutionResult {
  executedOps: number;
}

// ────────────────────────────────────────────────────────────────────────
// Append-only paste: creates new nodes without touching existing ones.
// Used for inbound Illustrator pushes — no diffing, no deletions.
// ────────────────────────────────────────────────────────────────────────

export async function appendBridgeDocument(
  doc: BridgeDocument,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<{ nodeCount: number }> {
  const resolution = {
    colorStyles: new Map<string, PaintStyle>(),
    textStyles: new Map<string, TextStyle>(),
    components: new Map<string, ComponentNode>(),
  };

  const center = figma.viewport.center;
  const pageOrigin = {
    x: center.x - doc.documentBounds.size.width / 2,
    y: center.y - doc.documentBounds.size.height / 2,
  };

  let nodeCount = 0;
  for (const container of doc.containers) {
    const frame = figma.createFrame();
    figma.currentPage.appendChild(frame);
    frame.x = pageOrigin.x + container.documentPosition.x;
    frame.y = pageOrigin.y + container.documentPosition.y;
    // No bridgeId stamp — these are "pasted" copies, not sync-owned nodes.
    applyContainerVisuals(frame, container);

    for (const ir of container.children) {
      try {
        await createLeafAt(ir, frame, resolution, fetchAsset);
        nodeCount++;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[Bridge] appendBridgeDocument: skipped', ir.type, ir.name, e);
      }
    }
  }
  return { nodeCount };
}

const BRIDGE_COMPONENTS_PAGE_NAME = 'Bridge Components';

export async function executePlan(
  plan: DocumentPlan,
  doc: BridgeDocument,
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<ExecutionResult> {
  let executed = 0;

  // ── 1. Library ─────────────────────────────────────────────────────
  const resolution = {
    colorStyles: new Map<string, PaintStyle>(),
    textStyles: new Map<string, TextStyle>(),
    components: new Map<string, ComponentNode>(),
  };

  for (const op of plan.library.colorStyles) {
    if (op.kind === 'createColorStyle') {
      const created = await createColorStyle(op.def);
      created.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, op.def.id);
      resolution.colorStyles.set(op.def.id, created);
    } else if (op.kind === 'updateColorStyle') {
      const handle = op.existingHandle as PaintStyle;
      applyColorStyle(handle, op.def);
      resolution.colorStyles.set(op.def.id, handle);
    } else {
      const handle = op.existingHandle as PaintStyle;
      const cleaned = handle.name.replace(/^\[Bridge: orphan\] /, '');
      handle.name = `[Bridge: orphan] ${cleaned}`;
      try {
        handle.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, '');
      } catch { /* ignore */ }
    }
    executed++;
  }

  for (const op of plan.library.textStyles) {
    if (op.kind === 'createTextStyle') {
      const created = await createTextStyle(op.def);
      created.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, op.def.id);
      resolution.textStyles.set(op.def.id, created);
    } else if (op.kind === 'updateTextStyle') {
      const handle = op.existingHandle as TextStyle;
      await applyTextStyle(handle, op.def);
      resolution.textStyles.set(op.def.id, handle);
    } else {
      const handle = op.existingHandle as TextStyle;
      const cleaned = handle.name.replace(/^\[Bridge: orphan\] /, '');
      handle.name = `[Bridge: orphan] ${cleaned}`;
      try {
        handle.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, '');
      } catch { /* ignore */ }
    }
    executed++;
  }

  for (const op of plan.library.components) {
    if (op.kind === 'createComponent') {
      const created = await createComponentInPark(
        op.def,
        BRIDGE_COMPONENTS_PAGE_NAME,
        resolution,
        fetchAsset
      );
      created.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, op.def.id);
      resolution.components.set(op.def.id, created);
    } else if (op.kind === 'updateComponent') {
      const handle = op.existingHandle as ComponentNode;
      await applyComponentDefinition(handle, op.def, resolution, fetchAsset);
      resolution.components.set(op.def.id, handle);
    } else {
      const handle = op.existingHandle as ComponentNode;
      const cleaned = handle.name.replace(/^\[Bridge: orphan\] /, '');
      handle.name = `[Bridge: orphan] ${cleaned}`;
      try {
        handle.setSharedPluginData(BRIDGE_SHARED_NAMESPACE, BRIDGE_LIBRARY_BRIDGE_ID_KEY, '');
      } catch { /* ignore */ }
    }
    executed++;
  }

  // ── 2. Containers ──────────────────────────────────────────────────
  const center = figma.viewport.center;
  const pageOrigin = {
    x: center.x - doc.documentBounds.size.width / 2,
    y: center.y - doc.documentBounds.size.height / 2,
  };

  for (const cOp of plan.containers) {
    switch (cOp.kind) {
      case 'keepContainer':
        break;

      case 'createContainer': {
        const frame = figma.createFrame();
        figma.currentPage.appendChild(frame);
        frame.x = pageOrigin.x + cOp.ir.documentPosition.x;
        frame.y = pageOrigin.y + cOp.ir.documentPosition.y;
        frame.setPluginData(BRIDGE_ID_PLUGIN_KEY, cOp.ir.id);
        applyContainerVisuals(frame, cOp.ir);
        await executeNodeOps(cOp.children, frame, resolution, fetchAsset);
        executed++;
        break;
      }

      case 'updateContainer': {
        const frame = cOp.existingHandle as FrameNode;
        applyContainerVisuals(frame, cOp.ir);
        await executeNodeOps(cOp.children, frame, resolution, fetchAsset);
        if (cOp.requiresReorder) {
          reorderFigmaContainerChildren(frame, cOp.ir.children);
        }
        executed++;
        break;
      }

      case 'deleteContainer': {
        const frame = cOp.existingHandle as FrameNode;
        detachUserChildrenAndDelete(frame);
        executed++;
        break;
      }
    }
  }

  return { executedOps: executed };
}

async function executeNodeOps(
  ops: NodeOp[],
  parent: FrameNode,
  resolution: {
    colorStyles: Map<string, PaintStyle>;
    textStyles: Map<string, TextStyle>;
    components: Map<string, ComponentNode>;
  },
  fetchAsset: (hash: string) => Promise<Uint8Array>
): Promise<void> {
  for (const op of ops) {
    switch (op.kind) {
      case 'keepNode':
        break;

      case 'createNode': {
        const created = await createLeafAt(op.ir, parent, resolution, fetchAsset);
        created.setPluginData(BRIDGE_ID_PLUGIN_KEY, op.ir.id);
        // (group sub-plans are M8+; for M7 createGroupNode handles its own children)
        break;
      }

      case 'updateNode': {
        const handle = op.existingHandle as SceneNode;
        await updateLeafIn(handle, op.ir, resolution, fetchAsset);
        break;
      }

      case 'replaceNode': {
        const handle = op.existingHandle as SceneNode;
        const parentChildren = parent.children;
        const idx = parentChildren.indexOf(handle);
        const siblingAfter = (idx >= 0 && idx + 1 < parentChildren.length)
          ? parentChildren[idx + 1]
          : null;

        handle.remove();
        const created = await createLeafAt(op.ir, parent, resolution, fetchAsset);
        created.setPluginData(BRIDGE_ID_PLUGIN_KEY, op.ir.id);
        if (siblingAfter) {
          parent.insertChild(parent.children.indexOf(siblingAfter), created);
        }
        break;
      }

      case 'deleteNode': {
        const handle = op.existingHandle as SceneNode;
        handle.remove();
        break;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// M8: Z-order reordering pass
// ────────────────────────────────────────────────────────────────────────

/**
 * Walk the IR children array in order and ensure the frame's children
 * z-stack matches. Linear pass using parent.insertChild(idx, child).
 *
 * User-authored (non-bridge-owned) siblings keep their positions: we
 * only ever move bridge-owned items, and Figma's insertChild on an
 * already-present node is a detach-then-reinsert that shifts neighbors
 * by one — which is the correct behavior for an "insert here" operation.
 *
 * Algorithm: cursor walks frame.children left to right. For each IR
 * child, we either confirm the host is already at cursor (advance) or
 * insertChild it there. The careful bit is the index-shift accounting
 * when host's current index is below cursor: pulling it out shifts
 * everything after it down by one, so we target cursor-1 instead.
 */
function reorderFigmaContainerChildren(
  frame: FrameNode,
  irChildren: IRNode[]
): void {
  // Snapshot bridge-id → host BEFORE any moves. frame.children mutates
  // during insertChild, so we don't want to re-resolve via scan each step.
  const byBridgeId = new Map<string, SceneNode>();
  for (const child of frame.children) {
    const id = child.getPluginData(BRIDGE_ID_PLUGIN_KEY);
    if (id) byBridgeId.set(id, child);
  }

  let cursor = 0;

  for (const ir of irChildren) {
    const host = byBridgeId.get(ir.id);
    if (!host) continue; // child ops should have created it; defensive

    // Skip past user-authored siblings already in place.
    while (
      cursor < frame.children.length &&
      frame.children[cursor] !== host &&
      !frame.children[cursor].getPluginData(BRIDGE_ID_PLUGIN_KEY)
    ) {
      cursor++;
    }

    // Already at cursor? Advance and continue.
    if (cursor < frame.children.length && frame.children[cursor] === host) {
      cursor++;
      continue;
    }

    // Otherwise, move host to cursor. If host's current position is
    // below cursor, detaching it first will shift cursor down by one.
    const currentIdx = frame.children.indexOf(host);
    const effectiveIdx = (currentIdx >= 0 && currentIdx < cursor) ? cursor - 1 : cursor;
    frame.insertChild(effectiveIdx, host);
    cursor = effectiveIdx + 1;
  }
}

