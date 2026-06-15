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
import { getTextLocalRect } from './text';

// ─── Primitive Types ─────────────────────────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Segment {
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

// ─── Coordinate Space Transformation Helpers ─────────────────────────────────

/**
 * Transforms a point from local coordinates to world coordinates.
 */
function localToWorld(p: Point, stroke: Stroke): Point {
  const ox = stroke.x ?? 0;
  const oy = stroke.y ?? 0;
  const scaleX = stroke.scaleX ?? 1;
  const scaleY = stroke.scaleY ?? 1;
  const rotation = stroke.rotation ?? 0;

  // 1. Scale relative to the local origin (0, 0)
  let lp = { x: p.x * scaleX, y: p.y * scaleY };
  // 2. Rotate around (0, 0)
  if (rotation !== 0) {
    lp = rotatePoint(lp, { x: 0, y: 0 }, rotation);
  }
  // 3. Translate
  return { x: lp.x + ox, y: lp.y + oy };
}

/**
 * Returns all vertices/points of a stroke in world coordinates.
 */
export function getStrokeWorldPoints(stroke: Stroke): Point[] {
  if (stroke.tool === 'rect') {
    const p1 = stroke.points[0];
    const p2 = stroke.points[1] || stroke.points[0];
    
    const w = Math.abs(p1.x - p2.x);
    const h = Math.abs(p1.y - p2.y);
    const localCorners = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
      { x: 0, y: 0 } // close the rectangle path
    ];
    
    const minX = Math.min(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const rx = stroke.x ?? minX;
    const ry = stroke.y ?? minY;
    
    const scaleX = stroke.scaleX ?? 1;
    const scaleY = stroke.scaleY ?? 1;
    const rotation = stroke.rotation ?? 0;
    
    return localCorners.map(lc => {
      let pt = { x: lc.x * scaleX, y: lc.y * scaleY };
      if (rotation !== 0) {
        pt = rotatePoint(pt, { x: 0, y: 0 }, rotation);
      }
      return { x: pt.x + rx, y: pt.y + ry };
    });
  } else if (stroke.tool === 'circle') {
    return [];
  } else {
    // pen, eraser, line
    return stroke.points.map(p => localToWorld(p, stroke));
  }
}

// ─── Distance Helpers ────────────────────────────────────────────────────────

/**
 * Calculate the minimum perpendicular distance from a point to a segment.
 */
function getDistanceToSegment(p: Point, s: Segment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const l2 = dx * dx + dy * dy;
  
  if (l2 === 0) {
    const diffX = p.x - s.x1;
    const diffY = p.y - s.y1;
    return Math.sqrt(diffX * diffX + diffY * diffY);
  }
  
  let t = ((p.x - s.x1) * dx + (p.y - s.y1) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  
  const projX = s.x1 + t * dx;
  const projY = s.y1 + t * dy;
  const diffX = p.x - projX;
  const diffY = p.y - projY;
  
  return Math.sqrt(diffX * diffX + diffY * diffY);
}

/**
 * Calculate the minimum distance between two line segments.
 */
function segmentsDistance(s1: Segment, s2: Segment): number {
  if (segmentsIntersect(s1, s2)) {
    return 0;
  }
  
  const p1 = { x: s1.x1, y: s1.y1 };
  const p2 = { x: s1.x2, y: s1.y2 };
  const q1 = { x: s2.x1, y: s2.y1 };
  const q2 = { x: s2.x2, y: s2.y2 };
  
  return Math.min(
    getDistanceToSegment(p1, s2),
    getDistanceToSegment(p2, s2),
    getDistanceToSegment(q1, s1),
    getDistanceToSegment(q2, s1)
  );
}

// ─── Per-Tool Intersection Tests ─────────────────────────────────────────────

/**
 * Test if a straight line (2-point stroke) intersects a selection rect.
 * Accounts for the stroke's transform (x, y offset and rotation).
 */
function lineIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  const worldPoints = getStrokeWorldPoints(stroke);
  if (worldPoints.length < 2) return false;
  
  const seg: Segment = {
    x1: worldPoints[0].x,
    y1: worldPoints[0].y,
    x2: worldPoints[1].x,
    y2: worldPoints[1].y
  };
  return segmentIntersectsOrInsideRect(seg, selectionRect);
}

/**
 * Test if a freedraw polyline (pen/eraser) intersects a selection rect.
 * Checks each consecutive pair of points as a line segment.
 */
function polylineIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  const worldPoints = getStrokeWorldPoints(stroke);
  if (worldPoints.length === 0) return false;

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
 */
function shapeRectIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length < 2) return false;
  const worldPoints = getStrokeWorldPoints(stroke);
  if (worldPoints.length < 4) return false;

  // Check if any corner of the shape rect is inside the selection rect
  if (worldPoints.some(c => pointInRect(c, selectionRect))) {
    return true;
  }

  // Check if any corner of the selection rect is inside the shape rect
  const selCorners: Point[] = [
    { x: selectionRect.x, y: selectionRect.y },
    { x: selectionRect.x + selectionRect.width, y: selectionRect.y },
    { x: selectionRect.x + selectionRect.width, y: selectionRect.y + selectionRect.height },
    { x: selectionRect.x, y: selectionRect.y + selectionRect.height },
  ];
  
  const p1 = stroke.points[0];
  const p2 = stroke.points[1] || stroke.points[0];
  const w = Math.abs(p1.x - p2.x);
  const h = Math.abs(p1.y - p2.y);
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const rx = stroke.x ?? minX;
  const ry = stroke.y ?? minY;
  const rotation = stroke.rotation ?? 0;
  
  const localRect: Rect = { x: 0, y: 0, width: w * (stroke.scaleX ?? 1), height: h * (stroke.scaleY ?? 1) };
  
  if (selCorners.some(c => {
    const pTranslated = { x: c.x - rx, y: c.y - ry };
    const pRotated = rotatePoint(pTranslated, { x: 0, y: 0 }, -rotation);
    return pointInRect(pRotated, localRect);
  })) {
    return true;
  }

  // Check edge-to-edge intersections
  const shapeEdges: Segment[] = [];
  for (let i = 0; i < 4; i++) {
    shapeEdges.push({
      x1: worldPoints[i].x, y1: worldPoints[i].y,
      x2: worldPoints[i+1].x, y2: worldPoints[i+1].y,
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

function getTextWorldCorners(stroke: Stroke): Point[] {
  const origin = stroke.points[0] ?? { x: 0, y: 0 };
  const x = stroke.x ?? origin.x;
  const y = stroke.y ?? origin.y;
  const scaleX = stroke.scaleX ?? 1;
  const scaleY = stroke.scaleY ?? 1;
  const rotation = stroke.rotation ?? 0;
  const { width, height } = getTextLocalRect(stroke);

  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ].map((point) => {
    const scaled = { x: point.x * scaleX, y: point.y * scaleY };
    const rotated = rotation === 0 ? scaled : rotatePoint(scaled, { x: 0, y: 0 }, rotation);
    return { x: rotated.x + x, y: rotated.y + y };
  });
}

function textIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  const corners = getTextWorldCorners(stroke);
  if (corners.some((corner) => pointInRect(corner, selectionRect))) return true;
  const edges = corners.map((corner, index) => {
    const next = corners[(index + 1) % corners.length];
    return { x1: corner.x, y1: corner.y, x2: next.x, y2: next.y };
  });
  return edges.some((edge) => segmentIntersectsOrInsideRect(edge, selectionRect));
}

/**
 * Test if a circle shape intersects a selection rect.
 */
function circleIntersectsRect(stroke: Stroke, selectionRect: Rect): boolean {
  if (stroke.points.length < 2) return false;

  const p1 = stroke.points[0];
  const p2 = stroke.points[1] || stroke.points[0];
  const scaleX = stroke.scaleX ?? 1;
  const scaleY = stroke.scaleY ?? 1;
  const cx = stroke.x ?? p1.x;
  const cy = stroke.y ?? p1.y;
  const radius = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)) * Math.max(Math.abs(scaleX), Math.abs(scaleY));

  const closestX = Math.max(selectionRect.x, Math.min(cx, selectionRect.x + selectionRect.width));
  const closestY = Math.max(selectionRect.y, Math.min(cy, selectionRect.y + selectionRect.height));

  const distX = cx - closestX;
  const distY = cy - closestY;
  const distSq = distX * distX + distY * distY;

  return distSq <= radius * radius;
}

/**
 * Test if a stroke intersects with the eraser path segment within the eraser's radius.
 */
export function strokeIntersectsEraser(stroke: Stroke, eraserSeg: Segment, eraserRadius: number): boolean {
  const strokeAABB = getStrokeAABB(stroke);
  
  const eraserMinX = Math.min(eraserSeg.x1, eraserSeg.x2) - eraserRadius;
  const eraserMaxX = Math.max(eraserSeg.x1, eraserSeg.x2) + eraserRadius;
  const eraserMinY = Math.min(eraserSeg.y1, eraserSeg.y2) - eraserRadius;
  const eraserMaxY = Math.max(eraserSeg.y1, eraserSeg.y2) + eraserRadius;
  
  const aabbOverlap = !(
    strokeAABB.x > eraserMaxX ||
    strokeAABB.x + strokeAABB.width < eraserMinX ||
    strokeAABB.y > eraserMaxY ||
    strokeAABB.y + strokeAABB.height < eraserMinY
  );
  
  if (!aabbOverlap) return false;
  
  const threshold = (stroke.strokeWidth / 2) + eraserRadius;

  switch (stroke.tool) {
    case 'pen':
    case 'eraser': {
      const worldPoints = getStrokeWorldPoints(stroke);
      if (worldPoints.length === 0) return false;
      if (worldPoints.length === 1) {
        return getDistanceToSegment(worldPoints[0], eraserSeg) <= threshold;
      }
      for (let i = 0; i < worldPoints.length - 1; i++) {
        const seg: Segment = {
          x1: worldPoints[i].x,
          y1: worldPoints[i].y,
          x2: worldPoints[i+1].x,
          y2: worldPoints[i+1].y
        };
        if (segmentsDistance(seg, eraserSeg) <= threshold) {
          return true;
        }
      }
      return false;
    }
    case 'line': {
      const worldPoints = getStrokeWorldPoints(stroke);
      if (worldPoints.length < 2) return false;
      const seg: Segment = {
        x1: worldPoints[0].x,
        y1: worldPoints[0].y,
        x2: worldPoints[1].x,
        y2: worldPoints[1].y
      };
      return segmentsDistance(seg, eraserSeg) <= threshold;
    }
    case 'rect': {
      const worldPoints = getStrokeWorldPoints(stroke);
      if (worldPoints.length < 4) return false;
      for (let i = 0; i < worldPoints.length - 1; i++) {
        const seg: Segment = {
          x1: worldPoints[i].x,
          y1: worldPoints[i].y,
          x2: worldPoints[i+1].x,
          y2: worldPoints[i+1].y
        };
        if (segmentsDistance(seg, eraserSeg) <= threshold) {
          return true;
        }
      }
      
      const p1 = stroke.points[0];
      const p2 = stroke.points[1] || stroke.points[0];
      const w = Math.abs(p1.x - p2.x);
      const h = Math.abs(p1.y - p2.y);
      const minX = Math.min(p1.x, p2.x);
      const minY = Math.min(p1.y, p2.y);
      const rx = stroke.x ?? minX;
      const ry = stroke.y ?? minY;
      const rotation = stroke.rotation ?? 0;
      
      const rect: Rect = { x: 0, y: 0, width: w * (stroke.scaleX ?? 1), height: h * (stroke.scaleY ?? 1) };
      
      const testPoint = { x: eraserSeg.x2, y: eraserSeg.y2 };
      const pTranslated = { x: testPoint.x - rx, y: testPoint.y - ry };
      const pRotated = rotatePoint(pTranslated, { x: 0, y: 0 }, -rotation);
      
      if (pointInRect(pRotated, rect)) {
        return true;
      }
      return false;
    }
    case 'circle': {
      if (stroke.points.length < 2) return false;
      const p1 = stroke.points[0];
      const p2 = stroke.points[1] || stroke.points[0];
      const scaleX = stroke.scaleX ?? 1;
      const scaleY = stroke.scaleY ?? 1;
      const cx = stroke.x ?? p1.x;
      const cy = stroke.y ?? p1.y;
      const radius = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)) * Math.max(Math.abs(scaleX), Math.abs(scaleY));
      
      const dist = getDistanceToSegment({ x: cx, y: cy }, eraserSeg);
      return dist <= radius + threshold;
    }
    case 'text': {
      const corners = getTextWorldCorners(stroke);
      const edges = corners.map((corner, index) => {
        const next = corners[(index + 1) % corners.length];
        return { x1: corner.x, y1: corner.y, x2: next.x, y2: next.y };
      });
      if (edges.some((edge) => segmentsDistance(edge, eraserSeg) <= threshold)) return true;

      const end = { x: eraserSeg.x2, y: eraserSeg.y2 };
      let intersections = 0;
      const ray = { x1: end.x, y1: end.y, x2: end.x + 1e9, y2: end.y };
      edges.forEach((edge) => { if (segmentsIntersect(ray, edge)) intersections++; });
      return intersections % 2 === 1;
    }
    default:
      return false;
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Precise intersection test between a stroke and a selection rectangle.
 * Dispatches to the appropriate per-tool geometric test.
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
    case 'text':
      return textIntersectsRect(stroke, selectionRect);
    default:
      return true;
  }
}

/**
 * Calculate the bounding box of a stroke in world coordinates.
 */
export function getStrokeAABB(stroke: Stroke): Rect {
  if (stroke.points.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  const ox = stroke.x ?? 0;
  const oy = stroke.y ?? 0;
  const rotation = stroke.rotation ?? 0;
  const scaleX = stroke.scaleX ?? 1;
  const scaleY = stroke.scaleY ?? 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  if (stroke.tool === 'text') {
    getTextWorldCorners(stroke).forEach((point) => {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    });
  } else if (stroke.tool === 'rect') {
    const p1 = stroke.points[0];
    const p2 = stroke.points[1] || stroke.points[0];
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p1.x - p2.x);
    const h = Math.abs(p1.y - p2.y);

    const corners = [
      { x: x, y: y },
      { x: x + w, y: y },
      { x: x + w, y: y + h },
      { x: x, y: y + h }
    ];

    const center = { x: x + w / 2, y: y + h / 2 };

    corners.forEach(c => {
      let pt = { x: c.x * scaleX + ox, y: c.y * scaleY + oy };
      if (rotation !== 0) {
        pt = rotatePoint(pt, center, rotation);
      }
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    });
  } else if (stroke.tool === 'circle') {
    const p1 = stroke.points[0];
    const p2 = stroke.points[1] || stroke.points[0];
    const cx = stroke.x ?? p1.x;
    const cy = stroke.y ?? p1.y;
    const radius = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)) * Math.max(Math.abs(scaleX), Math.abs(scaleY));

    minX = cx - radius;
    maxX = cx + radius;
    minY = cy - radius;
    maxY = cy + radius;
  } else {
    // pen, eraser, line
    const center = { x: ox, y: oy };
    stroke.points.forEach(p => {
      let pt = { x: p.x * scaleX + ox, y: p.y * scaleY + oy };
      if (rotation !== 0) {
        pt = rotatePoint(pt, center, rotation);
      }
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    });
  }

  const padding = stroke.tool === 'text' ? 0 : (stroke.strokeWidth ?? 3) / 2;
  return {
    x: minX - padding,
    y: minY - padding,
    width: (maxX - minX) + (stroke.strokeWidth ?? 3),
    height: (maxY - minY) + (stroke.strokeWidth ?? 3)
  };
}
