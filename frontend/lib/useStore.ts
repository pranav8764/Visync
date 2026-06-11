import { create } from 'zustand';
import { Viewport, createDefaultViewport } from './viewport';

export interface Point {
  x: number;
  y: number;
}

export interface Stroke {
  id: string;
  userId: string;
  points: Point[];
  color: string;
  strokeWidth: number;
  tool: 'pen' | 'line' | 'rect' | 'circle' | 'eraser' | 'select';
  
  // Transform & Style Properties
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  fill?: string;
  opacity?: number;
  isDeleted?: boolean;
}

export interface UserPresence {
  userId: string;
  username: string;
}

export interface ChatMsg {
  id?: string;
  senderId: string;
  senderName: string;
  message: string;
  timestamp: number;
}

export interface CursorState {
  username: string;
  x: number;
  y: number;
}

interface VisyncState {
  // Global App State
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  setDarkMode: (isDark: boolean) => void;

  // Whiteboard configuration
  activeTool: 'pen' | 'line' | 'rect' | 'circle' | 'eraser' | 'select';
  color: string;
  fillColor: string; // Used for shape fills
  opacity: number;
  strokeWidth: number;
  setActiveTool: (tool: 'pen' | 'line' | 'rect' | 'circle' | 'eraser' | 'select') => void;
  setColor: (color: string) => void;
  setFillColor: (color: string) => void;
  setOpacity: (opacity: number) => void;
  setStrokeWidth: (width: number) => void;

  // Viewport state for infinite canvas
  viewport: Viewport;
  setViewport: (viewport: Viewport) => void;
  showGrid: boolean;
  setShowGrid: (show: boolean) => void;
  toggleGrid: () => void;

  // Session information
  roomId: string | null;
  userId: string | null;
  username: string | null;
  roomName: string | null;
  activeUsers: UserPresence[];
  setRoomId: (id: string | null) => void;
  setUserId: (id: string | null) => void;
  setUsername: (name: string | null) => void;
  setRoomName: (name: string | null) => void;
  setActiveUsers: (users: UserPresence[]) => void;
  addUserPresence: (user: UserPresence) => void;
  removeUserPresence: (userId: string) => void;
  updateUserPresenceName: (userId: string, username: string) => void;

  // Strokes / Drawings (points stored in world coordinates)
  strokes: Stroke[];
  undoStack: Stroke[][];
  redoStack: Stroke[][];
  selectedIds: string[];
  
  setStrokes: (strokes: Stroke[] | ((prev: Stroke[]) => Stroke[])) => void;
  addStroke: (stroke: Stroke) => void;
  updateLastStrokePoints: (strokeId: string, point: Point) => void;
  updateStrokeTransform: (strokeId: string, transform: Partial<Stroke>) => void;
  setSelectedIds: (ids: string[]) => void;
  clearStrokes: () => void;
  
  // Undo/Redo operations
  pushToUndo: (strokes: Stroke | Stroke[]) => void;
  popFromUndo: () => Stroke[] | undefined;
  pushToRedo: (strokes: Stroke | Stroke[]) => void;
  popFromRedo: () => Stroke[] | undefined;
  clearUndoRedo: () => void;

  // Cursors (positions stored in world coordinates)
  cursors: { [userId: string]: CursorState };
  updateCursor: (userId: string, username: string, x: number, y: number) => void;
  removeCursor: (userId: string) => void;

  // Chat messages
  messages: ChatMsg[];
  setMessages: (messages: ChatMsg[]) => void;
  addMessage: (msg: ChatMsg) => void;
}

export const useStore = create<VisyncState>((set, get) => ({
  // Defaults
  isDarkMode: false,
  activeTool: 'pen',
  color: '#2563eb', // Modern Premium Royal Blue
  fillColor: 'transparent',
  opacity: 1,
  strokeWidth: 3,
  roomId: null,
  userId: null,
  username: null,
  roomName: null,
  activeUsers: [],
  strokes: [],
  undoStack: [],
  redoStack: [],
  selectedIds: [],
  cursors: {},
  messages: [],

  // Viewport defaults — centered on origin at 100% zoom
  viewport: createDefaultViewport(
    typeof window !== 'undefined' ? window.innerWidth : 1920,
    typeof window !== 'undefined' ? window.innerHeight : 1080
  ),
  showGrid: true,

  // Global App setters
  toggleDarkMode: () => set((state) => ({ isDarkMode: !state.isDarkMode })),
  setDarkMode: (isDark) => set({ isDarkMode: isDark }),

  // Whiteboard configuration setters
  setActiveTool: (tool) => set({ activeTool: tool, selectedIds: tool === 'select' ? get().selectedIds : [] }),
  setColor: (color) => set({ color }),
  setFillColor: (fillColor) => set({ fillColor }),
  setOpacity: (opacity) => set({ opacity }),
  setStrokeWidth: (strokeWidth) => set({ strokeWidth }),

  // Viewport setters
  setViewport: (viewport) => set({ viewport }),
  setShowGrid: (showGrid) => set({ showGrid }),
  toggleGrid: () => set((state) => ({ showGrid: !state.showGrid })),

  // Session information setters
  setRoomId: (roomId) => set({ roomId }),
  setUserId: (userId) => set({ userId }),
  setUsername: (username) => set({ username }),
  setRoomName: (roomName) => set({ roomName }),
  setActiveUsers: (activeUsers) => set(() => {
    const uniqueUsers = activeUsers.filter((user, index, self) =>
      self.findIndex((u) => u.userId === user.userId) === index
    );
    return { activeUsers: uniqueUsers };
  }),
  
  addUserPresence: (user) => set((state) => {
    if (state.activeUsers.some((u) => u.userId === user.userId)) return {};
    return { activeUsers: [...state.activeUsers, user] };
  }),
  
  removeUserPresence: (userId) => set((state) => ({
    activeUsers: state.activeUsers.filter((u) => u.userId !== userId)
  })),

  updateUserPresenceName: (userId, username) => set((state) => ({
    activeUsers: state.activeUsers.map((u) => 
      u.userId === userId ? { ...u, username } : u
    )
  })),

  // Strokes / Drawing mutations (world coordinates)
  setStrokes: (strokesUpdate) => set((state) => ({
    strokes: typeof strokesUpdate === 'function' ? strokesUpdate(state.strokes) : strokesUpdate
  })),

  addStroke: (stroke) => set((state) => ({
    strokes: [...state.strokes, stroke],
    redoStack: [] // Clear redo stack on new action
  })),

  updateLastStrokePoints: (strokeId, point) => set((state) => ({
    strokes: state.strokes.map((s) => {
      if (s.id !== strokeId) return s;
      if (s.tool === 'pen' || s.tool === 'eraser') {
        return { ...s, points: [...s.points, point] };
      } else {
        // For shapes (line, rect, circle), points[0] is start, points[1] is the dragging/ending point
        return { ...s, points: [s.points[0], point] };
      }
    })
  })),

  updateStrokeTransform: (strokeId, transform) => set((state) => ({
    strokes: state.strokes.map((s) => 
      s.id === strokeId ? { ...s, ...transform } : s
    )
  })),

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  clearStrokes: () => set({ strokes: [], undoStack: [], redoStack: [], selectedIds: [] }),

  // Undo/Redo stacks
  pushToUndo: (strokes) => set((state) => ({
    undoStack: [...state.undoStack, Array.isArray(strokes) ? strokes : [strokes]]
  })),
  
  popFromUndo: () => {
    const { undoStack } = get();
    if (undoStack.length === 0) return undefined;
    const last = undoStack[undoStack.length - 1];
    set({ undoStack: undoStack.slice(0, -1) });
    return last;
  },

  pushToRedo: (strokes) => set((state) => ({
    redoStack: [...state.redoStack, Array.isArray(strokes) ? strokes : [strokes]]
  })),
  
  popFromRedo: () => {
    const { redoStack } = get();
    if (redoStack.length === 0) return undefined;
    const last = redoStack[redoStack.length - 1];
    set({ redoStack: redoStack.slice(0, -1) });
    return last;
  },

  clearUndoRedo: () => set({ undoStack: [], redoStack: [] }),

  // Real-time cursors (world coordinates)
  updateCursor: (userId, username, x, y) => set((state) => ({
    cursors: {
      ...state.cursors,
      [userId]: { username, x, y }
    }
  })),

  removeCursor: (userId) => set((state) => {
    const newCursors = { ...state.cursors };
    delete newCursors[userId];
    return { cursors: newCursors };
  }),

  // Chat message mutations
  setMessages: (messages) => set({ messages }),
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] }))
}));
