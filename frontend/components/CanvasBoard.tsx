'use client';

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Stage, Layer, Line as KonvaLine, Rect as KonvaRect, Circle as KonvaCircle, Transformer } from 'react-konva';
import Konva from 'konva';
import axios from 'axios';
import { useStore, Stroke, Point } from '@/lib/useStore';
import { WebSocketClient } from '@/lib/ws';
import { strokeIntersectsRect, getStrokeAABB, strokeIntersectsEraser, Segment } from '@/lib/geometry';
import {
  Viewport,
  worldToScreen,
  screenToWorld,
  zoomAtPoint,
  getVisibleWorldRect,
  createDefaultViewport,
  ZOOM_SPEED,
  MIN_ZOOM,
  MAX_ZOOM,
} from '@/lib/viewport';

// ---------------------------------------------------------------------------
// Legacy data migration constant — old data used normalized 0–1 coords
// relative to this virtual size. We detect & upscale on load.
// ---------------------------------------------------------------------------
const LEGACY_VIRTUAL_WIDTH = 1920;
const LEGACY_VIRTUAL_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// Ramer-Douglas-Peucker (RDP) Path Simplification
// ---------------------------------------------------------------------------
function getSqSegDist(p: Point, p1: Point, p2: Point) {
  let x = p1.x, y = p1.y;
  let dx = p2.x - x, dy = p2.y - y;
  if (dx !== 0 || dy !== 0) {
    let t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2.x; y = p2.y;
    } else if (t > 0) {
      x += dx * t; y += dy * t;
    }
  }
  dx = p.x - x; dy = p.y - y;
  return dx * dx + dy * dy;
}

function simplifyDPStep(points: Point[], first: number, last: number, sqTolerance: number, simplified: Point[]) {
  let maxSqDist = sqTolerance;
  let index = -1;
  for (let i = first + 1; i < last; i++) {
    const sqDist = getSqSegDist(points[i], points[first], points[last]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }
  if (maxSqDist > sqTolerance) {
    if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
    simplified.push(points[index]);
    if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
  }
}

/**
 * Simplify a path using the Ramer-Douglas-Peucker algorithm.
 * Tolerance is now in world-coordinate pixels (not normalized 0–1).
 */
function simplifyPath(points: Point[], tolerance = 1): Point[] {
  if (points.length <= 2) return points;
  const sqTolerance = tolerance * tolerance;
  const simplified: Point[] = [points[0]];
  simplifyDPStep(points, 0, points.length - 1, sqTolerance, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

// ---------------------------------------------------------------------------
// Legacy coordinate detection & migration
// ---------------------------------------------------------------------------

/**
 * Detect if a set of strokes uses the legacy normalized (0–1) coordinate format
 * and convert them to world coordinates if so.
 *
 * Heuristic: if ALL points in ALL strokes have x,y in [0, 1], they are legacy.
 */
function migrateStrokesIfLegacy(strokes: Stroke[]): Stroke[] {
  if (strokes.length === 0) return strokes;

  const allPointsNormalized = strokes.every((s) =>
    s.points.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1)
  );

  if (!allPointsNormalized) return strokes; // Already world coords

  // Scale up from 0–1 normalized → world pixel coordinates
  return strokes.map((s) => ({
    ...s,
    points: s.points.map((p) => ({
      x: p.x * LEGACY_VIRTUAL_WIDTH,
      y: p.y * LEGACY_VIRTUAL_HEIGHT,
    })),
  }));
}

// ---------------------------------------------------------------------------
// Grid rendering helpers
// ---------------------------------------------------------------------------

/**
 * Calculate adaptive grid spacing that looks good at any zoom level.
 * Returns the grid cell size in world coordinates.
 */
function getAdaptiveGridSpacing(scale: number): { major: number; minor: number } {
  // Target ~40-80 screen pixels between minor grid lines
  const targetScreenSpacing = 50;
  const rawWorldSpacing = targetScreenSpacing / scale;

  // Snap to a "nice" power-of-ten-based spacing
  const log = Math.log10(rawWorldSpacing);
  const pow = Math.floor(log);
  const frac = log - pow;

  let nice: number;
  if (frac < 0.15) nice = Math.pow(10, pow);
  else if (frac < 0.5) nice = 2 * Math.pow(10, pow);
  else if (frac < 0.85) nice = 5 * Math.pow(10, pow);
  else nice = Math.pow(10, pow + 1);

  return {
    minor: nice,
    major: nice * 5,
  };
}

// ---------------------------------------------------------------------------
// Reusable Tool Button Component
// ---------------------------------------------------------------------------
const ToolButton = ({
  isActive,
  onClick,
  title,
  children
}: {
  isActive: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) => (
  <button
    onClick={onClick}
    title={title}
    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${isActive
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105'
        : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
      }`}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function CanvasBoard({ roomId, userId }: { roomId: string; userId: string }) {
  const stageRef = useRef<Konva.Stage>(null);

  // ---- Zustand selections (fine-grained selectors) ----
  const activeTool = useStore((state) => state.activeTool);
  const isDarkMode = useStore((state) => state.isDarkMode);
  const toggleDarkMode = useStore((state) => state.toggleDarkMode);
  const color = useStore((state) => state.color);
  const strokeWidth = useStore((state) => state.strokeWidth);
  const username = useStore((state) => state.username);
  const roomName = useStore((state) => state.roomName);
  const strokes = useStore((state) => state.strokes);
  const undoStack = useStore((state) => state.undoStack);
  const redoStack = useStore((state) => state.redoStack);
  const viewport = useStore((state) => state.viewport);
  const showGrid = useStore((state) => state.showGrid);
  const selectedIds = useStore((state) => state.selectedIds);
  const setSelectedIds = useStore((state) => state.setSelectedIds);
  const updateStrokeTransform = useStore((state) => state.updateStrokeTransform);

  const setRoomName = useStore((state) => state.setRoomName);
  const setActiveTool = useStore((state) => state.setActiveTool);
  const setColor = useStore((state) => state.setColor);
  const setStrokeWidth = useStore((state) => state.setStrokeWidth);
  const setStrokes = useStore((state) => state.setStrokes);
  const addStroke = useStore((state) => state.addStroke);
  const updateLastStrokePoints = useStore((state) => state.updateLastStrokePoints);
  const setUsername = useStore((state) => state.setUsername);
  const clearStrokes = useStore((state) => state.clearStrokes);
  const pushToUndo = useStore((state) => state.pushToUndo);
  const popFromUndo = useStore((state) => state.popFromUndo);
  const pushToRedo = useStore((state) => state.pushToRedo);
  const popFromRedo = useStore((state) => state.popFromRedo);
  const clearUndoRedo = useStore((state) => state.clearUndoRedo);
  const addMessage = useStore((state) => state.addMessage);
  const setMessages = useStore((state) => state.setMessages);
  const setViewport = useStore((state) => state.setViewport);
  const toggleGrid = useStore((state) => state.toggleGrid);

  // ---- Local component states ----
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [isDrawing, setIsDrawing] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isToolbarOpen, setIsToolbarOpen] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [wsToken, setWsToken] = useState<string | null>(null);

  // User identity state
  const [isEditingName, setIsEditingName] = useState(false);
  const [tempName, setTempName] = useState(username || '');

  // Selection Box State
  const [selectionBox, setSelectionBox] = useState<{ x: number, y: number, width: number, height: number, visible: boolean } | null>(null);
  const [groupDragRect, setGroupDragRect] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const selectionStartRef = useRef<Point | null>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const drawingLayerRef = useRef<Konva.Layer>(null);
  const dragStartOffsetRef = useRef<{ [id: string]: { x: number, y: number } }>({});
  // Pan state tracking
  const [isPanMode, setIsPanMode] = useState(false);       // Explicit pan tool selected
  const [isSpacePanning, setIsSpacePanning] = useState(false); // Space key held
  const [isMiddlePanning, setIsMiddlePanning] = useState(false); // Middle mouse button held

  // Responsive dropdown states
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isWidthPickerOpen, setIsWidthPickerOpen] = useState(false);

  // Toolbar scroll states
  const [canScrollUp, setCanScrollUp] = useState(false);
  const [canScrollDown, setCanScrollDown] = useState(false);

  // Refs for real-time synchronization
  const currentStrokeIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocketClient | null>(null);
  const lastCursorSendRef = useRef<number>(0);
  const chatBottomRef = useRef<HTMLDivElement>(null);
  const toolScrollRef = useRef<HTMLDivElement>(null);

  // Pan tracking refs (avoid state re-renders during drag)
  const panStartRef = useRef<{ x: number; y: number } | null>(null);
  const viewportAtPanStartRef = useRef<Viewport | null>(null);

  // Space key ref to avoid stale closure issues
  const isSpacePanningRef = useRef(false);

  // Eraser state & refs
  const [eraserCursorPos, setEraserCursorPos] = useState<Point | null>(null);
  const eraserPrevPointRef = useRef<Point | null>(null);
  const erasedStrokesInCurrentDragRef = useRef<Stroke[]>([]);

  // --- Derived: is panning active? ---
  const isPanning = isPanMode || isSpacePanning || isMiddlePanning;

  const checkScroll = () => {
    const el = toolScrollRef.current;
    if (el) {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setCanScrollUp(scrollTop > 2);
      setCanScrollDown(scrollTop + clientHeight < scrollHeight - 2);
    }
  };

  const scrollTools = (direction: 'up' | 'down') => {
    const el = toolScrollRef.current;
    if (el) {
      const scrollAmount = direction === 'up' ? -100 : 100;
      el.scrollBy({ top: scrollAmount, behavior: 'smooth' });
    }
  };

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
  const displayRoomCode = roomId;

  // Curated Sleek Premium HSL Colors Palette
  const colorsPalette = [
    '#2563eb', // Royal Electric Blue
    '#ec4899', // Hot Neon Pink
    '#10b981', // Mint Emerald Green
    '#f59e0b', // Deep Amber Gold
    '#8b5cf6', // Electric Violet Purple
    '#ef4444', // Crimson Coral Red
    '#ffffff', // Chalk White
    '#000000', // Ink Black
  ];

  // Width stroke values
  const strokeWidths = [2, 4, 8, 12, 20];

  // ===================================================================
  // Effects
  // ===================================================================

  // 1. Responsive window size tracking
  useEffect(() => {
    const handleResize = () => {
      if (typeof window !== 'undefined') {
        setDimensions({
          width: window.innerWidth,
          height: window.innerHeight
        });
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const eraseStrokesAt = useCallback((startPoint: Point, endPoint: Point) => {
    const currentStrokes = useStore.getState().strokes;
    const eraserRadius = 16 / useStore.getState().viewport.scale;
    const eraserSeg: Segment = {
      x1: startPoint.x,
      y1: startPoint.y,
      x2: endPoint.x,
      y2: endPoint.y
    };

    const toDelete: Stroke[] = [];
    currentStrokes.forEach(stroke => {
      if (stroke.isDeleted) return;
      if (strokeIntersectsEraser(stroke, eraserSeg, eraserRadius)) {
        toDelete.push(stroke);
      }
    });

    if (toDelete.length > 0) {
      const deleteIds = toDelete.map(s => s.id);
      
      setStrokes((prev: Stroke[]) => prev.filter(s => !deleteIds.includes(s.id)));
      
      toDelete.forEach(s => {
        if (!erasedStrokesInCurrentDragRef.current.some(x => x.id === s.id)) {
          erasedStrokesInCurrentDragRef.current.push({ ...s, isDeleted: true });
        }
      });

      if (wsRef.current) {
        wsRef.current.send({
          eventType: 'OBJECT_DELETE',
          userId,
          roomId,
          timestamp: Date.now(),
          payload: { strokeIds: deleteIds }
        });
      }
    }
  }, [roomId, userId, setStrokes]);

  const performUndo = useCallback(() => {
    const poppedList = popFromUndo();
    if (!poppedList || poppedList.length === 0) return;

    pushToRedo(poppedList);

    const toRestore: Stroke[] = [];
    const toDeleteIds: string[] = [];

    poppedList.forEach((s) => {
      if (s.isDeleted) {
        toRestore.push({ ...s, isDeleted: false });
      } else {
        toDeleteIds.push(s.id);
      }
    });

    if (toRestore.length > 0) {
      setStrokes((prev: Stroke[]) => {
        const filtered = prev.filter(x => !toRestore.some(a => a.id === x.id));
        return [...filtered, ...toRestore];
      });
      toRestore.forEach(s => {
        wsRef.current?.send({
          eventType: 'REDO',
          userId,
          roomId,
          timestamp: Date.now(),
          payload: { stroke: s }
        });
      });
    }

    if (toDeleteIds.length > 0) {
      setStrokes((prev: Stroke[]) => prev.filter(x => !toDeleteIds.includes(x.id)));
      toDeleteIds.forEach(id => {
        wsRef.current?.send({
          eventType: 'UNDO',
          userId,
          roomId,
          timestamp: Date.now(),
          payload: { strokeId: id }
        });
      });
    }
  }, [roomId, userId, popFromUndo, pushToRedo, setStrokes]);

  const performRedo = useCallback(() => {
    const poppedList = popFromRedo();
    if (!poppedList || poppedList.length === 0) return;

    pushToUndo(poppedList);

    const toRestore: Stroke[] = [];
    const toDeleteIds: string[] = [];

    poppedList.forEach((s) => {
      if (s.isDeleted) {
        toDeleteIds.push(s.id);
      } else {
        toRestore.push(s);
      }
    });

    if (toRestore.length > 0) {
      setStrokes((prev: Stroke[]) => {
        const filtered = prev.filter(x => !toRestore.some(a => a.id === x.id));
        return [...filtered, ...toRestore];
      });
      toRestore.forEach(s => {
        wsRef.current?.send({
          eventType: 'REDO',
          userId,
          roomId,
          timestamp: Date.now(),
          payload: { stroke: s }
        });
      });
    }

    if (toDeleteIds.length > 0) {
      setStrokes((prev: Stroke[]) => prev.filter(x => !toDeleteIds.includes(x.id)));
      wsRef.current?.send({
        eventType: 'OBJECT_DELETE',
        userId,
        roomId,
        timestamp: Date.now(),
        payload: { strokeIds: toDeleteIds }
      });
    }
  }, [roomId, userId, popFromRedo, pushToUndo, setStrokes]);

  // 2. Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focused on an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const state = useStore.getState();

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setIsSpacePanning(true);
        isSpacePanningRef.current = true;
      }

      // Tool Switching & Deletion
      if (!e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'v': state.setActiveTool('select'); setIsPanMode(false); break;
          case 'p': state.setActiveTool('pen'); setIsPanMode(false); break;
          case 'r': state.setActiveTool('rect'); setIsPanMode(false); break;
          case 'c': state.setActiveTool('circle'); setIsPanMode(false); break;
          case 'l': state.setActiveTool('line'); setIsPanMode(false); break;
          case 'e': state.setActiveTool('eraser'); setIsPanMode(false); break;
          case 'backspace':
          case 'delete':
            if (state.selectedIds.length > 0) {
              const deletedStrokes = state.strokes.filter(s => state.selectedIds.includes(s.id)).map(s => ({ ...s, isDeleted: true }));
              const remaining = state.strokes.filter(s => !state.selectedIds.includes(s.id));
              state.setStrokes(remaining);

              if (wsRef.current) {
                wsRef.current.send({
                  eventType: 'OBJECT_DELETE',
                  userId,
                  roomId,
                  timestamp: Date.now(),
                  payload: { strokeIds: state.selectedIds }
                });
              }
              state.pushToUndo(deletedStrokes);
              state.setSelectedIds([]);
            }
            break;
        }
      }

      // Undo / Redo Shortcuts (Cmd+Z / Cmd+Shift+Z)
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          performRedo();
        } else {
          performUndo();
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePanning(false);
        isSpacePanningRef.current = false;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('keyup', handleKeyUp);
    };
  }, [roomId, userId, performUndo, performRedo]);

  // 3. Fetch Board Snapshot and Chronological Event History on Mount
  useEffect(() => {
    const loadHistory = async () => {
      try {
        setHistoryLoading(true);
        const [historyRes, roomRes] = await Promise.all([
          axios.get(`${apiBaseUrl}/api/rooms/${roomId}/history?userId=${userId}`),
          axios.get(`${apiBaseUrl}/api/rooms/${roomId}`)
        ]);
        const { boardSnapshot, recentEvents, chatHistory, wsToken: fetchedToken } = historyRes.data;
        if (roomRes.data && roomRes.data.name) {
          setRoomName(roomRes.data.name);
        }

        // Parse and recover drawing snapshot
        let recoveredStrokes: Stroke[] = [];
        if (boardSnapshot && boardSnapshot !== '[]') {
          try {
            recoveredStrokes = JSON.parse(boardSnapshot);
          } catch (e) {
            console.error('Failed to parse snapshot state:', e);
          }
        }

        // Apply recent incremental events since the snapshot
        if (Array.isArray(recentEvents)) {
          const eventsMap = new Map<string, Stroke>();

          recoveredStrokes.forEach(s => eventsMap.set(s.id, s));

          recentEvents.forEach((event: any) => {
            try {
              const payload = JSON.parse(event.payload);
              const sId = payload.strokeId;
              if (!sId) return;

              if (event.eventType === 'DRAW_START') {
                eventsMap.set(sId, {
                  id: sId,
                  userId: event.userId,
                  color: payload.color || '#000000',
                  strokeWidth: payload.strokeWidth || 3,
                  tool: payload.tool || 'pen',
                  points: []
                });
              } else if (event.eventType === 'DRAW_MOVE' && eventsMap.has(sId)) {
                const strokeObj = eventsMap.get(sId)!;
                if (payload.point) {
                  if (strokeObj.tool === 'pen' || strokeObj.tool === 'eraser') {
                    strokeObj.points.push(payload.point);
                  } else {
                    if (strokeObj.points.length === 0) {
                      strokeObj.points.push(payload.point);
                    } else if (strokeObj.points.length === 1) {
                      strokeObj.points.push(payload.point);
                    } else {
                      strokeObj.points[1] = payload.point;
                    }
                  }
                }
              } else if (event.eventType === 'DRAW_END' && eventsMap.has(sId)) {
                if (payload.points && Array.isArray(payload.points)) {
                  eventsMap.get(sId)!.points = payload.points;
                }
              } else if (event.eventType === 'OBJECT_TRANSFORM' && eventsMap.has(sId)) {
                if (payload.transform) {
                  Object.assign(eventsMap.get(sId)!, payload.transform);
                }
              } else if (event.eventType === 'OBJECT_DUPLICATE') {
                if (payload.strokes && Array.isArray(payload.strokes)) {
                  payload.strokes.forEach((s: any) => eventsMap.set(s.id, s));
                }
              }
            } catch (ex) {
              console.error('Failed to process historical event payload:', ex);
            }
          });

          recoveredStrokes = Array.from(eventsMap.values());
        }

        // Migrate legacy normalized coordinates to world coordinates
        recoveredStrokes = migrateStrokesIfLegacy(recoveredStrokes);

        setStrokes(recoveredStrokes);

        // Recover chat logs
        if (Array.isArray(chatHistory)) {
          const parsedChats = chatHistory.map((c: any) => ({
            senderId: c.senderId,
            senderName: c.senderName,
            message: c.message,
            timestamp: c.timestamp
          }));
          setMessages(parsedChats);
        }

        setWsToken(fetchedToken);
        setHistoryLoading(false);
      } catch (err) {
        console.error('Failed to recover board history:', err);
        setHistoryLoading(false);
      }
    };

    loadHistory();
  }, [roomId, userId, apiBaseUrl, setStrokes, setMessages, setRoomName]);

  // 4. Connect to WebSocket client once token is fetched
  useEffect(() => {
    if (!wsToken) return;

    const ws = new WebSocketClient(roomId, userId, wsToken);
    wsRef.current = ws;
    ws.connect().catch(console.error);

    return () => {
      ws.close();
    };
  }, [roomId, userId, wsToken]);

  // 5. Initialize viewport centered at world origin once dimensions are ready
  useEffect(() => {
    if (dimensions.width && dimensions.height && !historyLoading) {
      setViewport(createDefaultViewport(dimensions.width, dimensions.height));
    }
    // Only run on initial load (dimensions first available + history done)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyLoading]);


  const recomputeGroupDragRect = useCallback(() => {
    if (trRef.current && selectedIds.length > 0) {
      const clientRect = trRef.current.getClientRect();
      if (clientRect.width === 0 && clientRect.height === 0) {
        setGroupDragRect(null);
        return;
      }
      const currentViewport = useStore.getState().viewport;
      const topLeft = screenToWorld(clientRect.x, clientRect.y, currentViewport);
      const bottomRight = screenToWorld(clientRect.x + clientRect.width, clientRect.y + clientRect.height, currentViewport);
      setGroupDragRect({
        x: topLeft.x,
        y: topLeft.y,
        width: bottomRight.x - topLeft.x,
        height: bottomRight.y - topLeft.y
      });
    } else {
      setGroupDragRect(null);
    }
  }, [selectedIds]);

  useEffect(() => {
    if (activeTool === 'select' && selectedIds.length > 0 && drawingLayerRef.current && trRef.current) {
      const nodes = selectedIds.map(id => drawingLayerRef.current?.children.find(child => child.id() === id)).filter(Boolean);
      trRef.current.nodes(nodes as Konva.Node[]);
      trRef.current.getLayer()?.batchDraw();
      requestAnimationFrame(recomputeGroupDragRect);
      trRef.current.on('transform', recomputeGroupDragRect);
      return () => {
        if (trRef.current) trRef.current.off('transform', recomputeGroupDragRect);
      };
    } else if (trRef.current) {
      trRef.current.nodes([]);
      trRef.current.getLayer()?.batchDraw();
      setGroupDragRect(null);
    }
  }, [selectedIds, activeTool, strokes, viewport, recomputeGroupDragRect]);


  // 6. Trigger scroll checks whenever tools render, window resizes, or history finishes loading
  useEffect(() => {
    const el = toolScrollRef.current;
    if (el) {
      const timer = setTimeout(() => {
        const { scrollTop, scrollHeight, clientHeight } = el;
        setCanScrollUp(scrollTop > 2);
        setCanScrollDown(scrollTop + clientHeight < scrollHeight - 2);
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [historyLoading, activeTool, dimensions]);

  // ===================================================================
  // Canvas Event Handlers
  // ===================================================================

  /**
   * Handle mouse wheel — cursor-centric zoom using viewport utilities.
   */
  const handleWheel = useCallback((e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;

    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const currentViewport = useStore.getState().viewport;
    const direction = e.evt.deltaY < 0 ? 1 : -1;
    const newScale = direction > 0
      ? currentViewport.scale * ZOOM_SPEED
      : currentViewport.scale / ZOOM_SPEED;

    const newViewport = zoomAtPoint(currentViewport, pointer.x, pointer.y, newScale);
    setViewport(newViewport);
  }, [setViewport]);

  /**
   * Handle mouse down — start drawing or start panning depending on mode.
   */
  const handleMouseDown = useCallback((e: any) => {
    if (historyLoading) return;

    const stage = stageRef.current;
    if (!stage) return;

    const pos = stage.getPointerPosition();
    if (!pos) return;

    const currentViewport = useStore.getState().viewport;

    // Middle mouse button → always pan
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      setIsMiddlePanning(true);
      panStartRef.current = { x: pos.x, y: pos.y };
      viewportAtPanStartRef.current = { ...currentViewport };
      return;
    }

    // Pan mode (tool or space key) + left click → pan
    if (isPanMode || isSpacePanningRef.current) {
      panStartRef.current = { x: pos.x, y: pos.y };
      viewportAtPanStartRef.current = { ...currentViewport };
      return;
    }

    if (activeTool === 'select') {
      const target = e.target;
      if (target === stage) {
        setSelectedIds([]);
        const worldPos = screenToWorld(pos.x, pos.y, currentViewport);
        selectionStartRef.current = worldPos;
        setSelectionBox({ x: worldPos.x, y: worldPos.y, width: 0, height: 0, visible: true });
      }
      return;
    }

    // Left click in draw mode → start drawing (allow touch events where button is undefined)
    if (e.evt.button !== undefined && e.evt.button !== 0) return;

    // Convert screen position to world coordinates
    const worldPos = screenToWorld(pos.x, pos.y, currentViewport);

    if (activeTool === 'eraser') {
      setIsDrawing(true);
      eraserPrevPointRef.current = worldPos;
      erasedStrokesInCurrentDragRef.current = [];
      eraseStrokesAt(worldPos, worldPos);
      return;
    }

    setIsDrawing(true);

    const strokeId = `${userId}-${Date.now()}`;
    currentStrokeIdRef.current = strokeId;

    const newStroke: Stroke = {
      id: strokeId,
      userId,
      color: color,
      strokeWidth: strokeWidth,
      tool: activeTool,
      points: [worldPos]
    };

    addStroke(newStroke);

    wsRef.current?.send({
      eventType: 'DRAW_START',
      userId,
      roomId,
      timestamp: Date.now(),
      payload: {
        strokeId,
        color: newStroke.color,
        strokeWidth: newStroke.strokeWidth,
        tool: activeTool,
        point: worldPos
      }
    });

    wsRef.current?.send({
      eventType: 'DRAW_MOVE',
      userId,
      roomId,
      timestamp: Date.now(),
      payload: { strokeId, point: worldPos }
    });
  }, [historyLoading, isPanMode, userId, activeTool, color, strokeWidth, roomId, addStroke, setViewport, eraseStrokesAt]);

  /**
   * Handle mouse move — draw or pan depending on active mode.
   */
  const handleMouseMove = useCallback((e: any) => {
    const stage = stageRef.current;
    if (!stage) return;

    const pos = stage.getPointerPosition();
    if (!pos) return;

    const currentViewport = useStore.getState().viewport;

    // --- Handle panning (middle mouse, space-drag, or pan tool) ---
    if ((isMiddlePanning || isPanMode || isSpacePanningRef.current) && panStartRef.current && viewportAtPanStartRef.current) {
      const dx = pos.x - panStartRef.current.x;
      const dy = pos.y - panStartRef.current.y;

      // Pan by adjusting the viewport offset (delta is in screen pixels, convert to world)
      const newViewport: Viewport = {
        ...viewportAtPanStartRef.current,
        offsetX: viewportAtPanStartRef.current.offsetX - dx / currentViewport.scale,
        offsetY: viewportAtPanStartRef.current.offsetY - dy / currentViewport.scale,
      };
      setViewport(newViewport);
      return; // Don't process drawing during pan
    }

    if (activeTool === 'select' && selectionBox?.visible && selectionStartRef.current) {
      const worldPos = screenToWorld(pos.x, pos.y, currentViewport);
      setSelectionBox({
        x: Math.min(selectionStartRef.current.x, worldPos.x),
        y: Math.min(selectionStartRef.current.y, worldPos.y),
        width: Math.abs(worldPos.x - selectionStartRef.current.x),
        height: Math.abs(worldPos.y - selectionStartRef.current.y),
        visible: true,
      });
      return;
    }

    // --- Convert screen → world for drawing and cursor sync ---
    const worldPos = screenToWorld(pos.x, pos.y, currentViewport);

    // Throttled transient CURSOR_MOVE syncing (50ms)
    const now = Date.now();
    if (now - lastCursorSendRef.current > 50) {
      wsRef.current?.send({
        eventType: 'CURSOR_MOVE',
        userId,
        roomId,
        timestamp: now,
        payload: {
          username: username || 'Guest',
          x: worldPos.x,
          y: worldPos.y
        }
      });
      lastCursorSendRef.current = now;
    }

    if (activeTool === 'eraser') {
      setEraserCursorPos(worldPos);
      if (isDrawing && eraserPrevPointRef.current) {
        eraseStrokesAt(eraserPrevPointRef.current, worldPos);
        eraserPrevPointRef.current = worldPos;
      }
      return;
    } else if (eraserCursorPos !== null) {
      setEraserCursorPos(null);
    }

    if (!isDrawing || !currentStrokeIdRef.current) return;

    // Distance-based throttle for pen to avoid excessive points
    if (activeTool === 'pen') {
      const currentStrokes = useStore.getState().strokes;
      const activeStroke = currentStrokes.find((s) => s.id === currentStrokeIdRef.current);
      if (activeStroke && activeStroke.points.length > 0) {
        const lastPt = activeStroke.points[activeStroke.points.length - 1];
        const dx = worldPos.x - lastPt.x;
        const dy = worldPos.y - lastPt.y;
        const distSq = dx * dx + dy * dy;
        // ~1.5px minimum distance in world coords
        if (distSq < 2.25) return;
      }
    }

    updateLastStrokePoints(currentStrokeIdRef.current, worldPos);

    wsRef.current?.send({
      eventType: 'DRAW_MOVE',
      userId,
      roomId,
      timestamp: Date.now(),
      payload: { strokeId: currentStrokeIdRef.current, point: worldPos }
    });
  }, [isDrawing, isMiddlePanning, isPanMode, userId, roomId, username, activeTool, selectionBox, updateLastStrokePoints, setViewport, eraseStrokesAt, eraserCursorPos]);

  /**
   * Handle mouse up — finish drawing or finish panning.
   */
  const handleMouseUp = useCallback(() => {
    if (activeTool === 'eraser') {
      setIsDrawing(false);
      eraserPrevPointRef.current = null;
      if (erasedStrokesInCurrentDragRef.current.length > 0) {
        pushToUndo(erasedStrokesInCurrentDragRef.current);
      }
      erasedStrokesInCurrentDragRef.current = [];
      return;
    }

    if (activeTool === 'select' && selectionBox?.visible) {
      const box = selectionBox;
      const currentStrokes = useStore.getState().strokes;
      const selectedIdsArray: string[] = [];

      currentStrokes.forEach(stroke => {
        if (stroke.tool === 'eraser') return;
        // Stage 1: Fast AABB rejection in world coordinates
        const strokeAABB = getStrokeAABB(stroke);
        const aabbOverlap = !(
          strokeAABB.x > box.x + box.width ||
          strokeAABB.x + strokeAABB.width < box.x ||
          strokeAABB.y > box.y + box.height ||
          strokeAABB.y + strokeAABB.height < box.y
        );
        if (!aabbOverlap) return;

        // Stage 2: Precise geometric intersection
        if (strokeIntersectsRect(stroke, box)) {
          selectedIdsArray.push(stroke.id);
        }
      });

      setSelectedIds(selectedIdsArray);
      setSelectionBox(Object.assign({}, box, { visible: false }));
      selectionStartRef.current = null;
      return;
    }

    // End panning
    if (isMiddlePanning) {
      setIsMiddlePanning(false);
      panStartRef.current = null;
      viewportAtPanStartRef.current = null;
      return;
    }
    if ((isPanMode || isSpacePanningRef.current) && panStartRef.current) {
      panStartRef.current = null;
      viewportAtPanStartRef.current = null;
      return;
    }

    // End drawing
    if (!isDrawing || !currentStrokeIdRef.current) return;
    setIsDrawing(false);

    const currentStrokes = useStore.getState().strokes;
    const activeStroke = currentStrokes.find((s) => s.id === currentStrokeIdRef.current);

    if (activeStroke) {
      if (activeTool === 'pen') {
        // Simplify path — tolerance in world pixels
        const simplifiedPoints = simplifyPath(activeStroke.points, 1);
        activeStroke.points = simplifiedPoints;
        setStrokes((prev: Stroke[]) =>
          prev.map((s) => (s.id === activeStroke.id ? { ...s, points: simplifiedPoints } : s))
        );
      }

      pushToUndo(activeStroke);

      if (activeTool !== 'pen') {
        const endPoint = activeStroke.points[1] || activeStroke.points[0];
        wsRef.current?.send({
          eventType: 'DRAW_MOVE',
          userId,
          roomId,
          timestamp: Date.now(),
          payload: { strokeId: currentStrokeIdRef.current, point: endPoint }
        });
      }

      wsRef.current?.send({
        eventType: 'DRAW_END',
        userId,
        roomId,
        timestamp: Date.now(),
        payload: { strokeId: currentStrokeIdRef.current, points: activeStroke.points }
      });
    }

    currentStrokeIdRef.current = null;
  }, [isDrawing, isMiddlePanning, isPanMode, activeTool, selectionBox, userId, roomId, setStrokes, pushToUndo]);

  const handleNodeDragStart = useCallback((e: any, strokeId: string) => {
    if (activeTool !== 'select' || (!selectedIds.includes(strokeId) && strokeId !== 'group-rect')) return;
    const layer = drawingLayerRef.current;
    if (layer) {
      if (strokeId === 'group-rect') {
        dragStartOffsetRef.current['group-rect'] = { x: e.target.x(), y: e.target.y() };
      }
      layer.children.forEach(n => {
        if (selectedIds.includes(n.id())) {
          dragStartOffsetRef.current[n.id()] = { x: n.x(), y: n.y() };
        }
      });
    }
  }, [activeTool, selectedIds]);

  const handleNodeDragMove = useCallback((e: any, strokeId: string) => {
    if (activeTool !== 'select' || (!selectedIds.includes(strokeId) && strokeId !== 'group-rect') || selectedIds.length === 0) return;
    const node = e.target;
    const startPos = dragStartOffsetRef.current[strokeId];
    if (!startPos) return;

    const dx = node.x() - startPos.x;
    const dy = node.y() - startPos.y;

    const layer = drawingLayerRef.current;
    if (layer) {
      layer.children.forEach(n => {
        if (n.id() !== strokeId && selectedIds.includes(n.id())) {
          const otherStart = dragStartOffsetRef.current[n.id()];
          if (otherStart) {
            n.x(otherStart.x + dx);
            n.y(otherStart.y + dy);
          }
        }
      });
    }
  }, [activeTool, selectedIds]);

  const handleNodeDragEnd = useCallback((e: any) => {
    if (activeTool !== 'select') return;

    const transforms: any[] = [];
    selectedIds.forEach(id => {
      const n = drawingLayerRef.current?.children.find(child => child.id() === id);
      if (n) {
        const transform = { x: n.x(), y: n.y(), scaleX: n.scaleX(), scaleY: n.scaleY(), rotation: n.rotation() };
        updateStrokeTransform(id, transform);
        transforms.push({ strokeId: id, transform });
      }
    });

    if (transforms.length > 0) {
      wsRef.current?.send({
        eventType: 'OBJECT_TRANSFORM',
        userId,
        roomId,
        timestamp: Date.now(),
        payload: { transforms }
      });
    }

    // Recompute the invisible drag rect so it stays in sync
    requestAnimationFrame(recomputeGroupDragRect);
  }, [activeTool, selectedIds, roomId, userId, updateStrokeTransform, recomputeGroupDragRect]);

  const handleNodeTransformEnd = useCallback((e: any, strokeId: string) => {
    if (activeTool !== 'select') return;
    const node = e.target;
    const transform = { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() };
    updateStrokeTransform(strokeId, transform);
    wsRef.current?.send({ eventType: 'OBJECT_TRANSFORM', userId, roomId, timestamp: Date.now(), payload: { strokeId, transform } });
  }, [activeTool, roomId, userId, updateStrokeTransform]);

  // ===================================================================
  // Undo / Redo / Clear / Export / Chat Actions
  // ===================================================================

  const handleUndo = () => {
    performUndo();
  };

  const handleRedo = () => {
    performRedo();
  };

  const handleClearBoard = () => {
    if (window.confirm('Are you sure you want to clear the entire whiteboard? This action will delete history.')) {
      clearStrokes();
      clearUndoRedo();

      wsRef.current?.send({
        eventType: 'BOARD_CLEAR',
        userId,
        roomId,
        timestamp: Date.now(),
        payload: {}
      });
    }
  };

  const handleExportPNG = () => {
    const stage = stageRef.current;
    if (!stage) return;

    // Export the current visible viewport as PNG
    const bgLayer = new Konva.Layer();
    const bgRect = new Konva.Rect({
      x: 0,
      y: 0,
      width: dimensions.width,
      height: dimensions.height,
      fill: '#ffffff'
    });
    bgLayer.add(bgRect);
    stage.add(bgLayer);
    bgLayer.moveToBottom();

    const dataURL = stage.toDataURL({ mimeType: 'image/png', quality: 1.0 });
    bgLayer.destroy();

    const link = document.createElement('a');
    link.download = `${roomName || 'whiteboard'}-export.png`;
    link.href = dataURL;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const timestamp = Date.now();
    const chatMsg = {
      senderId: userId,
      senderName: username || 'Guest',
      message: chatInput.trim(),
      timestamp
    };

    addMessage(chatMsg);

    wsRef.current?.send({
      eventType: 'CHAT_MESSAGE',
      userId,
      roomId,
      timestamp,
      payload: {
        senderName: username || 'Guest',
        message: chatInput.trim()
      }
    });

    setChatInput('');
  };

  const copyInviteLink = () => {
    if (typeof window !== 'undefined') {
      const inviteLink = `${window.location.origin}/?code=${roomId}`;
      navigator.clipboard.writeText(inviteLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(displayRoomCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // ===================================================================
  // Zoom controls (button +/-/reset)
  // ===================================================================

  const handleZoomIn = useCallback(() => {
    const vp = useStore.getState().viewport;
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    setViewport(zoomAtPoint(vp, centerX, centerY, vp.scale * 1.2));
  }, [dimensions, setViewport]);

  const handleZoomOut = useCallback(() => {
    const vp = useStore.getState().viewport;
    const centerX = dimensions.width / 2;
    const centerY = dimensions.height / 2;
    setViewport(zoomAtPoint(vp, centerX, centerY, vp.scale / 1.2));
  }, [dimensions, setViewport]);

  const handleZoomReset = useCallback(() => {
    setViewport(createDefaultViewport(dimensions.width, dimensions.height));
  }, [dimensions, setViewport]);

  // ===================================================================
  // Memoized grid lines
  // ===================================================================

  const gridLines = useMemo(() => {
    if (!showGrid) return null;

    const { minor, major } = getAdaptiveGridSpacing(viewport.scale);
    const visibleRect = getVisibleWorldRect(viewport, dimensions.width, dimensions.height);

    // Extend slightly beyond viewport for smooth scrolling
    const pad = minor * 2;
    const left = Math.floor((visibleRect.x - pad) / minor) * minor;
    const top = Math.floor((visibleRect.y - pad) / minor) * minor;
    const right = visibleRect.x + visibleRect.width + pad;
    const bottom = visibleRect.y + visibleRect.height + pad;

    const lines: React.ReactNode[] = [];
    let key = 0;

    // Vertical lines
    for (let x = left; x <= right; x += minor) {
      const isMajor = Math.abs(x % major) < 0.01;
      lines.push(
        <KonvaLine
          key={`gv-${key++}`}
          points={[x, top, x, bottom]}
          stroke={isMajor ? '#d4d4d8' : '#e8e8ec'}
          strokeWidth={(isMajor ? 1 : 0.5) / viewport.scale}
          listening={false}
          perfectDrawEnabled={false}
        />
      );
    }

    // Horizontal lines
    for (let y = top; y <= bottom; y += minor) {
      const isMajor = Math.abs(y % major) < 0.01;
      lines.push(
        <KonvaLine
          key={`gh-${key++}`}
          points={[left, y, right, y]}
          stroke={isMajor ? '#d4d4d8' : '#e8e8ec'}
          strokeWidth={(isMajor ? 1 : 0.5) / viewport.scale}
          listening={false}
          perfectDrawEnabled={false}
        />
      );
    }

    return lines;
  }, [showGrid, viewport, dimensions]);

  // ===================================================================
  // Konva Stage transform values from viewport
  // ===================================================================

  const stageX = -viewport.offsetX * viewport.scale;
  const stageY = -viewport.offsetY * viewport.scale;

  // Determine cursor style
  const cursorStyle = isPanning
    ? (panStartRef.current ? 'cursor-grabbing' : 'cursor-grab')
    : 'cursor-crosshair';

  // ===================================================================
  // Render
  // ===================================================================

  return (
    <div className={`w-full h-[100dvh] flex overflow-hidden relative select-none transition-colors duration-300 ${isDarkMode ? 'bg-zinc-950 text-zinc-50' : 'bg-[#fafafa] text-zinc-900'}`}>

      {/* 1. Interactive Whiteboard Canvas Stage Layer */}
      <div className={`flex-1 h-[100dvh] relative transition-colors duration-300 ${isDarkMode ? 'bg-zinc-950' : 'bg-[#fafafa]'}`}>
        {historyLoading && (
          <div className="absolute inset-0 bg-[#fafafa]/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center gap-3">
            <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-zinc-500 font-medium text-xs tracking-wider uppercase">Syncing Board History...</p>
          </div>
        )}

        <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => { handleMouseUp(); setEraserCursorPos(null); }}
          onTouchStart={handleMouseDown}
          onTouchMove={handleMouseMove}
          onTouchEnd={handleMouseUp}
          scaleX={viewport.scale}
          scaleY={viewport.scale}
          x={stageX}
          y={stageY}
          onWheel={handleWheel}
          onContextMenu={(e) => e.evt.preventDefault()}
          className={`${cursorStyle} absolute inset-0 touch-none`}
        >
          {/* Grid Layer — rendered behind everything, non-interactive */}
          <Layer listening={false}>
            {gridLines}
          </Layer>

          {/* Drawing Layer — all strokes rendered in world coordinates */}
          <Layer ref={drawingLayerRef}>
            {strokes.map((stroke) => {
              const pointsArr = stroke.points.flatMap((p) => [p.x, p.y]);

              if (pointsArr.length === 0) return null;

              if (stroke.tool === 'pen' || stroke.tool === 'eraser') {
                return (
                  <KonvaLine key={stroke.id}
                    id={stroke.id}
                    x={stroke.x || 0}
                    y={stroke.y || 0}
                    scaleX={stroke.scaleX || 1}
                    scaleY={stroke.scaleY || 1}
                    rotation={stroke.rotation || 0}
                    draggable={activeTool === 'select' && stroke.tool !== 'eraser'}
                    onClick={(e) => {
                      if (activeTool === 'select' && stroke.tool !== 'eraser') {
                        if (e.evt.shiftKey) {
                          if (selectedIds.includes(stroke.id)) setSelectedIds(selectedIds.filter(id => id !== stroke.id));
                          else setSelectedIds([...selectedIds, stroke.id]);
                        } else {
                          setSelectedIds([stroke.id]);
                        }
                        e.cancelBubble = true;
                      }
                    }}
                    onTap={(e) => {
                      if (activeTool === 'select' && stroke.tool !== 'eraser') {
                        setSelectedIds([stroke.id]);
                        e.cancelBubble = true;
                      }
                    }}
                    onDragStart={(e) => handleNodeDragStart(e, stroke.id)}
                    onDragMove={(e) => handleNodeDragMove(e, stroke.id)}
                    onDragEnd={(e) => handleNodeDragEnd(e)}
                    onTransformEnd={(e) => handleNodeTransformEnd(e, stroke.id)}
                    points={pointsArr}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.5}
                    globalCompositeOperation={stroke.tool === 'eraser' ? 'destination-out' : 'source-over'}
                  />
                );
              } else if (stroke.tool === 'line') {
                const p2 = stroke.points[1] || stroke.points[0];
                return (
                  <KonvaLine key={stroke.id}
                    id={stroke.id}
                    x={stroke.x || 0}
                    y={stroke.y || 0}
                    scaleX={stroke.scaleX || 1}
                    scaleY={stroke.scaleY || 1}
                    rotation={stroke.rotation || 0}
                    draggable={activeTool === 'select'}
                    onClick={(e) => {
                      if (activeTool === 'select') {
                        if (e.evt.shiftKey) {
                          if (selectedIds.includes(stroke.id)) setSelectedIds(selectedIds.filter(id => id !== stroke.id));
                          else setSelectedIds([...selectedIds, stroke.id]);
                        } else {
                          setSelectedIds([stroke.id]);
                        }
                        e.cancelBubble = true;
                      }
                    }}
                    onTap={(e) => {
                      if (activeTool === 'select') {
                        setSelectedIds([stroke.id]);
                        e.cancelBubble = true;
                      }
                    }}
                    onDragStart={(e) => handleNodeDragStart(e, stroke.id)}
                    onDragMove={(e) => handleNodeDragMove(e, stroke.id)}
                    onDragEnd={(e) => handleNodeDragEnd(e)}
                    onTransformEnd={(e) => handleNodeTransformEnd(e, stroke.id)}
                    points={[
                      stroke.points[0].x,
                      stroke.points[0].y,
                      p2.x,
                      p2.y
                    ]}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                  />
                );
              } else if (stroke.tool === 'rect') {
                const p1 = stroke.points[0];
                const p2 = stroke.points[1] || stroke.points[0];
                const x = Math.min(p1.x, p2.x);
                const y = Math.min(p1.y, p2.y);
                const width = Math.abs(p1.x - p2.x);
                const height = Math.abs(p1.y - p2.y);

                return (
                  <KonvaRect key={stroke.id}
                    id={stroke.id}
                    scaleX={stroke.scaleX || 1}
                    scaleY={stroke.scaleY || 1}
                    rotation={stroke.rotation || 0}
                    draggable={activeTool === 'select'}
                    onClick={(e) => {
                      if (activeTool === 'select') {
                        if (e.evt.shiftKey) {
                          if (selectedIds.includes(stroke.id)) setSelectedIds(selectedIds.filter(id => id !== stroke.id));
                          else setSelectedIds([...selectedIds, stroke.id]);
                        } else {
                          setSelectedIds([stroke.id]);
                        }
                        e.cancelBubble = true;
                      }
                    }}
                    onTap={(e) => {
                      if (activeTool === 'select') {
                        setSelectedIds([stroke.id]);
                        e.cancelBubble = true;
                      }
                    }}
                    onDragStart={(e) => handleNodeDragStart(e, stroke.id)}
                    onDragMove={(e) => handleNodeDragMove(e, stroke.id)}
                    onDragEnd={(e) => handleNodeDragEnd(e)}
                    onTransformEnd={(e) => handleNodeTransformEnd(e, stroke.id)}
                    x={stroke.x ?? x}
                    y={stroke.y ?? y}
                    width={width}
                    height={height}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                    lineJoin="round"
                    lineCap="round"
                    cornerRadius={4}
                  />
                );
              } else if (stroke.tool === 'circle') {
                const p1 = stroke.points[0];
                const p2 = stroke.points[1] || stroke.points[0];
                const r = Math.sqrt(
                  Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2)
                );

                return (
                  <KonvaCircle key={stroke.id}
                    id={stroke.id}
                    scaleX={stroke.scaleX || 1}
                    scaleY={stroke.scaleY || 1}
                    rotation={stroke.rotation || 0}
                    draggable={activeTool === 'select'}
                    onClick={(e) => {
                      if (activeTool === 'select') {
                        if (e.evt.shiftKey) {
                          if (selectedIds.includes(stroke.id)) setSelectedIds(selectedIds.filter(id => id !== stroke.id));
                          else setSelectedIds([...selectedIds, stroke.id]);
                        } else {
                          setSelectedIds([stroke.id]);
                        }
                        e.cancelBubble = true;
                      }
                    }}
                    onTap={(e) => {
                      if (activeTool === 'select') {
                        setSelectedIds([stroke.id]);
                        e.cancelBubble = true;
                      }
                    }}
                    onDragStart={(e) => handleNodeDragStart(e, stroke.id)}
                    onDragMove={(e) => handleNodeDragMove(e, stroke.id)}
                    onDragEnd={(e) => handleNodeDragEnd(e)}
                    onTransformEnd={(e) => handleNodeTransformEnd(e, stroke.id)}
                    x={stroke.x ?? p1.x}
                    y={stroke.y ?? p1.y}
                    radius={r}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                  />
                );
              }
              return null;
            })}
            {selectionBox?.visible && (
              <KonvaRect
                id="selection-box"
                x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height}
                fill="rgba(37, 99, 235, 0.1)" stroke="#2563eb" strokeWidth={1 / viewport.scale} listening={false}
              />
            )}
            {activeTool === 'select' && groupDragRect && selectedIds.length > 0 && (
              <KonvaRect
                x={groupDragRect.x}
                y={groupDragRect.y}
                width={groupDragRect.width}
                height={groupDragRect.height}
                fill="transparent"
                draggable
                onDragStart={(e) => handleNodeDragStart(e, 'group-rect')}
                onDragMove={(e) => handleNodeDragMove(e, 'group-rect')}
                onDragEnd={(e) => handleNodeDragEnd(e)}
                onClick={(e) => { e.cancelBubble = true; }}
                onTap={(e) => { e.cancelBubble = true; }}
              />
            )}
            {activeTool === 'select' && (
              <Transformer
                ref={trRef}
                anchorSize={8}
                anchorCornerRadius={2}
                anchorStroke="#2563eb"
                anchorFill="#fff"
                borderStroke="#2563eb"
                borderStrokeWidth={1.5}
                rotateEnabled={true}
                rotateAnchorOffset={20}
                enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right', 'top-center', 'bottom-center', 'middle-left', 'middle-right']}
                boundBoxFunc={(oldBox, newBox) => { if (newBox.width < 5 || newBox.height < 5) return oldBox; return newBox; }}
                onTransformEnd={() => {
                  // Sync all selected nodes after resize/rotate
                  selectedIds.forEach(id => {
                    const node = drawingLayerRef.current?.children.find(child => child.id() === id);
                    if (node) {
                      const transform = { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(), rotation: node.rotation() };
                      updateStrokeTransform(id, transform);
                      wsRef.current?.send({ eventType: 'OBJECT_TRANSFORM', userId, roomId, timestamp: Date.now(), payload: { strokeId: id, transform } });
                    }
                  });
                  requestAnimationFrame(recomputeGroupDragRect);
                }}
              />
            )}
            {activeTool === 'eraser' && eraserCursorPos && (
              <KonvaCircle
                x={eraserCursorPos.x}
                y={eraserCursorPos.y}
                radius={12}
                stroke={isDarkMode ? 'rgba(255, 255, 255, 0.5)' : 'rgba(0, 0, 0, 0.3)'}
                strokeWidth={1.5 / viewport.scale}
                fill="rgba(0, 0, 0, 0.05)"
                listening={false}
              />
            )}
          </Layer>
        </Stage>

        {/* 2. Floating Collaborative Cursor Overlays */}
        <CollaborativeCursors userId={userId} viewport={viewport} />

        {/* 3. Top Center Toolbar (Tools) */}
        <div className="absolute top-24 md:top-20 left-1/2 -translate-x-1/2 flex items-center z-40 select-none shadow-2xl rounded-2xl glass-panel-light p-1 border border-zinc-200/80 backdrop-blur-lg">
          <div className="flex items-center gap-1">
            {/* Select Tool */}
            <ToolButton isActive={activeTool === 'select' && !isPanMode} onClick={() => { setActiveTool('select'); setIsPanMode(false); }} title="Select & Move (V)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
              </svg>
            </ToolButton>
            <div className="w-px h-6 bg-zinc-200 mx-1" />
            {/* Pen Freehand */}
            <ToolButton isActive={activeTool === 'pen' && !isPanMode} onClick={() => { setActiveTool('pen'); setIsPanMode(false); }} title="Freehand Draw (P)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </ToolButton>
            {/* Rectangle Shape */}
            <ToolButton isActive={activeTool === 'rect' && !isPanMode} onClick={() => { setActiveTool('rect'); setIsPanMode(false); }} title="Rectangle (R)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
              </svg>
            </ToolButton>
            {/* Circle Shape */}
            <ToolButton isActive={activeTool === 'circle' && !isPanMode} onClick={() => { setActiveTool('circle'); setIsPanMode(false); }} title="Circle (C)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="9" />
              </svg>
            </ToolButton>
            {/* Line Shape */}
            <ToolButton isActive={activeTool === 'line' && !isPanMode} onClick={() => { setActiveTool('line'); setIsPanMode(false); }} title="Line (L)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <line strokeLinecap="round" x1="5" y1="19" x2="19" y2="5" />
              </svg>
            </ToolButton>
            {/* Eraser Tool */}
            <ToolButton isActive={activeTool === 'eraser' && !isPanMode} onClick={() => { setActiveTool('eraser'); setIsPanMode(false); }} title="Eraser (E)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="m20 20-5-5" />
                <path d="M16 16 10 22 2 14 8 8 16 16z" />
                <path d="M17 11 13 7" />
              </svg>
            </ToolButton>
            <div className="w-px h-6 bg-zinc-200 mx-1" />
            {/* Pan Board Tool */}
            <ToolButton isActive={isPanMode} onClick={() => setIsPanMode(!isPanMode)} title="Pan Tool (Space)">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0-.552-.448-1-1-1s-1 .448-1 1v3.5l-1-1.25c-.328-.41-.9-.475-1.3-.15-.4.328-.475.9-.15 1.3l2.45 3.06c.3.38.77.6 1.26.6h3.48c.84 0 1.54-.62 1.63-1.45l.41-3.69c.04-.37-.08-.74-.32-1.02-.24-.28-.58-.44-.95-.44h-.5c-.552 0-1 .448-1 1V11z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 10.5V6a1.5 1.5 0 013 0v4.5M6 12V8a1.5 1.5 0 013 0v4M12 10.5V5a1.5 1.5 0 013 0v5.5M15 12V9a1.5 1.5 0 013 0v3" />
              </svg>
            </ToolButton>
            <div className="w-px h-6 bg-zinc-200 mx-1" />
            <button
              onClick={handleClearBoard}
              title="Clear Board"
              className="w-10 h-10 rounded-xl flex items-center justify-center text-red-500 hover:bg-red-50"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        </div>

        {/* 4. Left-Side Property & Action Panel */}
        <div className={`absolute left-4 top-1/2 -translate-y-1/2 flex items-center z-40 select-none transition-transform duration-300 ease-in-out ${isToolbarOpen ? 'translate-x-0' : '-translate-x-[calc(100%-36px)]'}`}>
          <div className="glass-panel-light p-2.5 rounded-2xl flex flex-col items-center gap-3 shadow-2xl border border-zinc-200/80 backdrop-blur-lg">
            {/* Color Properties */}
            {activeTool !== 'eraser' && (
              <div className="flex flex-col gap-1.5 p-1.5 bg-white/50 rounded-xl w-full">
                <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider text-center">Colors</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {colorsPalette.slice(0, 8).map((col) => (
                    <button
                      key={col}
                      onClick={() => setColor(col)}
                      className={`w-8 h-8 rounded-full border-2 transition-transform active:scale-95 flex items-center justify-center ${color === col ? 'border-blue-500 scale-110 shadow-sm' : 'border-black/5 hover:scale-105'}`}
                      style={{ backgroundColor: col }}
                    >
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Stroke Width */}
            <div className="flex flex-col gap-1.5 w-full items-center p-1.5 bg-white/50 rounded-xl">
              <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider text-center">Width</div>
              <div className="flex flex-col gap-2 w-full items-center">
                {strokeWidths.map((width) => (
                  <button
                    key={width}
                    onClick={() => setStrokeWidth(width)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${strokeWidth === width ? 'bg-zinc-200/80 border border-zinc-300 shadow-inner' : 'hover:bg-zinc-100'}`}
                  >
                    <div className="rounded-full bg-zinc-800" style={{ width: `${Math.min(16, width + 1)}px`, height: `${Math.min(16, width + 1)}px` }} />
                  </button>
                ))}
              </div>
            </div>

            <div className="w-10 h-px bg-zinc-200 my-1" />

            {/* Operations */}
            <div className="flex flex-col items-center gap-1.5 w-full">
              <button
                onClick={handleUndo} disabled={undoStack.length === 0} title="Undo (Cmd+Z)"
                className="w-10 h-10 rounded-xl flex items-center justify-center text-zinc-600 hover:bg-zinc-100 disabled:opacity-30"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
              </button>
              <button
                onClick={handleRedo} disabled={redoStack.length === 0} title="Redo (Cmd+Shift+Z)"
                className="w-10 h-10 rounded-xl flex items-center justify-center text-zinc-600 hover:bg-zinc-100 disabled:opacity-30"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a8 8 0 00-8 8v2m18-8l-6 6m6-6l-6-6" /></svg>
              </button>
            </div>
          </div>

          <button
            onClick={() => setIsToolbarOpen(!isToolbarOpen)}
            className="ml-2 glass-panel-light p-1.5 rounded-xl shadow-lg border border-zinc-200 text-zinc-500 hover:text-zinc-800 transition-all hover:bg-zinc-50 active:scale-95"
            title={isToolbarOpen ? "Hide Toolbar" : "Show Toolbar"}
          >
            <svg
              className={`w-5 h-5 transition-transform duration-300 ${isToolbarOpen ? '' : 'rotate-180'}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </div>

        {/* 6. Floating Zoom & Pan Controls */}
        <div className="absolute right-4 bottom-24 md:bottom-6 glass-panel-light p-2 rounded-xl flex items-center gap-2 shadow-lg border border-zinc-200 z-40 pointer-events-auto scale-[0.8] sm:scale-90 md:scale-100 origin-bottom-right transition-transform">
          <button
            onClick={handleZoomOut}
            title="Zoom Out"
            className="w-8 h-8 rounded-lg hover:bg-zinc-100 text-zinc-600 flex items-center justify-center font-bold text-lg"
          >
            -
          </button>
          <span className="text-[10px] font-bold text-zinc-500 w-12 text-center select-none uppercase tracking-wider">
            {Math.round(viewport.scale * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            title="Zoom In"
            className="w-8 h-8 rounded-lg hover:bg-zinc-100 text-zinc-600 flex items-center justify-center font-bold text-lg"
          >
            +
          </button>
          <div className="w-px h-5 bg-zinc-200 mx-1" />
          <button
            onClick={handleZoomReset}
            title="Reset Zoom"
            className="text-[10px] font-extrabold text-blue-600 hover:bg-blue-50 px-2.5 py-1.5 rounded-lg tracking-wider uppercase"
          >
            Reset
          </button>
        </div>

      </div>

      {/* 4. Room Info Top Bar Panel */}
      <div className="absolute top-6 md:top-4 left-4 right-4 flex items-center justify-between pointer-events-none z-50 pt-[env(safe-area-inset-top)]">

        {/* Room Title & User Identity Docks */}
        <div className="glass-panel-light py-1.5 px-3 rounded-xl flex items-center gap-3 shadow-lg pointer-events-auto border border-zinc-200/80">
          <div className="flex items-center gap-2 pr-3 border-r border-zinc-200/60">
            <div className="w-2 h-2 rounded-full bg-emerald-500 pulsing-dot"></div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-zinc-900 leading-tight max-w-[100px] sm:max-w-[150px] truncate">{roomName || 'Collaboration Board'}</span>
              <span className="text-[9px] text-zinc-500 tracking-wide uppercase font-semibold">Workspace</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold text-[10px] flex items-center justify-center shadow-sm shrink-0">
              {username ? username.charAt(0).toUpperCase() : '?'}
            </div>
            {isEditingName ? (
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  maxLength={15}
                  className="h-6 w-24 text-xs px-1 border-b border-blue-500 bg-transparent outline-none font-semibold text-zinc-800"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const newName = tempName.trim() || 'Guest';
                      setUsername(newName);
                      localStorage.setItem('visync_nickname', newName);
                      setIsEditingName(false);
                      if (wsRef.current) {
                        wsRef.current.send({
                          eventType: 'USER_NAME_CHANGE',
                          userId,
                          roomId,
                          timestamp: Date.now(),
                          payload: { username: newName }
                        });
                      }
                    }
                  }}
                />
                <button
                  onClick={() => {
                    const newName = tempName.trim() || 'Guest';
                    setUsername(newName);
                    localStorage.setItem('visync_nickname', newName);
                    setIsEditingName(false);
                    if (wsRef.current) {
                      wsRef.current.send({
                        eventType: 'USER_NAME_CHANGE',
                        userId,
                        roomId,
                        timestamp: Date.now(),
                        payload: { username: newName }
                      });
                    }
                  }}
                  className="text-emerald-600 hover:text-emerald-700"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 group cursor-pointer" onClick={() => {
                setTempName(username || '');
                setIsEditingName(true);
              }}>
                <span className="text-xs font-bold text-zinc-700 max-w-[80px] truncate">{username}</span>
                <svg className="w-3.5 h-3.5 shrink-0 text-zinc-400 group-hover:text-blue-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </div>
            )}

            <div className="w-px h-5 bg-zinc-200 mx-1" />

            {/* Dark Mode Toggle */}
            <button
              onClick={toggleDarkMode}
              title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
              className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${isDarkMode ? 'text-yellow-400 hover:bg-zinc-800' : 'text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100'}`}
            >
              {isDarkMode ? (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>

          </div>
        </div>

        {/* Collapsible Panel Toggle */}
        {!isSidebarOpen && (
          <button
            onClick={() => setIsSidebarOpen(true)}
            className="glass-panel-light p-2.5 rounded-xl shadow-lg pointer-events-auto text-zinc-700 hover:bg-zinc-100 border border-zinc-200"
          >
            <div className="flex items-center gap-1.5">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path d="M15 19l-7-7 7-7" /></svg>
              <span className="text-xs font-bold tracking-wide uppercase pr-1">Open Chat</span>
            </div>
          </button>
        )}
      </div>

      {/* 5. Isolated Accessory Sidebar (Prevents drawing panel re-renders) */}
      <AccessorySidebar
        isSidebarOpen={isSidebarOpen}
        setIsSidebarOpen={setIsSidebarOpen}
        userId={userId}
        roomName={roomName}
        roomId={roomId}
        copiedLink={copiedLink}
        copyInviteLink={copyInviteLink}
        copiedCode={copiedCode}
        copyRoomCode={copyRoomCode}
        chatInput={chatInput}
        setChatInput={setChatInput}
        handleSendChat={handleSendChat}
        chatBottomRef={chatBottomRef}
      />
    </div>
  );
}

// =========================================================================
// Subcomponent: CollaborativeCursors
// =========================================================================

interface CollaborativeCursorsProps {
  userId: string;
  viewport: Viewport;
}

/**
 * Renders floating collaborative cursor overlays.
 * Cursor positions are stored in world coordinates and converted to screen
 * using worldToScreen() for accurate positioning at any zoom/pan level.
 */
function CollaborativeCursors({ userId, viewport }: CollaborativeCursorsProps) {
  const cursors = useStore((state) => state.cursors);

  return (
    <>
      {Object.entries(cursors).map(([cUserId, state]) => {
        if (cUserId === userId) return null;

        // Convert world coordinates to screen position
        const screenPos = worldToScreen(state.x, state.y, viewport);

        return (
          <div
            key={cUserId}
            className="absolute pointer-events-none z-40 transition-all duration-75 ease-out select-none"
            style={{
              left: `${screenPos.x}px`,
              top: `${screenPos.y}px`
            }}
          >
            <svg className="w-5 h-5 text-blue-500 fill-current drop-shadow-md" viewBox="0 0 24 24">
              <path d="M4 4l11.733 11.733H9.6L4 21.333V4z" stroke="white" strokeWidth="2" strokeLinejoin="round" />
            </svg>
            <div className="ml-4 -mt-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-medium text-[10px] py-0.5 px-2 rounded-full shadow-md whitespace-nowrap tracking-wide border border-white/20">
              {state.username}
            </div>
          </div>
        );
      })}
    </>
  );
}

// =========================================================================
// Subcomponent: AccessorySidebar (Chat + Collaborators)
// =========================================================================

interface AccessorySidebarProps {
  isSidebarOpen: boolean;
  setIsSidebarOpen: (open: boolean) => void;
  userId: string;
  roomName: string | null;
  roomId: string;
  copiedLink: boolean;
  copyInviteLink: () => void;
  copiedCode: boolean;
  copyRoomCode: () => void;
  chatInput: string;
  setChatInput: (val: string) => void;
  handleSendChat: (e: React.FormEvent) => void;
  chatBottomRef: React.RefObject<HTMLDivElement | null>;
}

function AccessorySidebar({
  isSidebarOpen,
  setIsSidebarOpen,
  userId,
  roomName,
  roomId,
  copiedLink,
  copyInviteLink,
  copiedCode,
  copyRoomCode,
  chatInput,
  setChatInput,
  handleSendChat,
  chatBottomRef
}: AccessorySidebarProps) {
  const activeUsers = useStore((state) => state.activeUsers);
  const messages = useStore((state) => state.messages);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSidebarOpen, chatBottomRef]);

  return (
    <div
      className={`h-[100dvh] border-l border-zinc-200 bg-white flex flex-col z-40 transition-all duration-300 ease-in-out shadow-2xl absolute md:relative right-0 top-0 pt-14 md:pt-0 ${isSidebarOpen ? 'w-80 max-w-[85vw]' : 'w-0 border-l-0 opacity-0 pointer-events-none'
        }`}
    >
      <div className="p-4 border-b border-zinc-150 flex flex-col gap-3">
        <div className="flex justify-between items-center w-full">
          <h3 className="font-extrabold text-sm text-zinc-800 tracking-wide uppercase">Collaborators</h3>
          <button
            onClick={() => setIsSidebarOpen(false)}
            title="Close Chat"
            className="text-zinc-400 hover:text-zinc-600 transition-colors p-1 rounded-lg hover:bg-zinc-100 cursor-pointer"
          >
            <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-wrap gap-2">
          {activeUsers.map((user) => {
            const initial = user.username ? user.username.charAt(0).toUpperCase() : '?';
            return (
              <div
                key={user.userId}
                title={user.username}
                className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-600 text-white font-bold text-xs flex items-center justify-center shadow-sm relative border border-white"
              >
                {initial}
                <div className="absolute bottom-0 right-0 w-2 h-2 rounded-full bg-emerald-500 border border-white"></div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-col gap-1.5 mt-2 bg-zinc-50 p-2 rounded-xl border border-zinc-150">
          <div className="flex justify-between items-center text-[10px] font-bold text-zinc-500 tracking-wide uppercase">
            <span>Invite Link</span>
            <button
              onClick={copyInviteLink}
              className="text-blue-600 hover:text-blue-500 cursor-pointer"
            >
              {copiedLink ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
          <div className="flex justify-between items-center text-[10px] font-bold text-zinc-500 tracking-wide uppercase mt-1 pt-1.5 border-t border-zinc-200/60">
            <span>Room Code</span>
            <button
              onClick={copyRoomCode}
              className="text-blue-600 hover:text-blue-500 cursor-pointer"
            >
              {copiedCode ? 'Copied!' : 'Copy Code'}
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden bg-zinc-50/50">
        <div className="p-3 bg-zinc-50 border-b border-zinc-200">
          <h3 className="font-extrabold text-xs text-zinc-600 tracking-wider uppercase">Live Room Chat</h3>
        </div>

        <div className="flex-1 p-4 overflow-y-auto space-y-3.5 select-text">
          {messages.map((msg, index) => {
            const isSystem = msg.senderId === 'system';
            const isSelf = msg.senderId === userId;

            if (isSystem) {
              return (
                <div key={index} className="text-center">
                  <span className="inline-block bg-zinc-100 text-zinc-500 text-[10px] py-1 px-3 rounded-full border border-zinc-200/50 font-medium">
                    {msg.message}
                  </span>
                </div>
              );
            }

            return (
              <div
                key={index}
                className={`flex flex-col max-w-[85%] ${isSelf ? 'ml-auto items-end' : 'mr-auto items-start'
                  }`}
              >
                <span className="text-[10px] font-semibold text-zinc-500 mb-1 px-1">{msg.senderName}</span>
                <div
                  className={`p-3 rounded-2xl text-xs leading-relaxed ${isSelf
                    ? 'bg-blue-600 text-white rounded-tr-none shadow-md shadow-blue-500/10'
                    : 'bg-white text-zinc-800 border border-zinc-200 rounded-tl-none shadow-sm'
                    }`}
                >
                  {msg.message}
                </div>
              </div>
            );
          })}
          <div ref={chatBottomRef} />
        </div>

        <form onSubmit={handleSendChat} className="p-3 bg-white border-t border-zinc-200 flex gap-2">
          <input
            type="text"
            placeholder="Type your message..."
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            className="flex-1 h-9 px-3 text-xs bg-zinc-50 border border-zinc-200 rounded-lg outline-none focus:border-blue-500 focus:bg-white transition-all select-text"
          />
          <button
            type="submit"
            className="h-9 w-9 rounded-lg bg-blue-600 hover:bg-blue-500 text-white flex items-center justify-center shrink-0 transition-colors shadow-md shadow-blue-500/10"
          >
            <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
