/**
 * Bridge IR — the canonical scene description that both Illustrator and Figma
 * sides translate to and from. This file is the contract.
 *
 * Coordinate system (IR-canonical):
 *   - Origin: top-left of the parent container (frame/artboard/group).
 *   - Y axis: increases downward (matches Figma; the AI side flips on translate).
 *   - Rotation: radians, counterclockwise-positive.
 *   - Units: points (1 pt = 1/72 in).
 *
 * Bezier convention:
 *   - Anchors store handles as ABSOLUTE positions in the same coordinate space
 *     as the anchor itself, NOT as deltas. Matches Illustrator's
 *     pathPoint.leftDirection / rightDirection.
 *
 * IR paint types are prefixed `Bridge` to avoid collisions with Figma's
 * plugin-typings `Paint` / `SolidPaint` types.
 */

// ───────────────────────────────────────────────────────────────────────────
// Primitives
// ───────────────────────────────────────────────────────────────────────────

export interface Point2D {
  x: number;
  y: number;
}

export interface Size2D {
  width: number;
  height: number;
}

export interface ColorRGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

// ───────────────────────────────────────────────────────────────────────────
// Paints (M10.1: shared paint base + solid/linear/radial gradient)
// ───────────────────────────────────────────────────────────────────────────

export interface ColorStop {
  /** Position along the gradient line, [0, 1]. */
  position: number;
  /** RGBA. Per-stop alpha is part of the stop's color. */
  color: ColorRGBA;
}

export interface BridgePaintBase {
  opacity: number;
  visible: boolean;
  /** If set, this paint is bound to a ColorStyleDef in the document library. */
  styleId?: BridgeId;
}

export interface BridgeSolidPaint extends BridgePaintBase {
  type: 'solid';
  color: ColorRGBA;
}

/**
 * Linear gradient. Endpoints are in node-local UNIT space (0..1 along
 * width, 0..1 along height). (0,0) is the node's top-left, (1,1) is the
 * node's bottom-right.
 */
export interface BridgeLinearGradientPaint extends BridgePaintBase {
  type: 'linearGradient';
  startUnit: Point2D;
  endUnit: Point2D;
  stops: ColorStop[];
}

/**
 * Radial gradient. Center and a single radius endpoint, both in unit
 * space. M6 only supports CIRCULAR radials; senders should detect
 * elliptical ones and approximate with a warning.
 */
export interface BridgeRadialGradientPaint extends BridgePaintBase {
  type: 'radialGradient';
  centerUnit: Point2D;
  radiusEndUnit: Point2D;
  stops: ColorStop[];
}

export type BridgePaint =
  | BridgeSolidPaint
  | BridgeLinearGradientPaint
  | BridgeRadialGradientPaint;

// ───────────────────────────────────────────────────────────────────────────
// Stroke
// ───────────────────────────────────────────────────────────────────────────

export type StrokeAlign = 'inside' | 'center' | 'outside';
export type StrokeCap = 'none' | 'round' | 'square';
export type StrokeJoin = 'miter' | 'round' | 'bevel';

export interface BridgeStroke {
  paint: BridgePaint;
  weight: number;
  align: StrokeAlign;
  cap: StrokeCap;
  join: StrokeJoin;
  miterLimit: number;
  dashPattern: number[];
}

// ───────────────────────────────────────────────────────────────────────────
// Common node fields
// ───────────────────────────────────────────────────────────────────────────

export type BridgeId = string;

export interface NodeBase {
  id: BridgeId;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  position: Point2D;
  size: Size2D;
  rotation: number;
  sourceMeta?: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────────
// Vector node
// ───────────────────────────────────────────────────────────────────────────

export type AnchorType = 'corner' | 'smooth';

export interface Anchor {
  point: Point2D;
  handleIn: Point2D;
  handleOut: Point2D;
  type: AnchorType;
}

export interface Subpath {
  closed: boolean;
  anchors: Anchor[];
}

/**
 * A vector node. Multiple subpaths express compound paths (shapes with
 * holes) — the receiver builds a CompoundPathItem in AI or a multi-region
 * vectorPaths in Figma.
 */
export interface VectorNode extends NodeBase {
  type: 'vector';
  subpaths: Subpath[];
  fills: BridgePaint[];
  strokes: BridgeStroke[];
  fillRule: 'nonzero' | 'evenodd';
}

// ───────────────────────────────────────────────────────────────────────────
// Text node
// ───────────────────────────────────────────────────────────────────────────

export type TextAlignH = 'left' | 'center' | 'right' | 'justify';
export type TextAlignV = 'top' | 'middle' | 'bottom';

export interface TextRun {
  start: number;
  end: number;
  fontFamily: string;
  postScriptName: string | null;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;
  letterSpacing: number;
  fills: BridgePaint[];
  /** Optional link to a TextStyleDef in the document library. */
  textStyleId?: BridgeId;
}

export interface TextParagraph {
  alignH: TextAlignH;
  lineHeight: number;
  runs: TextRun[];
  start: number;
  end: number;
}

export type TextAutoResize = 'none' | 'height' | 'widthAndHeight';

export interface TextNode extends NodeBase {
  type: 'text';
  characters: string;
  paragraphs: TextParagraph[];
  alignV: TextAlignV;
  autoResize: TextAutoResize;
}

// ───────────────────────────────────────────────────────────────────────────
// Image node
// ───────────────────────────────────────────────────────────────────────────

export interface ImageRef {
  hash: string;
  format: string;
  naturalSize: Size2D;
  byteLength: number;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  image: ImageRef;
  cropRect?: { x: number; y: number; width: number; height: number };
}

// ───────────────────────────────────────────────────────────────────────────
// Instance node (M5)
// ───────────────────────────────────────────────────────────────────────────

export type InstanceOverrideProperty =
  | 'text'
  | 'fills'
  | 'strokes'
  | 'effects'
  | 'visibility'
  | 'layout'
  | 'componentProperty'
  | 'unknown';

export type InstanceOverrideKind =
  | 'text'
  | 'fill'
  | 'visual'
  | 'layout'
  | 'componentProperty'
  | 'unknown';

export interface InstanceOverride {
  targetNodeId?: BridgeId;
  property: InstanceOverrideProperty;
  kind: InstanceOverrideKind;
  description?: string;
}

export interface InstanceNode extends NodeBase {
  type: 'instance';
  componentId: BridgeId;
  /**
   * M11.4 fallback payload. These children represent the expanded, already
   * overridden visual content of the Figma instance. The Illustrator renderer
   * uses them when preserving fidelity is safer than placing a rigid symbol.
   */
  children?: Node[];
  /**
   * M11.4: override metadata detected during Figma extraction. Illustrator
   * does not support per-instance text/fill overrides on SymbolItems, so
   * non-empty overrides make the renderer prefer a flattened group when
   * expanded children are available.
   */
  overrides?: InstanceOverride[];
}

// ───────────────────────────────────────────────────────────────────────────
// Group node (M6) — supports clipping masks
// ───────────────────────────────────────────────────────────────────────────

export interface GroupNode extends NodeBase {
  type: 'group';
  children: Node[];
  /**
   * Optional clip path. When set, children render only within this
   * shape's geometry. The clip path is positioned in the same local
   * coordinate space as the group's children.
   */
  clipPath?: VectorNode;
}

// ───────────────────────────────────────────────────────────────────────────
// Library definitions (M5)
// ───────────────────────────────────────────────────────────────────────────

export interface ComponentDef {
  id: BridgeId;
  name: string;
  size: Size2D;
  background: ColorRGBA | null;
  /**
   * M11: component definitions may contain nested instances.
   * The planner uses dependencies to create/update child symbols before
   * parent symbols.
   */
  children: Node[];
  /** Bridge component ids referenced by nested InstanceNode descendants. */
  dependencies?: BridgeId[];
  sourceMeta?: Record<string, unknown>;
}

export interface ColorStyleDef {
  id: BridgeId;
  name: string;
  paint: BridgePaint;
  sourceMeta?: Record<string, unknown>;
}

export interface TextStyleDef {
  id: BridgeId;
  name: string;
  fontFamily: string;
  postScriptName: string | null;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  alignH: TextAlignH;
  fillPaint: BridgePaint | null;
  sourceMeta?: Record<string, unknown>;
}

export interface BridgeLibrary {
  components: Record<BridgeId, ComponentDef>;
  colorStyles: Record<BridgeId, ColorStyleDef>;
  textStyles: Record<BridgeId, TextStyleDef>;
}

// ───────────────────────────────────────────────────────────────────────────
// Container & document root
// ───────────────────────────────────────────────────────────────────────────

export type Node =
  | VectorNode
  | TextNode
  | ImageNode
  | InstanceNode
  | GroupNode;

export interface Container {
  id: BridgeId;
  kind: 'artboard' | 'frame' | 'pasteboard';
  name: string;
  documentPosition: Point2D;
  size: Size2D;
  background: ColorRGBA | null;
  /** M6: respect frame-level clipping. */
  clipsContent: boolean;
  children: Node[];
  sourceMeta?: Record<string, unknown>;
}

export interface BridgeDocument {
  schemaVersion: string;
  sourceApp: 'illustrator' | 'figma';
  documentBounds: { position: Point2D; size: Size2D };
  containers: Container[];
  /** M5: reconciled BEFORE containers. Every entry has a stable bridgeId. */
  library: BridgeLibrary;
  assets: { images: Record<string, ImageRef> };
  generatedAt: string;
}
