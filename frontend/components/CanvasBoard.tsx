'use client';

import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { Stage, Layer, Line as KonvaLine, Rect as KonvaRect, Circle as KonvaCircle } from 'react-konva';
import Konva from 'konva';
import axios from 'axios';
import { useStore, Stroke, Point } from '@/lib/useStore';
import { WebSocketClient } from '@/lib/ws';
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
// Main Component
// ---------------------------------------------------------------------------

export default function CanvasBoard({ roomId, userId }: { roomId: string; userId: string }) {
  const stageRef = useRef<Konva.Stage>(null);
  
  // ---- Zustand selections (fine-grained selectors) ----
  const activeTool = useStore((state) => state.activeTool);
  const color = useStore((state) => state.color);
  const strokeWidth = useStore((state) => state.strokeWidth);
  const username = useStore((state) => state.username);
  const roomName = useStore((state) => state.roomName);
  const strokes = useStore((state) => state.strokes);
  const undoStack = useStore((state) => state.undoStack);
  const redoStack = useStore((state) => state.redoStack);
  const viewport = useStore((state) => state.viewport);
  const showGrid = useStore((state) => state.showGrid);

  const setRoomName = useStore((state) => state.setRoomName);
  const setActiveTool = useStore((state) => state.setActiveTool);
  const setColor = useStore((state) => state.setColor);
  const setStrokeWidth = useStore((state) => state.setStrokeWidth);
  const setStrokes = useStore((state) => state.setStrokes);
  const addStroke = useStore((state) => state.addStroke);
  const updateLastStrokePoints = useStore((state) => state.updateLastStrokePoints);
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

  // 2. Keyboard listeners for Space-key panning
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focused on an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        setIsSpacePanning(true);
        isSpacePanningRef.current = true;
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePanning(false);
        isSpacePanningRef.current = false;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

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

    // Left click in draw mode → start drawing (allow touch events where button is undefined)
    if (e.evt.button !== undefined && e.evt.button !== 0) return;

    setIsDrawing(true);

    // Convert screen position to world coordinates
    const worldPos = screenToWorld(pos.x, pos.y, currentViewport);

    const strokeId = `${userId}-${Date.now()}`;
    currentStrokeIdRef.current = strokeId;

    const newStroke: Stroke = {
      id: strokeId,
      userId,
      color: activeTool === 'eraser' ? '#ffffff' : color,
      strokeWidth: activeTool === 'eraser' ? 24 : strokeWidth,
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
  }, [historyLoading, isPanMode, userId, activeTool, color, strokeWidth, roomId, addStroke, setViewport]);

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

    if (!isDrawing || !currentStrokeIdRef.current) return;

    // Distance-based throttle for pen/eraser to avoid excessive points
    if (activeTool === 'pen' || activeTool === 'eraser') {
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
  }, [isDrawing, isMiddlePanning, isPanMode, userId, roomId, username, activeTool, updateLastStrokePoints, setViewport]);

  /**
   * Handle mouse up — finish drawing or finish panning.
   */
  const handleMouseUp = useCallback(() => {
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
      if (activeTool === 'pen' || activeTool === 'eraser') {
        // Simplify path — tolerance in world pixels
        const simplifiedPoints = simplifyPath(activeStroke.points, 1);
        activeStroke.points = simplifiedPoints;
        setStrokes((prev: Stroke[]) =>
          prev.map((s) => (s.id === activeStroke.id ? { ...s, points: simplifiedPoints } : s))
        );
      }

      pushToUndo(activeStroke);

      if (activeTool !== 'pen' && activeTool !== 'eraser') {
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
        payload: { strokeId: currentStrokeIdRef.current }
      });
    }

    currentStrokeIdRef.current = null;
  }, [isDrawing, isMiddlePanning, isPanMode, activeTool, userId, roomId, setStrokes, pushToUndo]);

  // ===================================================================
  // Undo / Redo / Clear / Export / Chat Actions
  // ===================================================================

  const handleUndo = () => {
    const popped = popFromUndo();
    if (!popped) return;

    pushToRedo(popped);
    setStrokes((prev: Stroke[]) => prev.filter((s) => s.id !== popped.id));

    wsRef.current?.send({
      eventType: 'UNDO',
      userId,
      roomId,
      timestamp: Date.now(),
      payload: { strokeId: popped.id }
    });
  };

  const handleRedo = () => {
    const popped = popFromRedo();
    if (!popped) return;

    pushToUndo(popped);
    addStroke(popped);

    wsRef.current?.send({
      eventType: 'REDO',
      userId,
      roomId,
      timestamp: Date.now(),
      payload: { stroke: popped }
    });
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
    <div className="w-full h-[100dvh] bg-[#fafafa] flex overflow-hidden relative select-none">
      
      {/* 1. Interactive Whiteboard Canvas Stage Layer */}
      <div className="flex-1 h-[100dvh] relative bg-[#fafafa]">
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
          onMouseLeave={handleMouseUp}
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
          <Layer>
            {strokes.map((stroke) => {
              const pointsArr = stroke.points.flatMap((p) => [p.x, p.y]);

              if (pointsArr.length === 0) return null;

              if (stroke.tool === 'pen' || stroke.tool === 'eraser') {
                return (
                  <KonvaLine
                    key={stroke.id}
                    points={pointsArr}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                    lineCap="round"
                    lineJoin="round"
                    tension={0.5}
                  />
                );
              } else if (stroke.tool === 'line') {
                const p2 = stroke.points[1] || stroke.points[0];
                return (
                  <KonvaLine
                    key={stroke.id}
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
                  <KonvaRect
                    key={stroke.id}
                    x={x}
                    y={y}
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
                  <KonvaCircle
                    key={stroke.id}
                    x={p1.x}
                    y={p1.y}
                    radius={r}
                    stroke={stroke.color}
                    strokeWidth={stroke.strokeWidth}
                  />
                );
              }
              return null;
            })}
          </Layer>
        </Stage>

        {/* 2. Floating Collaborative Cursor Overlays */}
        <CollaborativeCursors userId={userId} viewport={viewport} />

        {/* 3. Floating Responsive Premium Canvas Tool Dock */}
        <div className={`absolute left-0 top-1/2 -translate-y-1/2 flex items-center z-40 select-none transition-transform duration-300 ease-in-out ${isToolbarOpen ? 'translate-x-0' : '-translate-x-[calc(100%-40px)]'}`}>
          <div className="flex flex-col items-center gap-4 max-h-[85vh] pl-4 md:pl-6">
            <div className="glass-panel-light p-2 md:p-2.5 rounded-2xl flex flex-col items-center shadow-2xl border border-zinc-200/80 backdrop-blur-lg relative">
            
            {/* Scroll Up Arrow */}
            {canScrollUp || canScrollDown ? (
              <button
                onClick={() => scrollTools('up')}
                title="Scroll Up"
                className={`w-10 h-6 flex items-center justify-center text-blue-600 hover:text-blue-800 transition-all hover:bg-zinc-100 rounded-lg cursor-pointer mb-1 shrink-0 active:scale-95 ${
                  canScrollUp ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                }`}
              >
                <svg className="w-5 h-5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                </svg>
              </button>
            ) : null}

            {/* Scrollable Tools Button Wrapper */}
            <div
              ref={toolScrollRef}
              onScroll={checkScroll}
              className="flex flex-col items-center gap-2 overflow-y-auto no-scrollbar py-1.5 max-h-[45vh] md:max-h-[60vh] scroll-smooth w-full"
              style={{
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
                WebkitOverflowScrolling: 'touch'
              }}
            >
              {/* Pen Freehand */}
              <button
                onClick={() => { setActiveTool('pen'); setIsPanMode(false); }}
                title="Freehand Draw"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  activeTool === 'pen' && !isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                </svg>
              </button>

              {/* Line Shape */}
              <button
                onClick={() => { setActiveTool('line'); setIsPanMode(false); }}
                title="Draw Line"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  activeTool === 'line' && !isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <line strokeLinecap="round" x1="5" y1="19" x2="19" y2="5" />
                </svg>
              </button>

              {/* Rectangle Shape */}
              <button
                onClick={() => { setActiveTool('rect'); setIsPanMode(false); }}
                title="Draw Rectangle"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  activeTool === 'rect' && !isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                </svg>
              </button>

              {/* Circle Shape */}
              <button
                onClick={() => { setActiveTool('circle'); setIsPanMode(false); }}
                title="Draw Circle"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  activeTool === 'circle' && !isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </button>

              {/* Eraser Tool */}
              <button
                onClick={() => { setActiveTool('eraser'); setIsPanMode(false); }}
                title="Eraser"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  activeTool === 'eraser' && !isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m20 20-5-5" />
                  <path d="M16 16 10 22 2 14 8 8 16 16z" />
                  <path d="M17 11 13 7" />
                </svg>
              </button>

              {/* Pan Board Tool */}
              <button
                onClick={() => setIsPanMode(!isPanMode)}
                title="Pan / Grab Board"
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  isPanMode ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 11c0-.552-.448-1-1-1s-1 .448-1 1v3.5l-1-1.25c-.328-.41-.9-.475-1.3-.15-.4.328-.475.9-.15 1.3l2.45 3.06c.3.38.77.6 1.26.6h3.48c.84 0 1.54-.62 1.63-1.45l.41-3.69c.04-.37-.08-.74-.32-1.02-.24-.28-.58-.44-.95-.44h-.5c-.552 0-1 .448-1 1V11z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 10.5V6a1.5 1.5 0 013 0v4.5M6 12V8a1.5 1.5 0 013 0v4M12 10.5V5a1.5 1.5 0 013 0v5.5M15 12V9a1.5 1.5 0 013 0v3" />
                </svg>
              </button>

              {/* Toggle Grid */}
              <button
                onClick={toggleGrid}
                title={showGrid ? 'Hide Grid' : 'Show Grid'}
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all duration-200 ${
                  showGrid ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20 scale-105' : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-800'
                }`}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h7v7H3V3zm11 0h7v7h-7V3zm-11 11h7v7H3v-7zm11 0h7v7h-7v-7z" />
                </svg>
              </button>

            </div>

            {/* Scroll Down Arrow */}
            {canScrollUp || canScrollDown ? (
              <button
                onClick={() => scrollTools('down')}
                title="Scroll Down"
                className={`w-10 h-6 flex items-center justify-center text-blue-600 hover:text-blue-800 transition-all hover:bg-zinc-100 rounded-lg cursor-pointer mt-1 shrink-0 active:scale-95 ${
                  canScrollDown ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                }`}
              >
                <svg className="w-5 h-5 animate-bounce" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            ) : null}

            <div className="w-8 h-px bg-zinc-200 my-1 shrink-0" />

            {/* Combined Config / Operations */}
            <div className="flex flex-col items-center gap-2 relative">
              {/* Color Picker Toggle */}
              {activeTool !== 'eraser' && (
                <div className="relative">
                  <button
                    onClick={() => {
                      setIsColorPickerOpen(!isColorPickerOpen);
                      setIsWidthPickerOpen(false);
                    }}
                    title="Select Color"
                    className="w-8 h-8 rounded-full border border-zinc-300 shadow-sm flex items-center justify-center transition-transform hover:scale-105 active:scale-95 shrink-0"
                    style={{ backgroundColor: color }}
                  >
                    <span className="sr-only">Color</span>
                  </button>
                  {isColorPickerOpen && (
                    <div className="absolute left-12 top-1/2 -translate-y-1/2 glass-panel-light p-2 rounded-xl shadow-2xl border border-zinc-200 z-50 min-w-[120px] flex justify-center bg-white/95">
                      <div className="grid grid-cols-4 gap-1.5">
                        {colorsPalette.map((col) => (
                          <button
                            key={col}
                            onClick={() => {
                              setColor(col);
                              setIsColorPickerOpen(false);
                            }}
                            className="w-6 h-6 rounded-full border border-black/15 transition-transform active:scale-95 flex items-center justify-center"
                            style={{ backgroundColor: col }}
                          >
                            {color === col && (
                              <span className={`w-1.5 h-1.5 rounded-full ${col === '#ffffff' ? 'bg-black' : 'bg-white'}`} />
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Stroke Width Toggle */}
              <div className="relative">
                <button
                  onClick={() => {
                    setIsWidthPickerOpen(!isWidthPickerOpen);
                    setIsColorPickerOpen(false);
                  }}
                  title="Select Size"
                  className="w-8 h-8 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-700 font-bold border border-zinc-300 flex items-center justify-center transition-transform active:scale-95 shrink-0"
                >
                  <div className="rounded-full bg-zinc-800" style={{ width: `${Math.min(12, strokeWidth)}px`, height: `${Math.min(12, strokeWidth)}px` }} />
                </button>
                {isWidthPickerOpen && (
                  <div className="absolute left-12 top-1/2 -translate-y-1/2 glass-panel-light p-2 rounded-xl shadow-2xl border border-zinc-200 z-50 flex flex-col gap-1.5 items-center bg-white/95 min-w-[40px]">
                    {strokeWidths.map((width) => (
                      <button
                        key={width}
                        onClick={() => {
                          setStrokeWidth(width);
                          setIsWidthPickerOpen(false);
                        }}
                        className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                          strokeWidth === width ? 'bg-zinc-200/80 border border-zinc-300' : 'hover:bg-zinc-100'
                        }`}
                      >
                        <div className="rounded-full bg-zinc-800" style={{ width: `${Math.min(16, width + 1)}px`, height: `${Math.min(16, width + 1)}px` }} />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="w-8 h-px bg-zinc-200 my-1 shrink-0" />

              {/* Operations: Undo, Redo, Export, Clear */}
              <div className="flex flex-col items-center gap-1.5">
                <button
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                  title="Undo"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                  </svg>
                </button>
                <button
                  onClick={handleRedo}
                  disabled={redoStack.length === 0}
                  title="Redo"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:bg-zinc-100 disabled:opacity-30 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a8 8 0 00-8 8v2m18-8l-6 6m6-6l-6-6" />
                  </svg>
                </button>
                <button
                  onClick={handleExportPNG}
                  title="Export PNG"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-600 hover:bg-zinc-100 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </button>
                <button
                  onClick={handleClearBoard}
                  title="Clear Board"
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-red-500 hover:bg-red-50 shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
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
        
        {/* Room Title Docks */}
        <div className="glass-panel-light py-2 px-4 rounded-xl flex items-center gap-3 shadow-lg pointer-events-auto border border-zinc-200/80">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 pulsing-dot"></div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-zinc-900 leading-tight">{roomName || 'Collaboration Board'}</span>
            <span className="text-[10px] text-zinc-500 tracking-wide uppercase font-semibold">Active Workspace</span>
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
      className={`h-[100dvh] border-l border-zinc-200 bg-white flex flex-col z-40 transition-all duration-300 ease-in-out shadow-2xl absolute md:relative right-0 top-0 pt-14 md:pt-0 ${
        isSidebarOpen ? 'w-80 max-w-[85vw]' : 'w-0 border-l-0 opacity-0 pointer-events-none'
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
                className={`flex flex-col max-w-[85%] ${
                  isSelf ? 'ml-auto items-end' : 'mr-auto items-start'
                }`}
              >
                <span className="text-[10px] font-semibold text-zinc-500 mb-1 px-1">{msg.senderName}</span>
                <div
                  className={`p-3 rounded-2xl text-xs leading-relaxed ${
                    isSelf
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
