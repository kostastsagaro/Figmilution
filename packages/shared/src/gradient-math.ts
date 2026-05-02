import type { Point2D } from './bridge-schema';

/**
 * 2x3 affine matrix in row-major form: [[a, b, tx], [c, d, ty]].
 * Maps point (x, y) → (a*x + b*y + tx, c*x + d*y + ty).
 *
 * Matches Figma's gradientTransform layout.
 */
export type Affine2x3 = [[number, number, number], [number, number, number]];

export function applyAffine(m: Affine2x3, p: Point2D): Point2D {
  return {
    x: m[0][0] * p.x + m[0][1] * p.y + m[0][2],
    y: m[1][0] * p.x + m[1][1] * p.y + m[1][2],
  };
}

export function figmaLinearTransformToUnitEndpoints(
  transform: Affine2x3
): { startUnit: Point2D; endUnit: Point2D } {
  return {
    startUnit: applyAffine(transform, { x: 0, y: 0 }),
    endUnit: applyAffine(transform, { x: 1, y: 0 }),
  };
}

export function figmaRadialTransformToUnitEndpoints(
  transform: Affine2x3
): { centerUnit: Point2D; radiusEndUnit: Point2D } {
  return {
    centerUnit: applyAffine(transform, { x: 0, y: 0 }),
    radiusEndUnit: applyAffine(transform, { x: 1, y: 0 }),
  };
}

export function unitEndpointsToFigmaLinearTransform(
  startUnit: Point2D,
  endUnit: Point2D
): Affine2x3 {
  const dx = endUnit.x - startUnit.x;
  const dy = endUnit.y - startUnit.y;
  return [
    [dx, -dy, startUnit.x],
    [dy,  dx, startUnit.y],
  ];
}

export function unitEndpointsToFigmaRadialTransform(
  centerUnit: Point2D,
  radiusEndUnit: Point2D
): Affine2x3 {
  const dx = radiusEndUnit.x - centerUnit.x;
  const dy = radiusEndUnit.y - centerUnit.y;
  return [
    [dx, -dy, centerUnit.x],
    [dy,  dx, centerUnit.y],
  ];
}

/**
 * Convert IR unit-space endpoints + node geometry into container-local
 * point space. Caller finishes the conversion to AI doc coords using
 * irPointToAiDoc (which lives in ai-plugin/coords.ts).
 */
export function unitEndpointsToContainerLocal(
  startUnit: Point2D,
  endUnit: Point2D,
  nodePosition: Point2D,
  nodeSize: { width: number; height: number }
): { startContainer: Point2D; endContainer: Point2D } {
  return {
    startContainer: {
      x: nodePosition.x + startUnit.x * nodeSize.width,
      y: nodePosition.y + startUnit.y * nodeSize.height,
    },
    endContainer: {
      x: nodePosition.x + endUnit.x * nodeSize.width,
      y: nodePosition.y + endUnit.y * nodeSize.height,
    },
  };
}

export function nodeLocalEndpointsToUnit(
  start: Point2D,
  end: Point2D,
  nodeSize: { width: number; height: number }
): { startUnit: Point2D; endUnit: Point2D } {
  const w = nodeSize.width || 1;
  const h = nodeSize.height || 1;
  return {
    startUnit: { x: start.x / w, y: start.y / h },
    endUnit: { x: end.x / w, y: end.y / h },
  };
}

/**
 * Test whether a Figma radial gradient is approximately circular by
 * checking that the (1,0) and (0,1) transformed points are equidistant
 * from (0,0). 5% mismatch tolerance.
 */
export function isFigmaRadialApproximatelyCircular(
  transform: Affine2x3,
  tolerance = 0.05
): boolean {
  const center = applyAffine(transform, { x: 0, y: 0 });
  const xAxis = applyAffine(transform, { x: 1, y: 0 });
  const yAxis = applyAffine(transform, { x: 0, y: 1 });
  const xLen = Math.hypot(xAxis.x - center.x, xAxis.y - center.y);
  const yLen = Math.hypot(yAxis.x - center.x, yAxis.y - center.y);
  if (xLen === 0 || yLen === 0) return true;
  const ratio = Math.min(xLen, yLen) / Math.max(xLen, yLen);
  return ratio >= 1 - tolerance;
}
