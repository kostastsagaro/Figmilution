/**
 * Operation Plan — M7
 *
 * The reconciler is split into a planner (pure, read-only against the
 * host API) and an executor (mutates the host doc by walking the plan).
 * The plan itself is a tree mirroring the document, where each node is
 * a discriminated-union "op" describing what should happen.
 *
 * Lifecycle:
 *   1. Receiver gets a BridgeDocument.
 *   2. Planner reads existing host state + IR doc → emits DocumentPlan.
 *   3. summarizePlan(plan) → PlanSummary sent to UI.
 *   4. UI shows summary, user clicks Accept or Cancel.
 *   5. On accept: executor walks DocumentPlan, applies ops in order.
 *   6. On cancel: plan is discarded, host doc untouched.
 *
 * Stamping (bridgeId markers, image hash markers, library markers) is
 * NEVER done in the planner. The planner reads existing markers but
 * does not write. All stamping happens in the executor's per-op
 * side-effect. This is what makes cancellation truly side-effect-free.
 */

import type {
  BridgeId,
  ColorStyleDef,
  ComponentDef,
  Container,
  Node,
  TextStyleDef,
} from './bridge-schema';

// ────────────────────────────────────────────────────────────────────────
// Library ops
// ────────────────────────────────────────────────────────────────────────

export interface CreateColorStyleOp {
  kind: 'createColorStyle';
  def: ColorStyleDef;
}
export interface UpdateColorStyleOp {
  kind: 'updateColorStyle';
  def: ColorStyleDef;
  existingHandle: unknown;
}
export interface RenameOrphanColorStyleOp {
  kind: 'renameOrphanColorStyle';
  bridgeId: BridgeId;
  existingHandle: unknown;
  currentName: string;
}
export type ColorStyleOp =
  | CreateColorStyleOp
  | UpdateColorStyleOp
  | RenameOrphanColorStyleOp;

export interface CreateTextStyleOp {
  kind: 'createTextStyle';
  def: TextStyleDef;
}
export interface UpdateTextStyleOp {
  kind: 'updateTextStyle';
  def: TextStyleDef;
  existingHandle: unknown;
}
export interface RenameOrphanTextStyleOp {
  kind: 'renameOrphanTextStyle';
  bridgeId: BridgeId;
  existingHandle: unknown;
  currentName: string;
}
export type TextStyleOp =
  | CreateTextStyleOp
  | UpdateTextStyleOp
  | RenameOrphanTextStyleOp;

export interface CreateComponentOp {
  kind: 'createComponent';
  def: ComponentDef;
}
export interface UpdateComponentOp {
  kind: 'updateComponent';
  def: ComponentDef;
  existingHandle: unknown;
}
export interface RenameOrphanComponentOp {
  kind: 'renameOrphanComponent';
  bridgeId: BridgeId;
  existingHandle: unknown;
  currentName: string;
}
export type ComponentOp =
  | CreateComponentOp
  | UpdateComponentOp
  | RenameOrphanComponentOp;

export interface LibraryPlan {
  colorStyles: ColorStyleOp[];
  textStyles: TextStyleOp[];
  components: ComponentOp[];
}

// ────────────────────────────────────────────────────────────────────────
// Node ops
// ────────────────────────────────────────────────────────────────────────

export interface CreateNodeOp {
  kind: 'createNode';
  ir: Node;
  subPlan?: NodeOp[];
}

export interface UpdateNodeOp {
  kind: 'updateNode';
  ir: Node;
  existingHandle: unknown;
  reason: UpdateReason;
  subPlan?: NodeOp[];
}

export interface ReplaceNodeOp {
  kind: 'replaceNode';
  ir: Node;
  existingHandle: unknown;
  reason: ReplaceReason;
}

export interface DeleteNodeOp {
  kind: 'deleteNode';
  bridgeId: BridgeId;
  existingHandle: unknown;
  currentName: string;
}

export interface KeepNodeOp {
  kind: 'keepNode';
  bridgeId: BridgeId;
  irKind: Node['type'];
}

export type NodeOp =
  | CreateNodeOp
  | UpdateNodeOp
  | ReplaceNodeOp
  | DeleteNodeOp
  | KeepNodeOp;

export type UpdateReason =
  | 'geometry'
  | 'visuals'
  | 'textContent'
  | 'imageHashChanged'
  | 'transform'
  | 'mixed';

export type ReplaceReason =
  | 'typeChanged'
  | 'subpathCountChanged'
  | 'groupStructureChanged'
  | 'componentChanged';

// ────────────────────────────────────────────────────────────────────────
// Container ops
// ────────────────────────────────────────────────────────────────────────

export interface CreateContainerOp {
  kind: 'createContainer';
  ir: Container;
  children: NodeOp[];
  /**
   * M8: whether the executor must run a post-child-ops reorder pass.
   * For new containers this is ALWAYS false — the executor builds
   * children by appending in IR order into a fresh empty container,
   * so resulting z-order is correct by construction.
   */
  requiresReorder: false;
}

export interface UpdateContainerOp {
  kind: 'updateContainer';
  ir: Container;
  existingHandle: unknown;
  children: NodeOp[];
  /**
   * M8: whether the executor must run a post-child-ops reorder pass.
   *
   * Set to true when:
   *   - existing children's bridge-id z-order differs from IR order, OR
   *   - any child op is createNode (lands at end-of-stack), OR
   *   - any child op is replaceNode (deletes then recreates, position lost)
   *
   * Set to false only when all child ops are keepNode/updateNode/deleteNode
   * AND the existing-vs-IR z-order subsequence already matches.
   *
   * The flag is computed by the planner; the executor blindly trusts it.
   */
  requiresReorder: boolean;
}

export interface DeleteContainerOp {
  kind: 'deleteContainer';
  bridgeId: BridgeId;
  existingHandle: unknown;
  currentName: string;
  affectedNodeCount: number;
}

export interface KeepContainerOp {
  kind: 'keepContainer';
  bridgeId: BridgeId;
}

export type ContainerOp =
  | CreateContainerOp
  | UpdateContainerOp
  | DeleteContainerOp
  | KeepContainerOp;

// ────────────────────────────────────────────────────────────────────────
// Document plan + summary
// ────────────────────────────────────────────────────────────────────────

export interface DocumentPlan {
  schemaVersion: string;
  library: LibraryPlan;
  containers: ContainerOp[];
  generatedAt: string;
}

export interface PlanSummary {
  library: {
    colorStyles: { create: number; update: number; renameOrphan: number };
    textStyles:  { create: number; update: number; renameOrphan: number };
    components:  { create: number; update: number; renameOrphan: number };
  };
  document: {
    containersCreated: number;
    containersUpdated: number;
    containersDeleted: number;
    containersKept: number;
    nodesCreated: number;
    nodesUpdated: number;
    nodesReplaced: number;
    nodesDeleted: number;
    nodesKept: number;
  };
  highImpactWarnings: string[];
}

const HIGH_IMPACT_DELETE_THRESHOLD = 10;
const HIGH_IMPACT_ORPHAN_THRESHOLD = 5;

export function summarizePlan(plan: DocumentPlan): PlanSummary {
  const summary: PlanSummary = {
    library: {
      colorStyles: { create: 0, update: 0, renameOrphan: 0 },
      textStyles:  { create: 0, update: 0, renameOrphan: 0 },
      components:  { create: 0, update: 0, renameOrphan: 0 },
    },
    document: {
      containersCreated: 0, containersUpdated: 0, containersDeleted: 0, containersKept: 0,
      nodesCreated: 0, nodesUpdated: 0, nodesReplaced: 0, nodesDeleted: 0, nodesKept: 0,
    },
    highImpactWarnings: [],
  };

  for (const op of plan.library.colorStyles) {
    if (op.kind === 'createColorStyle') summary.library.colorStyles.create++;
    else if (op.kind === 'updateColorStyle') summary.library.colorStyles.update++;
    else summary.library.colorStyles.renameOrphan++;
  }
  for (const op of plan.library.textStyles) {
    if (op.kind === 'createTextStyle') summary.library.textStyles.create++;
    else if (op.kind === 'updateTextStyle') summary.library.textStyles.update++;
    else summary.library.textStyles.renameOrphan++;
  }
  for (const op of plan.library.components) {
    if (op.kind === 'createComponent') summary.library.components.create++;
    else if (op.kind === 'updateComponent') summary.library.components.update++;
    else summary.library.components.renameOrphan++;
  }

  for (const containerOp of plan.containers) {
    switch (containerOp.kind) {
      case 'createContainer':
        summary.document.containersCreated++;
        countNodeOps(containerOp.children, summary);
        break;
      case 'updateContainer':
        summary.document.containersUpdated++;
        countNodeOps(containerOp.children, summary);
        break;
      case 'deleteContainer':
        summary.document.containersDeleted++;
        if (containerOp.affectedNodeCount >= HIGH_IMPACT_DELETE_THRESHOLD) {
          summary.highImpactWarnings.push(
            `Deleting container "${containerOp.currentName}" will remove ${containerOp.affectedNodeCount} item(s).`
          );
        }
        break;
      case 'keepContainer':
        summary.document.containersKept++;
        break;
    }
  }

  if (summary.document.nodesDeleted >= HIGH_IMPACT_DELETE_THRESHOLD) {
    summary.highImpactWarnings.push(
      `${summary.document.nodesDeleted} nodes will be deleted.`
    );
  }
  const totalOrphans =
    summary.library.colorStyles.renameOrphan +
    summary.library.textStyles.renameOrphan +
    summary.library.components.renameOrphan;
  if (totalOrphans >= HIGH_IMPACT_ORPHAN_THRESHOLD) {
    summary.highImpactWarnings.push(
      `${totalOrphans} library item(s) will be renamed as orphans.`
    );
  }

  return summary;
}

function countNodeOps(ops: NodeOp[], summary: PlanSummary): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'createNode':
        summary.document.nodesCreated++;
        if (op.subPlan) countNodeOps(op.subPlan, summary);
        break;
      case 'updateNode':
        summary.document.nodesUpdated++;
        if (op.subPlan) countNodeOps(op.subPlan, summary);
        break;
      case 'replaceNode':
        summary.document.nodesReplaced++;
        break;
      case 'deleteNode':
        summary.document.nodesDeleted++;
        break;
      case 'keepNode':
        summary.document.nodesKept++;
        break;
    }
  }
}

export function formatSummary(summary: PlanSummary): string[] {
  const lines: string[] = [];

  const libBits: string[] = [];
  const cs = summary.library.colorStyles;
  const ts = summary.library.textStyles;
  const co = summary.library.components;
  if (cs.create + cs.update + cs.renameOrphan > 0) {
    const parts: string[] = [];
    if (cs.create) parts.push(`${cs.create} new`);
    if (cs.update) parts.push(`${cs.update} updated`);
    if (cs.renameOrphan) parts.push(`${cs.renameOrphan} orphan-renamed`);
    libBits.push(`Color styles: ${parts.join(', ')}`);
  }
  if (ts.create + ts.update + ts.renameOrphan > 0) {
    const parts: string[] = [];
    if (ts.create) parts.push(`${ts.create} new`);
    if (ts.update) parts.push(`${ts.update} updated`);
    if (ts.renameOrphan) parts.push(`${ts.renameOrphan} orphan-renamed`);
    libBits.push(`Text styles: ${parts.join(', ')}`);
  }
  if (co.create + co.update + co.renameOrphan > 0) {
    const parts: string[] = [];
    if (co.create) parts.push(`${co.create} new`);
    if (co.update) parts.push(`${co.update} updated`);
    if (co.renameOrphan) parts.push(`${co.renameOrphan} orphan-renamed`);
    libBits.push(`Components: ${parts.join(', ')}`);
  }
  if (libBits.length > 0) {
    lines.push('Library:');
    for (const b of libBits) lines.push(`  • ${b}`);
  }

  const d = summary.document;
  const docBits: string[] = [];
  if (d.containersCreated || d.containersUpdated || d.containersDeleted) {
    const parts: string[] = [];
    if (d.containersCreated) parts.push(`${d.containersCreated} new`);
    if (d.containersUpdated) parts.push(`${d.containersUpdated} updated`);
    if (d.containersDeleted) parts.push(`${d.containersDeleted} removed`);
    docBits.push(`Containers: ${parts.join(', ')}`);
  }
  const nodeParts: string[] = [];
  if (d.nodesCreated)  nodeParts.push(`${d.nodesCreated} new`);
  if (d.nodesUpdated)  nodeParts.push(`${d.nodesUpdated} updated`);
  if (d.nodesReplaced) nodeParts.push(`${d.nodesReplaced} replaced`);
  if (d.nodesDeleted)  nodeParts.push(`${d.nodesDeleted} deleted`);
  if (d.nodesKept)     nodeParts.push(`${d.nodesKept} unchanged`);
  if (nodeParts.length > 0) docBits.push(`Nodes: ${nodeParts.join(', ')}`);

  if (docBits.length > 0) {
    lines.push('Document:');
    for (const b of docBits) lines.push(`  • ${b}`);
  }

  if (lines.length === 0) {
    lines.push('No changes — incoming sync matches current state.');
  }

  return lines;
}

export function isPlanNoOp(plan: DocumentPlan): boolean {
  if (plan.library.colorStyles.length > 0) return false;
  if (plan.library.textStyles.length > 0) return false;
  if (plan.library.components.length > 0) return false;
  for (const c of plan.containers) {
    if (c.kind !== 'keepContainer') return false;
  }
  return true;
}
