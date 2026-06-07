import SockJS from 'sockjs-client';
import { useStore, Stroke, ChatMsg } from './useStore';

export interface DrawEvent {
  eventType:
    | 'USER_JOIN'
    | 'USER_LEAVE'
    | 'PRESENCE_LIST'
    | 'DRAW_START'
    | 'DRAW_MOVE'
    | 'DRAW_END'
    | 'CURSOR_MOVE'
    | 'CHAT_MESSAGE'
    | 'BOARD_CLEAR'
    | 'UNDO'
    | 'REDO';
  userId: string;
  roomId: string;
  timestamp: number;
  payload: any;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private roomId: string;
  private userId: string;
  private token: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1500;
  private listeners: { [key: string]: Function[] } = {};
  
  private explicitlyClosed = false;
  private connectPromise: Promise<void> | null = null;
  private resolveConnect: (() => void) | null = null;
  private rejectConnect: ((reason?: any) => void) | null = null;

  constructor(roomId: string, userId: string, token: string) {
    this.roomId = roomId;
    this.userId = userId;
    this.token = token;
  }

  connect(): Promise<void> {
    if (this.connectPromise) {
      // If a connection is already in progress (including a retry), reuse it
      this.initiateSocket();
      return this.connectPromise;
    }

    this.explicitlyClosed = false;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
      this.initiateSocket();
    });

    return this.connectPromise;
  }

  private initiateSocket(): void {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8080';
    const httpUrl = baseUrl.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
    const sockUrl = `${httpUrl}/ws/rooms?token=${encodeURIComponent(this.token)}`;
    console.log('Connecting to SockJS endpoint:', sockUrl);

    const sock = new SockJS(sockUrl);

    sock.onopen = () => {
      console.log('WebSocket successfully opened connection');
      this.reconnectAttempts = 0;
      
      // Dispatch USER_JOIN as soon as connection completes
      const username = useStore.getState().username || 'Guest';
      this.send({
        eventType: 'USER_JOIN',
        userId: this.userId,
        roomId: this.roomId,
        timestamp: Date.now(),
        payload: { username }
      });

      if (this.resolveConnect) {
        this.resolveConnect();
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectPromise = null;
      }
    };

    sock.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as DrawEvent;
        this.handleIncomingEvent(data);
        this.emit(data.eventType, data);
      } catch (e) {
        console.error('Failed to parse WS message:', e);
      }
    };

    sock.onerror = (event) => {
      // Do not reject/print severe error if we still have reconnect attempts remaining.
      // This handles transient cold start database wake-up failures gracefully.
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        console.error('WebSocket maximum reconnection attempts reached:', event);
        if (this.rejectConnect) {
          this.rejectConnect(event);
          this.resolveConnect = null;
          this.rejectConnect = null;
          this.connectPromise = null;
        }
      } else {
        console.warn('WebSocket transient connection error detected. Automatic reconnect will trigger.');
      }
    };

    sock.onclose = () => {
      console.log('WebSocket connection closed');
      if (!this.explicitlyClosed) {
        this.attemptReconnect();
      }
    };

    this.ws = sock as any;
  }

  private handleIncomingEvent(event: DrawEvent) {
    const { eventType, userId, timestamp, payload } = event;
    const store = useStore.getState();

    switch (eventType) {
      case 'USER_JOIN': {
        const username = payload.username || 'Guest';
        store.addUserPresence({ userId, username });
        store.addMessage({
          senderId: 'system',
          senderName: 'System',
          message: `${username} joined the collaboration room.`,
          timestamp
        });
        break;
      }
      case 'USER_LEAVE': {
        const username = payload.username || 'Guest';
        store.removeUserPresence(userId);
        store.removeCursor(userId);
        store.addMessage({
          senderId: 'system',
          senderName: 'System',
          message: `${username} left the room.`,
          timestamp
        });
        break;
      }
      case 'PRESENCE_LIST': {
        if (Array.isArray(payload)) {
          store.setActiveUsers(payload);
        }
        break;
      }
      case 'CURSOR_MOVE': {
        store.updateCursor(userId, payload.username, payload.x, payload.y);
        break;
      }
      case 'DRAW_START': {
        const { strokeId, color, strokeWidth, tool, point } = payload;
        store.setStrokes((prev) => {
          if (prev.some((s) => s.id === strokeId)) return prev;
          return [
            ...prev,
            {
              id: strokeId,
              userId,
              points: point ? [point] : [],
              color,
              strokeWidth,
              tool
            }
          ];
        });
        break;
      }
      case 'DRAW_MOVE': {
        const { strokeId, point } = payload;
        store.updateLastStrokePoints(strokeId, point);
        break;
      }
      case 'DRAW_END':
        // Optional tracking logs
        break;
      case 'CHAT_MESSAGE': {
        const msg: ChatMsg = {
          senderId: userId,
          senderName: payload.senderName || 'Anonymous',
          message: payload.message || '',
          timestamp
        };
        store.addMessage(msg);
        break;
      }
      case 'BOARD_CLEAR': {
        store.clearStrokes();
        store.addMessage({
          senderId: 'system',
          senderName: 'System',
          message: `The canvas has been cleared by a participant.`,
          timestamp
        });
        break;
      }
      case 'UNDO': {
        const { strokeId } = payload;
        store.setStrokes((prev) => {
          const target = prev.find((s) => s.id === strokeId);
          if (target) {
            // Logically track remote undoes
            console.log(`Remote undo for stroke: ${strokeId}`);
          }
          return prev.filter((s) => s.id !== strokeId);
        });
        break;
      }
      case 'REDO': {
        const { stroke } = payload;
        store.setStrokes((prev) => {
          if (prev.some((s) => s.id === stroke.id)) return prev;
          return [...prev, stroke];
        });
        break;
      }
    }
  }

  send(event: DrawEvent): void {
    if (this.ws && this.ws.readyState === 1) { // 1 = OPEN
      this.ws.send(JSON.stringify(event));
    } else {
      console.warn('WebSocket message unsent: Connection not open');
    }
  }

  on(eventType: string, callback: Function): void {
    if (!this.listeners[eventType]) {
      this.listeners[eventType] = [];
    }
    this.listeners[eventType].push(callback);
  }

  private emit(eventType: string, data: any): void {
    if (this.listeners[eventType]) {
      this.listeners[eventType].forEach((cb) => cb(data));
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`WebSocket attempting reconnect in ${delay}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
      setTimeout(() => this.connect().catch(() => {}), delay);
    } else {
      console.error('WebSocket maximum reconnection attempts reached');
      if (this.rejectConnect) {
        this.rejectConnect(new Error('WebSocket connection failed after maximum attempts'));
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectPromise = null;
      }
      useStore.getState().addMessage({
        senderId: 'system',
        senderName: 'System',
        message: 'Lost connection to server. Please refresh your browser.',
        timestamp: Date.now()
      });
    }
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.ws) {
      this.ws.close();
    }
  }
}
