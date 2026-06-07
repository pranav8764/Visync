/**
 * Viewport & Coordinate Transform Utilities for Infinite Canvas
 *
 * The Visync canvas uses a "world coordinate" system where shapes are stored
 * in unbounded pixel coordinates (e.g., {x: 350, y: 720}). The viewport
 * defines what portion of the world is visible on screen.
 *
 * Coordinate spaces:
 *   - World:  Infinite 2D plane where all shapes live.
 *   - Screen: Browser pixel coordinates (0,0 = top-left of canvas element).
 *
 * The viewport transform is:
 *   screenX = (worldX - viewport.offsetX) * viewport.scale
 *   screenY = (worldY - viewport.offsetY) * viewport.scale
 *
 * Designed for future minimap, collaborative cursor tracking, and
 * multiplayer synchronization without additional coordinate-system refactoring.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Viewport state describing which portion of the infinite world is visible.
 *
 * offsetX/Y: The world coordinate at the top-left corner of the screen.
 * scale:     Zoom factor (1 = 100%, 2 = 200%, 0.5 = 50%).
 */
export interface Viewport {
  offsetX: number;
  offsetY: number;
  scale: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum allowed zoom level */
export const MIN_ZOOM = 0.05;

/** Maximum allowed zoom level */
export const MAX_ZOOM = 20;

/** Default zoom level (100%) */
export const DEFAULT_ZOOM = 1;

/** Zoom speed multiplier per wheel tick */
export const ZOOM_SPEED = 1.08;

// ---------------------------------------------------------------------------
// Coordinate Transformations
// ---------------------------------------------------------------------------

/**
 * Convert world coordinates to screen (pixel) coordinates.
 *
 * @param wx - World X coordinate
 * @param wy - World Y coordinate
 * @param viewport - Current viewport state
 * @returns Screen coordinates {x, y}
 */
export function worldToScreen(
  wx: number,
  wy: number,
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: (wx - viewport.offsetX) * viewport.scale,
    y: (wy - viewport.offsetY) * viewport.scale,
  };
}

/**
 * Convert screen (pixel) coordinates to world coordinates.
 *
 * @param sx - Screen X coordinate (browser pixel)
 * @param sy - Screen Y coordinate (browser pixel)
 * @param viewport - Current viewport state
 * @returns World coordinates {x, y}
 */
export function screenToWorld(
  sx: number,
  sy: number,
  viewport: Viewport
): { x: number; y: number } {
  return {
    x: sx / viewport.scale + viewport.offsetX,
    y: sy / viewport.scale + viewport.offsetY,
  };
}

// ---------------------------------------------------------------------------
// Zoom Utilities
// ---------------------------------------------------------------------------

/**
 * Compute a new viewport that zooms toward (or away from) a specific
 * screen point, keeping that point fixed on-screen. This produces the
 * natural "zoom toward cursor" behavior.
 *
 * @param viewport  - Current viewport state
 * @param screenX   - Screen X of the zoom focus (e.g., mouse pointer)
 * @param screenY   - Screen Y of the zoom focus
 * @param newScale  - Desired new scale (will be clamped to [MIN_ZOOM, MAX_ZOOM])
 * @returns New viewport with updated scale and offsets
 */
export function zoomAtPoint(
  viewport: Viewport,
  screenX: number,
  screenY: number,
  newScale: number
): Viewport {
  const clampedScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newScale));

  // World point under the cursor before zoom
  const worldX = screenX / viewport.scale + viewport.offsetX;
  const worldY = screenY / viewport.scale + viewport.offsetY;

  // Adjust offset so the same world point remains under the cursor
  const newOffsetX = worldX - screenX / clampedScale;
  const newOffsetY = worldY - screenY / clampedScale;

  return {
    offsetX: newOffsetX,
    offsetY: newOffsetY,
    scale: clampedScale,
  };
}

// ---------------------------------------------------------------------------
// Viewport Helpers
// ---------------------------------------------------------------------------

/**
 * Get the visible world-coordinate bounding rectangle for the current viewport.
 * Useful for grid rendering and future viewport-based culling.
 *
 * @param viewport     - Current viewport state
 * @param screenWidth  - Canvas element width in pixels
 * @param screenHeight - Canvas element height in pixels
 * @returns Bounding rect {x, y, width, height} in world coordinates
 */
export function getVisibleWorldRect(
  viewport: Viewport,
  screenWidth: number,
  screenHeight: number
): { x: number; y: number; width: number; height: number } {
  const topLeft = screenToWorld(0, 0, viewport);
  const bottomRight = screenToWorld(screenWidth, screenHeight, viewport);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: bottomRight.x - topLeft.x,
    height: bottomRight.y - topLeft.y,
  };
}

/**
 * Create the default viewport centered on the world origin.
 *
 * @param screenWidth  - Canvas width in pixels
 * @param screenHeight - Canvas height in pixels
 * @returns Viewport centered so (0,0) world is at center of screen
 */
export function createDefaultViewport(
  screenWidth: number,
  screenHeight: number
): Viewport {
  return {
    offsetX: -screenWidth / 2,
    offsetY: -screenHeight / 2,
    scale: DEFAULT_ZOOM,
  };
}
