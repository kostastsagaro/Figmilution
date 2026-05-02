/**
 * Coordinate normalization between Illustrator's Y-up document space and
 * the IR's Y-down container-local space.
 *
 * Established M2 (forward direction); M3 added the reverse-direction
 * helpers for the receiver path.
 *
 * AI native conventions:
 *   - artboardRect = [left, top, right, bottom] with top > bottom (Y-up)
 *   - geometricBounds same convention
 *
 * IR conventions: Y-down with origin at container top-left.
 */

export interface AiRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface IRRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function aiRectFromTuple(t: [number, number, number, number]): AiRect {
  const [left, top, right, bottom] = t;
  return { left, top, right, bottom };
}

export function aiRectWidth(r: AiRect): number {
  return r.right - r.left;
}

export function aiRectHeight(r: AiRect): number {
  return r.top - r.bottom;
}

export function aiRectCenter(r: AiRect): { x: number; y: number } {
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}

/**
 * Convert an item's AI document-space bbox to a local IR rect inside the
 * given artboard. Performs the X translation and the Y flip.
 */
export function aiBoundsToContainerLocal(itemBounds: AiRect, container: AiRect): IRRect {
  const width = aiRectWidth(itemBounds);
  const height = aiRectHeight(itemBounds);
  const x = itemBounds.left - container.left;
  const y = container.top - itemBounds.top;
  return { x, y, width, height };
}

export function aiPointToContainerLocal(
  ptX: number,
  ptY: number,
  container: AiRect
): { x: number; y: number } {
  return { x: ptX - container.left, y: container.top - ptY };
}

export function aiArtboardToCanvasSpace(
  artboard: AiRect,
  docOrigin: { left: number; top: number }
): IRRect {
  return {
    x: artboard.left - docOrigin.left,
    y: docOrigin.top - artboard.top,
    width: aiRectWidth(artboard),
    height: aiRectHeight(artboard),
  };
}

// ────────────────────────────────────────────────────────────────────────
// M3: Reverse direction (IR → AI)
// ────────────────────────────────────────────────────────────────────────

/**
 * Convert a Y-down IR point inside a container to AI document-space (Y-up).
 *
 * Inverse of aiPointToContainerLocal:
 *   Xd = Xlocal + container.left
 *   Yd = container.top - Ylocal
 */
export function irPointToAiDoc(
  localX: number,
  localY: number,
  container: AiRect
): { x: number; y: number } {
  return {
    x: localX + container.left,
    y: container.top - localY,
  };
}

export function irRectToAiTuple(
  rect: IRRect,
  container: AiRect
): [number, number, number, number] {
  const left = container.left + rect.x;
  const top = container.top - rect.y;
  const right = left + rect.width;
  const bottom = top - rect.height;
  return [left, top, right, bottom];
}

export function irCanvasRectToArtboardTuple(
  rect: IRRect,
  aiDocOrigin: { x: number; y: number }
): [number, number, number, number] {
  const left = aiDocOrigin.x + rect.x;
  const top = aiDocOrigin.y - rect.y;
  const right = left + rect.width;
  const bottom = top - rect.height;
  return [left, top, right, bottom];
}
