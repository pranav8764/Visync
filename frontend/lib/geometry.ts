/**
 * geometry.ts — Precise geometric intersection utilities for selection.
 *
 * Inspired by Excalidraw's two-stage hit-testing approach:
 *   Stage 1 (AABB): Fast bounding-box rejection (done in CanvasBoard via Konva's getClientRect).
 *   Stage 2 (Precise): Per-tool geometric intersection (this file).
 *
 * All functions operate in world coordinates.
 */

import { Point, Stroke } from './useStore';

// ─── Primitive Types ─────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ─── Core Helpers ────────────────────────────────────────────────────────────

/**
 * Rotate a point around a center by an angle (in degrees).
 * Uses the inverse-rotation trick from Excalidraw: instead of rotating the
 * shape, we rotate the test geometry in the opposite direction.
 */
function rotatePoint(p: Point, center: Point, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

/**
 * Check if two 1D ranges [a1, a2] and [b1, b2] overlap.
 */
function rangesOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.max(a1, b1) <= Math.min(a2, b2);
}

/**
 * Convert a Rect into its 4 edge segments.
 */
function rectToSegments(r: Rect): Segment[] {
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return [
    { x1: r.x, y1: r.y, x2: x2, y2: r.y },   // top
    { x1: x2, y1: r.y, x2: x2, y2: y2 },      // right
    { x1: x2, y1: y2, x2: r.x, y2: y2 },      // bottom
    { x1: r.x, y1: y2, x2: r.x, y2: r.y },    // left
  ];
}

/**
 * Test if two line segments (p1→p2) and (p3→p4) intersect.
 * Uses the cross-product orientation test.
 */
function segmentsIntersect(s1: Segment, s2: Segment): boolean {
  const d1 = direction(s2.x1, s2.y1, s2.x2, s2.y2, s1.x1, s1.y1);
  const d2 = direction(s2.x1, s2.y1, s2.x2, s2.y2, s1.x2, s1.y2);
  const d3 = direction(s1.x1, s1.y1, s1.x2, s1.y2, s2.x1, s2.y1);
  const d4 = direction(s1.x1, s1.y1, s1.x2, s1.y2, s2.x2, s2.y2);

  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }

  if (d1 === 0 && onSegment(s2, s1.x1, s1.y1)) return true;
  if (d2 === 0 && onSegment(s2, s1.x2, s1.y2)) return true;
  if (d3 === 0 && onSegment(s1, s2.x1, s2.y1)) return true;
  if (d4 === 0 && onSegment(s1, s2.x2, s2.y2)) return true;

  return false;
}

function direction(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(seg: Segment, px: number, py: number): boolean {
  return (
    Math.min(seg.x1, seg.x2) <= px && px <= Math.max(seg.x1, seg.x2) &&
    Math.min(seg.y1, seg.y2) <= py && py <= Math.max(seg.y1, seg.y2)
  );
}

/**
 * Check if a point is inside a rect.
 */
function pointInRect(p: Point, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
}

/**
 * Check if a line segment is fully contained inside a rect.
 */
function segmentInsideRect(s: Segment, r: Rect): boolean {
  return pointInRect({ x: s.x1, y: s.y1 }, r) && pointInRect({ x: s.x2, y: s.y2 }, r);
}

/**
 * Check if a line segment intersects OR is inside a rect.
 */
function segmentIntersectsOrInsideRect(seg: Segment, rect: Rect): boolean {
  // If either endpoint is inside the rect, they intersect
  if (pointInRect({ x: seg.x1, y: seg.y1 }, rect) || pointInRect({ x: seg.x2, y: seg.y2 }, rect)) {
    return true;
  }
  // Check if the segment crosses any of the rect's 4 edges
  const edges = rectToSegments(rect);
  return edges.some(edge => segmentsIntersect(seg, edge));
}

// ─── Per-Tool Intersection Tests ─────────────────────────────────────────────

/**
 * Test if a straight line (2-point stroke) intersects a selection rect.
 * Accounts for the stroke's transform (x, y offset and rotation).
 */
function lineIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length < 2) return false;

  const p1 = stroke.points[0];
  const p2 = stroke.points[1];
  const ox = stroke.x ?? 0;
  const oy = stroke.y ?? 0;
  const rotation = stroke.rotation ?? 0;

  let a: Point = { x: p1.x + ox, y: p1.y + oy };
  let b: Point = { x: p2.x + ox, y: p2.y + oy };

  // Apply rotation around the shape's offset origin
  if (rotation !== 0) {
    const center: Point = { x: ox, y: oy };
    a = rotatePoint(a, center, rotation);
    b = rotatePoint(b, center, rotation);
  }

  const seg: Segment = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  return segmentIntersectsOrInsideRect(seg, selectionRect);
}

/**
 * Test if a freedraw polyline (pen/eraser) intersects a selection rect.
 * Checks each consecutive pair of points as a line segment.
 */
function polylineIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length === 0) return false;

  const ox = stroke.x ?? 0;
  const oy = stroke.y ?? 0;
  const rotation = stroke.rotation ?? 0;
  const center: Point = { x: ox, y: oy };

  // Transform all points to world space
  const worldPoints = stroke.points.map(p => {
    let wp: Point = { x: p.x + ox, y: p.y + oy };
    if (rotation !== 0) {
      wp = rotatePoint(wp, center, rotation);
    }
    return wp;
  });

  // If only 1 point, check if it's inside the rect
  if (worldPoints.length === 1) {
    return pointInRect(worldPoints[0], selectionRect);
  }

  // Check each segment of the polyline
  for (let i = 0; i < worldPoints.length - 1; i++) {
    const seg: Segment = {
      x1: worldPoints[i].x,
      y1: worldPoints[i].y,
      x2: worldPoints[i + 1].x,
      y2: worldPoints[i + 1].y,
    };
    if (segmentIntersectsOrInsideRect(seg, selectionRect)) {
      return true;
    }
  }
  return false;
}

/**
 * Test if a rectangle shape intersects a selection rect.
 * Accounts for rotation by rotating the rect's 4 corners and checking
 * each edge against the selection rect.
 */
function shapeRectIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length < 2) return false;

  const p1 = stroke.points[0];
  const p2 = stroke.points[1];
  const sx = stroke.x ?? Math.min(p1.x, p2.x);
  const sy = stroke.y ?? Math.min(p1.y, p2.y);
  const w = Math.abs(p1.x - p2.x);
  const h = Math.abs(p1.y - p2.y);
  const rotation = stroke.rotation ?? 0;

  // The 4 corners of the shape rect in local space
  let corners: Point[] = [
    { x: sx, y: sy },
    { x: sx + w, y: sy },
    { x: sx + w, y: sy + h },
    { x: sx, y: sy + h },
  ];

  // If rotated, rotate corners around the shape's position
  if (rotation !== 0) {
    const center: Point = { x: sx + w / 2, y: sy + h / 2 };
    corners = corners.map(c => rotatePoint(c, center, rotation));
  }

  // Check if any corner of the shape rect is inside the selection rect
  if (corners.some(c => pointInRect(c, selectionRect))) {
    return true;
  }

  // Check if any corner of the selection rect is inside the shape rect
  // (handles case where selection is fully inside the shape)
  const selCorners: Point[] = [
    { x: selectionRect.x, y: selectionRect.y },
    { x: selectionRect.x + selectionRect.width, y: selectionRect.y },
    { x: selectionRect.x + selectionRect.width, y: selectionRect.y + selectionRect.height },
    { x: selectionRect.x, y: selectionRect.y + selectionRect.height },
  ];
  if (rotation === 0) {
    const shapeRect: Rect = { x: sx, y: sy, width: w, height: h };
    if (selCorners.some(c => pointInRect(c, shapeRect))) {
      return true;
    }
  }

  // Check edge-to-edge intersections
  const shapeEdges: Segment[] = [];
  for (let i = 0; i < 4; i++) {
    const next = (i + 1) % 4;
    shapeEdges.push({
      x1: corners[i].x, y1: corners[i].y,
      x2: corners[next].x, y2: corners[next].y,
    });
  }
  const selEdges = rectToSegments(selectionRect);

  for (const se of shapeEdges) {
    for (const re of selEdges) {
      if (segmentsIntersect(se, re)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Test if a circle shape intersects a selection rect.
 * Uses the closest-point-on-rect-to-circle-center algorithm.
 */
function circleIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length < 2) return false;

  const p1 = stroke.points[0];
  const p2 = stroke.points[1];
  const cx = stroke.x ?? p1.x;
  const cy = stroke.y ?? p1.y;
  const radius = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));

  // Find the closest point on the selection rect to the circle center
  const closestX = Math.max(selectionRect.x, Math.min(cx, selectionRect.x + selectionRect.width));
  const closestY = Math.max(selectionRect.y, Math.min(cy, selectionRect.y + selectionRect.height));

  const distX = cx - closestX;
  const distY = cy - closestY;
  const distSq = distX * distX + distY * distY;

  // The circle intersects the rect if the closest point is within the radius
  // (or the center is inside the rect, which distSq=0 handles)
  return distSq <= radius * radius;
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Precise intersection test between a stroke and a selection rectangle.
 * Dispatches to the appropriate per-tool geometric test.
 *
 * This is Stage 2 of the two-stage selection pipeline.
 * Stage 1 (AABB via Konva's getClientRect) should run first for performance.
 */
export function strokeIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  switch (stroke.tool) {
    case 'pen':
    case 'eraser':
      return polylineIntersectsRect(stroke, selectionRect);
    case 'line':
      return lineIntersectsRect(stroke, selectionRect);
    case 'rect':
      return shapeRectIntersectsRect(stroke, selectionRect);
    case 'circle':
      return circleIntersectsRect(stroke, selectionRect);
    default:
      // Unknown tool — fall back to "always select" (AABB already passed)
      return true;
  }
}
