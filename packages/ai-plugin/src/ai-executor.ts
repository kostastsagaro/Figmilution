/**
 * Illustrator executor — M7
 *
 * Walks a DocumentPlan and applies each op via the leaf appliers in
 * ir-to-ai.ts. Wraps the entire run in a single executeAsModalForUXP
 * scope, so AI treats the whole sync as one user-undoable transaction.
 *
 * This is where the ‹bridge:…›, ‹img:…›, ‹style:…›, ‹sym:…› markers
 * are stamped — deferred from the planner per the M7 architectural rule.
 *
 * Order:
 *   1. Library: colorStyles → textStyles → components.
 *   2. Containers: per IR document order. Container ops own their
 *      child node ops.
 *
 * IMPORTANT: this file imports leaf appliers from ir-to-ai.ts AS
 * TOP-LEVEL EXPORTS. The pre-M7 ir-to-ai.ts had these as private
 * methods on AiReconciler / AiLibraryReconciler. The M7 stitching step
 * lifts them to top-level exports — see "Stitching Guide for ir-to-ai.ts"
 * in the M7 chat.
 */

import {
  type BridgeDocument,
  type DocumentPlan,
  type Node as IRNode,
  type NodeOp,
  type ColorStyleOp,
  type TextStyleOp,
  type ComponentOp,
  type ContainerOp,
  stampNameWithColorStyleId,
  stampNameWithTextStyleId,
  stampNameWithSymbolId,
  stampNameWithBridgeId,
  stripM5Markers,
  extractBridgeIdFromName,
} from '@bridge/shared';
import {
  aiRectFromTuple,
  type AiRect,
} from './coords';
import {
  // TODO MERGE: lift these from AiReconciler / AiLibraryReconciler
  // private methods to top-level exports in ir-to-ai.ts. See M7 chat.
  applyColorStyle,
  createColorStyle,
  applyTextStyle,
  createTextStyle,
  applyComponentDefinition,
  createComponentInDoc,
  createLeafAt,
  updateLeafIn,
  createArtboardAt,
  applyArtboardVisuals,
  removeArtboardAndDetach,
  captureZOrderAnchor,
  restoreZOrder,
  resetInstanceOverrideStats,
  getInstanceOverrideStats,
  type InstanceOverrideStats,
  type AiLibraryResolution,
} from './ir-to-ai';
import {
  discoverIllustratorFonts,
  getFontResolutionStats,
  resetFontResolutionStats,
  type FontResolutionStats,
} from './font-resolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const aiModule: any = require('illustrator');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const app: any = aiModule.app;

interface ExecutionStats {
  fonts: FontResolutionStats;
  instanceOverrides: InstanceOverrideStats;
}

interface ExecutionResult {
  ok: boolean;
  executedOps: number;
  stats?: ExecutionStats;
  error?: string;
}

export async function executePlan(
  plan: DocumentPlan,
  doc: BridgeDocument,
  assetBaseUrl: string
): Promise<ExecutionResult> {
  let executed = 0;

  resetFontResolutionStats();
  resetInstanceOverrideStats();

  try {
    await app.executeAsModalForUXP?.(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const aiDoc: any = app.activeDocument;
      if (!aiDoc) throw new Error('No active document');

      // M9: one-time safe discovery pass.
      // This walks Illustrator's app.textFonts collection and stores actual
      // TextFont objects. Downstream code must only use resolved objects from
      // this set and must never blindly call getByName().
      discoverIllustratorFonts(app);

      const resolution: AiLibraryResolution = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        colorStyles: new Map<string, any>(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        textStyles: new Map<string, any>(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        components: new Map<string, any>(),
      };

      executed += await executeLibrary(
        plan.library.colorStyles,
        plan.library.textStyles,
        plan.library.components,
        aiDoc,
        resolution,
        assetBaseUrl
      );
      executed += await executeContainers(plan.containers, aiDoc, resolution, assetBaseUrl);
    });

    return {
      ok: true,
      executedOps: executed,
      stats: {
        fonts: getFontResolutionStats(),
        instanceOverrides: getInstanceOverrideStats(),
      },
    };
  } catch (e) {
    return {
      ok: false,
      executedOps: executed,
      error: e instanceof Error ? e.message : String(e),
      stats: {
        fonts: getFontResolutionStats(),
        instanceOverrides: getInstanceOverrideStats(),
      },
    };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Library execution
// ────────────────────────────────────────────────────────────────────────

async function executeLibrary(
  colorOps: ColorStyleOp[],
  textOps: TextStyleOp[],
  componentOps: ComponentOp[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
): Promise<number> {
  let count = 0;

  for (const op of colorOps) {
    if (op.kind === 'createColorStyle') {
      const swatch = await createColorStyle(aiDoc, op.def);
      swatch.name = stampNameWithColorStyleId(op.def.name, op.def.id);
      resolution.colorStyles.set(op.def.id, swatch);
    } else if (op.kind === 'updateColorStyle') {
      const swatch = op.existingHandle;
      const applied = applyColorStyle(swatch, op.def);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (applied as any).name = stampNameWithColorStyleId(op.def.name, op.def.id);
      } catch { /* read-only resource (rare) */ }
      resolution.colorStyles.set(op.def.id, applied);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const swatch: any = op.existingHandle;
      const cleaned = stripM5Markers(String(swatch.name ?? '')).replace(/^\[Bridge: orphan\] /, '');
      try {
        swatch.name = `[Bridge: orphan] ${cleaned}`;
      } catch {
        // eslint-disable-next-line no-console
        console.warn(`[Bridge] Could not orphan-rename swatch "${cleaned}" (read-only)`);
      }
    }
    count++;
  }

  for (const op of textOps) {
    if (op.kind === 'createTextStyle') {
      const style = await createTextStyle(aiDoc, op.def);
      style.name = stampNameWithTextStyleId(op.def.name, op.def.id);
      resolution.textStyles.set(op.def.id, style);
    } else if (op.kind === 'updateTextStyle') {
      const style = op.existingHandle;
      applyTextStyle(style, op.def);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (style as any).name = stampNameWithTextStyleId(op.def.name, op.def.id);
      } catch { /* ignore */ }
      resolution.textStyles.set(op.def.id, style);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const style: any = op.existingHandle;
      const cleaned = stripM5Markers(String(style.name ?? '')).replace(/^\[Bridge: orphan\] /, '');
      try {
        style.name = `[Bridge: orphan] ${cleaned}`;
      } catch { /* ignore */ }
    }
    count++;
  }

  for (const op of componentOps) {
    if (op.kind === 'createComponent') {
      const symbol = await createComponentInDoc(aiDoc, op.def, resolution, assetBaseUrl);
      if (symbol) {
        try {
          symbol.name = stampNameWithSymbolId(op.def.name, op.def.id);
        } catch {
          // eslint-disable-next-line no-console
          console.warn(
            `[Bridge] AI symbol name read-only; bridge id ${op.def.id} not persisted`
          );
        }
        resolution.components.set(op.def.id, symbol);
      }
    } else if (op.kind === 'updateComponent') {
      const symbol = op.existingHandle;
      const applied = await applyComponentDefinition(symbol, op.def, resolution, assetBaseUrl);
      const resolvedSymbol = applied ?? symbol;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (resolvedSymbol as any).name = stampNameWithSymbolId(op.def.name, op.def.id);
      } catch { /* ignore */ }
      resolution.components.set(op.def.id, resolvedSymbol);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sym: any = op.existingHandle;
      const cleaned = stripM5Markers(String(sym.name ?? '')).replace(/^\[Bridge: orphan\] /, '');
      try {
        sym.name = `[Bridge: orphan] ${cleaned}`;
      } catch { /* ignore */ }
    }
    count++;
  }

  return count;
}

// ────────────────────────────────────────────────────────────────────────
// Container + node execution
// ────────────────────────────────────────────────────────────────────────

async function executeContainers(
  containerOps: ContainerOp[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
): Promise<number> {
  let count = 0;

  for (const cOp of containerOps) {
    switch (cOp.kind) {
      case 'keepContainer':
        break;

      case 'createContainer': {
        const ab = await createArtboardAt(aiDoc, cOp.ir);
        ab.name = stampNameWithBridgeId(cOp.ir.name || 'Artboard', cOp.ir.id);
        const containerRect = aiRectFromTuple(ab.artboardRect);
        await executeNodeOps(cOp.children, containerRect, aiDoc, resolution, assetBaseUrl);
        count++;
        break;
      }

      case 'updateContainer': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ab: any = cOp.existingHandle;
        applyArtboardVisuals(ab, cOp.ir);
        try {
          ab.name = stampNameWithBridgeId(cOp.ir.name || 'Artboard', cOp.ir.id);
        } catch { /* ignore */ }
        const containerRect = aiRectFromTuple(ab.artboardRect);
        await executeNodeOps(cOp.children, containerRect, aiDoc, resolution, assetBaseUrl);
        if (cOp.requiresReorder) {
          reorderAiContainerChildren(aiDoc, ab, cOp.ir.children);
        }
        count++;
        break;
      }

      case 'deleteContainer': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ab: any = cOp.existingHandle;
        removeArtboardAndDetach(aiDoc, ab);
        count++;
        break;
      }
    }
  }

  return count;
}

async function executeNodeOps(
  ops: NodeOp[],
  container: AiRect,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  resolution: AiLibraryResolution,
  assetBaseUrl: string
): Promise<void> {
  // Use the active layer as parent for created items. Per-container
  // layer routing is a future hardening pass.
  const layer = aiDoc.activeLayer;

  for (const op of ops) {
    switch (op.kind) {
      case 'keepNode':
        break;

      case 'createNode': {
        await createLeafAt(op.ir, container, layer, resolution, assetBaseUrl);
        // Stamping is the contract of createLeafAt's downstream appliers
        // (each ends with stampNameWith…).
        break;
      }

      case 'updateNode': {
        const handle = op.existingHandle;
        await updateLeafIn(handle, op.ir, container, layer, resolution, assetBaseUrl);
        break;
      }

      case 'replaceNode': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handle: any = op.existingHandle;
        const anchor = captureZOrderAnchor(handle);
        try {
          handle.remove();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[Bridge] Failed to remove item for replace: ${e instanceof Error ? e.message : String(e)}`);
        }
        const created = await createLeafAt(op.ir, container, layer, resolution, assetBaseUrl);
        if (created && anchor.anchorAbove) {
          restoreZOrder(created, anchor);
        }
        break;
      }

      case 'deleteNode': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handle: any = op.existingHandle;
        try {
          handle.remove();
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`[Bridge] Failed to delete "${op.currentName}": ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// M8: AI z-order reordering
// ────────────────────────────────────────────────────────────────────────

/**
 * Cached capability flag for item.move() with ElementPlacement.
 *   null  = not yet probed
 *   true  = move() works → linear algorithm
 *   false = move() unavailable → BRINGTOFRONT-reverse fallback
 *
 * Detected once per executor session. False negatives are safe (slower
 * but correct); false positives would crash on first real move call.
 */
let aiSupportsItemMove: boolean | null = null;

/**
 * Probe whether AI's PageItem.move() with ElementPlacement.PLACEAFTER is
 * available. Tries a no-op move (place item[1] after item[0] in a layer
 * where they're already in that order). If the call doesn't throw,
 * capability confirmed.
 *
 * If no suitable test pair exists (empty doc, single-item layers), we
 * default to the safer fallback path. This is rare in practice; any doc
 * the user is syncing into has multiple items somewhere.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectAiMoveCapability(aiDoc: any): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ElementPlacement: any = aiModule.ElementPlacement ?? {};
  const PLACEAFTER = ElementPlacement.PLACEAFTER ?? 'placeafter';

  for (let li = 0; li < aiDoc.layers.length; li++) {
    const layer = aiDoc.layers[li];
    if (layer.pageItems.length < 2) continue;
    const target = layer.pageItems[1];
    const reference = layer.pageItems[0];
    try {
      target.move(reference, PLACEAFTER);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureAiMoveCapability(aiDoc: any): boolean {
  if (aiSupportsItemMove === null) {
    aiSupportsItemMove = detectAiMoveCapability(aiDoc);
    // eslint-disable-next-line no-console
    console.info(
      `[Bridge] AI z-order capability: ${aiSupportsItemMove ? 'item.move()' : 'fallback (zOrder)'}`
    );
  }
  return aiSupportsItemMove;
}

/**
 * Index bridge-owned items currently inside the artboard, by bridgeId.
 * Scanned at reorder-time rather than reused from the planner because
 * item references may have churned during execute (replacements created
 * new items with new bridgeId stamps).
 */
function indexBridgeOwnedInArtboard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artboard: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = new Map<string, any>();
  const r = artboard.artboardRect;

  for (let i = 0; i < aiDoc.pageItems.length; i++) {
    const item = aiDoc.pageItems[i];
    const id = extractBridgeIdFromName(String(item.name ?? ''));
    if (!id) continue;
    const b = item.geometricBounds;
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    if (cx >= r[0] && cx <= r[2] && cy <= r[1] && cy >= r[3]) {
      map.set(id, item);
    }
  }
  return map;
}

/**
 * LINEAR algorithm: bring first IR child to front, then move each
 * subsequent IR child directly after the previous one with PLACEAFTER.
 *
 * "PLACEAFTER" in AI z-order means "directly below" — pageItems[N+1]
 * sits below pageItems[N] visually. Front-to-back IR order maps to
 * top-to-bottom AI z-order, so PLACEAFTER preserves the IR sequence.
 */
function reorderAiUsingMove(
  irChildren: IRNode[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemsByBridgeId: Map<string, any>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ZOrderMethod: any = aiModule.ZOrderMethod ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ElementPlacement: any = aiModule.ElementPlacement ?? {};
  const BRINGTOFRONT = ZOrderMethod.BRINGTOFRONT ?? 'bringtofront';
  const PLACEAFTER = ElementPlacement.PLACEAFTER ?? 'placeafter';

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prev: any = null;
  for (const ir of irChildren) {
    const host = itemsByBridgeId.get(ir.id);
    if (!host) continue;
    if (prev === null) {
      host.zOrder(BRINGTOFRONT);
    } else {
      host.move(prev, PLACEAFTER);
    }
    prev = host;
  }
}

/**
 * FALLBACK algorithm: BRINGTOFRONT each item in REVERSE IR order.
 *
 * After loop completion: the LAST IR child was BRINGTOFRONTed first
 * (now sits deepest among the bridge-owned cluster), the FIRST IR child
 * was BRINGTOFRONTed last (now sits topmost). Net result: bridge-owned
 * items occupy the topmost positions in the layer, in IR-array order
 * (front-to-back).
 *
 * Each BRINGTOFRONT is O(1) at the AI scripting level; total is O(n)
 * scripting-bridge round-trips. Slower than move()-based by per-call
 * overhead, not by algorithmic complexity.
 *
 * Trade-off: bridge-owned items end up clustered at the top of the
 * z-stack; user-authored items below. This is the price of not having
 * fine-grained move primitives. The next plan respects whatever order
 * is in the AI doc, so the user can rearrange manually and Bridge will
 * preserve their changes.
 */
function reorderAiUsingZOrderFallback(
  irChildren: IRNode[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  itemsByBridgeId: Map<string, any>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ZOrderMethod: any = aiModule.ZOrderMethod ?? {};
  const BRINGTOFRONT = ZOrderMethod.BRINGTOFRONT ?? 'bringtofront';

  for (let i = irChildren.length - 1; i >= 0; i--) {
    const ir = irChildren[i];
    const host = itemsByBridgeId.get(ir.id);
    if (!host) continue;
    host.zOrder(BRINGTOFRONT);
  }
}

function reorderAiContainerChildren(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiDoc: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  artboard: any,
  irChildren: IRNode[]
): void {
  const itemsByBridgeId = indexBridgeOwnedInArtboard(aiDoc, artboard);
  if (itemsByBridgeId.size === 0) return;

  if (ensureAiMoveCapability(aiDoc)) {
    reorderAiUsingMove(irChildren, itemsByBridgeId);
  } else {
    reorderAiUsingZOrderFallback(irChildren, itemsByBridgeId);
  }
}

