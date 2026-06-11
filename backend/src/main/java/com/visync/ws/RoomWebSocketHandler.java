package com.visync.ws;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Repository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import com.visync.entity.BoardSnapshot;
import com.visync.entity.ChatMessage;
import com.visync.entity.DrawingEvent;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.ChatMessageRepository;
import com.visync.repository.DrawingEventRepository;
import com.visync.repository.RoomRepository;
import com.visync.service.BoardService;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

@Component
public class RoomWebSocketHandler extends TextWebSocketHandler {

    private static final Logger logger = LoggerFactory.getLogger(RoomWebSocketHandler.class);

    private final RoomRepository roomRepository;
    private final DrawingEventRepository drawingEventRepository;
    private final ChatMessageRepository chatMessageRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final BoardService boardService;

    private final ConcurrentMap<String, Set<WebSocketSession>> rooms = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, String> sessionUsernames = new ConcurrentHashMap<>(); // sessionId -> username
    private final ConcurrentMap<String, String> sessionUserIds = new ConcurrentHashMap<>(); // sessionId -> userId
    private final ConcurrentMap<String, String> sessionRoomIds = new ConcurrentHashMap<>(); // sessionId -> roomId

    private final ConcurrentMap<String, TokenBucket> sessionRateLimiters = new ConcurrentHashMap<>();
    private final Queue<DrawingEvent> fallbackQueue = new ConcurrentLinkedQueue<>();
    private final ScheduledExecutorService fallbackScheduler = Executors.newSingleThreadScheduledExecutor();
    
    // Dedicated executor for blocking database operations to prevent latency
    private final ExecutorService dbExecutor = Executors.newFixedThreadPool(32);

    private final ObjectMapper objectMapper = new ObjectMapper();

    public RoomWebSocketHandler(RoomRepository roomRepository,
            DrawingEventRepository drawingEventRepository,
            ChatMessageRepository chatMessageRepository,
            BoardSnapshotRepository boardSnapshotRepository,
            BoardService boardService) {
        this.roomRepository = roomRepository;
        this.drawingEventRepository = drawingEventRepository;
        this.chatMessageRepository = chatMessageRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
        this.boardService = boardService;

        // Schedule periodic database outage fallback queue flushing
        this.fallbackScheduler.scheduleAtFixedRate(this::retryFailedPersists, 5, 5, TimeUnit.SECONDS);
        logger.info("RoomWebSocketHandler initialized with fallback scheduler running every 5 seconds.");
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        logger.info("WebSocket connection established. SessionId={}, RemoteAddress={}, URI={}", 
                session.getId(), session.getRemoteAddress(), session.getUri());
        // Connection established, waiting for USER_JOIN event to assign room
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String roomId = sessionRoomIds.remove(session.getId());
        String userId = sessionUserIds.remove(session.getId());
        String username = sessionUsernames.remove(session.getId());
        sessionRateLimiters.remove(session.getId());

        logger.info("WebSocket connection closed. SessionId={}, Status={}, RoomId={}, UserId={}, Username={}", 
                session.getId(), status, roomId, userId, username);

        if (roomId != null) {
            Set<WebSocketSession> set = rooms.get(roomId);
            if (set != null) {
                set.remove(session);
                if (set.isEmpty()) {
                    rooms.remove(roomId);
                    final String emptyRoomId = roomId;
                    logger.info("Room {} is now empty. Starting async snapshot compaction and setting room inactive.", emptyRoomId);
                    CompletableFuture.runAsync(() -> {
                        try {
                            boardService.compactSnapshot(emptyRoomId, true);
                            UUID rId = UUID.fromString(emptyRoomId);
                            roomRepository.findById(rId).ifPresent(room -> {
                                room.setActive(false);
                                roomRepository.save(room);
                                logger.info("Room {} successfully set to inactive.", emptyRoomId);
                            });
                        } catch (Exception e) {
                            logger.error("Failed to set room inactive/compact on close for RoomId {}: ", emptyRoomId, e);
                        }
                    }, dbExecutor);
                }
            }

            // Broadcast USER_LEAVE if the user had completed JOIN
            if (userId != null && username != null) {
                Map<String, Object> leaveEvent = new HashMap<>();
                leaveEvent.put("eventType", "USER_LEAVE");
                leaveEvent.put("userId", userId);
                leaveEvent.put("roomId", roomId);
                leaveEvent.put("timestamp", System.currentTimeMillis());

                Map<String, String> payload = new HashMap<>();
                payload.put("username", username);
                leaveEvent.put("payload", payload);

                logger.info("Broadcasting USER_LEAVE event for userId={} in roomId={}", userId, roomId);
                broadcastToRoom(roomId, session.getId(), leaveEvent);
            }
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        // Apply rate limits per session (Capacity: 1000, Refill: 500 per sec -> 0.5 tokens/ms)
        TokenBucket bucket = sessionRateLimiters.computeIfAbsent(session.getId(), k -> new TokenBucket(1000.0, 0.5));
        if (!bucket.tryConsume()) {
            logger.warn("Rate limit exceeded for sessionId={}. Dropping incoming message.", session.getId());
            // Silently drop messages exceeding the rate limit to avoid connection drops
            return;
        }

        String payload = message.getPayload();
        JsonNode rootNode;
        try {
            rootNode = objectMapper.readTree(payload);
        } catch (Exception e) {
            logger.warn("Invalid JSON message received from sessionId={}: {}. Payload length={}", 
                    session.getId(), e.getMessage(), payload != null ? payload.length() : 0);
            return;
        }

        String eventType = rootNode.has("eventType") ? rootNode.get("eventType").asText() : "";
        
        // Extract authenticated roomId and userId from Handshake attributes
        String roomId = (String) session.getAttributes().get("roomId");
        String userId = (String) session.getAttributes().get("userId");
        long timestamp = System.currentTimeMillis(); // Override with server time

        if (roomId == null || userId == null || eventType.isEmpty()) {
            logger.warn("Received message with missing attributes. RoomId={}, UserId={}, EventType={}", roomId, userId, eventType);
            return;
        }

        logger.trace("Received WebSocket eventType={} for roomId={}, userId={}", eventType, roomId, userId);

        // Overwrite client payload parameters to prevent impersonation/timestamp spoofing
        if (rootNode instanceof ObjectNode) {
            ObjectNode objectNode = (ObjectNode) rootNode;
            objectNode.put("userId", userId);
            objectNode.put("roomId", roomId);
            objectNode.put("timestamp", timestamp);
        }

        JsonNode payloadNode = rootNode.get("payload");

        // Process message according to eventType
        switch (eventType) {
            case "USER_JOIN":
                handleUserJoin(session, roomId, userId, timestamp, payloadNode);
                break;
            case "CURSOR_MOVE":
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
            case "DRAW_START":
            case "DRAW_MOVE":
            case "DRAW_END":
                broadcastToRoom(roomId, session.getId(), rootNode);

                if (!eventType.equals("DRAW_MOVE")) {
                    final String currentRoomId = roomId;
                    final String currentUserId = userId;
                    final String currentEventType = eventType;
                    final JsonNode currentPayloadNode = payloadNode;
                    final long currentTimestamp = timestamp;
                    CompletableFuture.runAsync(() -> {
                        persistDrawingEvent(currentRoomId, currentUserId, currentEventType, currentPayloadNode,
                                currentTimestamp);
                    }, dbExecutor);
                }

                if (eventType.equals("DRAW_END")) {
                    triggerSnapshotCompaction(roomId);
                }
                break;
            case "OBJECT_TRANSFORM":
            case "OBJECT_DUPLICATE":
                broadcastToRoom(roomId, session.getId(), rootNode);
                
                final String objRoomId = roomId;
                final String objUserId = userId;
                final String objEventType = eventType;
                final JsonNode objPayloadNode = payloadNode;
                final long objTimestamp = timestamp;
                CompletableFuture.runAsync(() -> {
                    persistDrawingEvent(objRoomId, objUserId, objEventType, objPayloadNode,
                            objTimestamp);
                }, dbExecutor);
                
                triggerSnapshotCompaction(roomId);
                break;
            case "CHAT_MESSAGE":
                persistAndBroadcastChatMessage(roomId, userId, rootNode, payloadNode, timestamp, session.getId());
                break;
            case "BOARD_CLEAR":
                broadcastToRoom(roomId, session.getId(), rootNode);
                final String clearRoomId = roomId;
                CompletableFuture.runAsync(() -> {
                    clearBoardData(clearRoomId);
                }, dbExecutor);
                break;
            case "UNDO":
                broadcastToRoom(roomId, session.getId(), rootNode);
                final String undoStrokeId = (payloadNode != null && payloadNode.has("strokeId")) ? payloadNode.get("strokeId").asText() : "";
                if (!undoStrokeId.isEmpty()) {
                    final String rId = roomId;
                    final String sId = undoStrokeId;
                    CompletableFuture.runAsync(() -> {
                        try {
                            boardService.undoStroke(rId, sId);
                        } catch (Exception e) {
                            logger.error("Failed to run undo in background for roomId={}, strokeId={}: ", rId, sId, e);
                        }
                    }, dbExecutor);
                }
                break;
            case "REDO":
                broadcastToRoom(roomId, session.getId(), rootNode);
                final JsonNode strokeNode = (payloadNode != null && payloadNode.has("stroke")) ? payloadNode.get("stroke") : null;
                if (strokeNode != null) {
                    final String rId = roomId;
                    final String uId = userId;
                    final JsonNode sNode = strokeNode;
                    CompletableFuture.runAsync(() -> {
                        try {
                            boardService.redoStroke(rId, uId, sNode);
                        } catch (Exception e) {
                            logger.error("Failed to run redo in background for roomId={}, userId={}: ", rId, uId, e);
                        }
                    }, dbExecutor);
                }
                break;
            case "USER_NAME_CHANGE":
                if (payloadNode != null && payloadNode.has("username")) {
                    String newName = payloadNode.get("username").asText();
                    logger.info("SessionId={} changed username to '{}'", session.getId(), newName);
                    sessionUsernames.put(session.getId(), newName);
                }
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
            default:
                logger.warn("Received unknown eventType '{}' from sessionId={}", eventType, session.getId());
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
        }
    }

    private void handleUserJoin(WebSocketSession session, String roomId, String userId, long timestamp,
            JsonNode payloadNode) {
        String username = (payloadNode != null && payloadNode.has("username")) ? payloadNode.get("username").asText()
                : "Guest";

        sessionRoomIds.put(session.getId(), roomId);
        rooms.computeIfAbsent(roomId, k -> ConcurrentHashMap.newKeySet()).add(session);

        sessionUserIds.put(session.getId(), userId);
        sessionUsernames.put(session.getId(), username);

        logger.info("User joined room: SessionId={}, RoomId={}, UserId={}, Username={}", 
                session.getId(), roomId, userId, username);

        final String joinedRoomId = roomId;
        CompletableFuture.runAsync(() -> {
            try {
                UUID rId = UUID.fromString(joinedRoomId);
                roomRepository.findById(rId).ifPresent(room -> {
                    if (!room.isActive()) {
                        room.setActive(true);
                        roomRepository.save(room);
                        logger.info("Room {} activated on user join.", joinedRoomId);
                    }
                });
            } catch (Exception e) {
                logger.error("Failed to reactivate room {} on user join: ", joinedRoomId, e);
            }
        }, dbExecutor);

        // Broadcast join event
        Map<String, Object> joinEvent = new HashMap<>();
        joinEvent.put("eventType", "USER_JOIN");
        joinEvent.put("userId", userId);
        joinEvent.put("roomId", roomId);
        joinEvent.put("timestamp", timestamp);

        Map<String, String> joinPayload = new HashMap<>();
        joinPayload.put("username", username);
        joinEvent.put("payload", joinPayload);

        broadcastToRoom(roomId, session.getId(), joinEvent);

        // Send active list of current users in room to the newly joined user
        sendActiveUserPresence(session, roomId);
    }

    private void sendActiveUserPresence(WebSocketSession session, String roomId) {
        Set<WebSocketSession> sessions = rooms.getOrDefault(roomId, Collections.emptySet());
        List<Map<String, String>> usersList = new ArrayList<>();
        Set<String> processedUserIds = new HashSet<>();

        for (WebSocketSession s : sessions) {
            String uId = sessionUserIds.get(s.getId());
            String uName = sessionUsernames.get(s.getId());
            if (uId != null && uName != null) {
                if (processedUserIds.add(uId)) {
                    Map<String, String> uMap = new HashMap<>();
                    uMap.put("userId", uId);
                    uMap.put("username", uName);
                    usersList.add(uMap);
                }
            }
        }

        Map<String, Object> presenceEvent = new HashMap<>();
        presenceEvent.put("eventType", "PRESENCE_LIST");
        presenceEvent.put("roomId", roomId);
        presenceEvent.put("timestamp", System.currentTimeMillis());
        presenceEvent.put("payload", usersList);

        try {
            session.sendMessage(new TextMessage(objectMapper.writeValueAsString(presenceEvent)));
            logger.trace("Successfully sent PRESENCE_LIST to sessionId={} in roomId={}", session.getId(), roomId);
        } catch (IOException e) {
            logger.error("Failed to send presence list to sessionId={} in roomId={}: ", session.getId(), roomId, e);
        }
    }

    private void persistDrawingEvent(String roomId, String userId, String eventType, JsonNode payloadNode,
            long timestamp) {
        try {
            UUID rId = UUID.fromString(roomId);
            String payloadStr = objectMapper.writeValueAsString(payloadNode);
            String strokeId = (payloadNode != null && payloadNode.has("strokeId")) 
                    ? payloadNode.get("strokeId").asText() 
                    : null;
            DrawingEvent event = new DrawingEvent(rId, userId, eventType, payloadStr, timestamp);
            event.setStrokeId(strokeId);
            drawingEventRepository.save(event);
            logger.trace("Successfully persisted DrawingEvent eventType={} for roomId={}", eventType, roomId);
        } catch (Exception e) {
            logger.warn("Failed to save drawing event, enqueuing to fallback queue for roomId={}: {}", roomId, e.getMessage());
            try {
                UUID rId = UUID.fromString(roomId);
                String payloadStr = objectMapper.writeValueAsString(payloadNode);
                String strokeId = (payloadNode != null && payloadNode.has("strokeId")) 
                        ? payloadNode.get("strokeId").asText() 
                        : null;
                DrawingEvent event = new DrawingEvent(rId, userId, eventType, payloadStr, timestamp);
                event.setStrokeId(strokeId);
                fallbackQueue.add(event);
                logger.info("Successfully enqueued event to fallback queue. Current queue size={}", fallbackQueue.size());
            } catch (Exception ex) {
                logger.error("Fatal: failed to enqueue fallback event for roomId={}: ", roomId, ex);
            }
        }
    }

    private void retryFailedPersists() {
        if (fallbackQueue.isEmpty()) return;
        logger.info("Database fallback queue has {} pending drawing events. Retrying...", fallbackQueue.size());
        List<DrawingEvent> toRetry = new ArrayList<>();
        DrawingEvent ev;
        while ((ev = fallbackQueue.poll()) != null) {
            toRetry.add(ev);
        }

        int successCount = 0;
        for (DrawingEvent event : toRetry) {
            try {
                drawingEventRepository.save(event);
                successCount++;
            } catch (Exception e) {
                fallbackQueue.add(event);
                logger.warn("Database still unreachable. Re-enqueued event: {}, reason: {}", event.getId(), e.getMessage());
            }
        }
        if (successCount > 0) {
            logger.info("Successfully flushed {} events from fallback queue.", successCount);
        }
    }

    private void persistAndBroadcastChatMessage(String roomId, String userId, JsonNode originalMsg,
            JsonNode payloadNode, long timestamp, String senderSessionId) {
        try {
            broadcastToRoom(roomId, senderSessionId, originalMsg);

            UUID rId = UUID.fromString(roomId);
            String message = (payloadNode != null && payloadNode.has("message")) ? payloadNode.get("message").asText()
                    : "";
            String username = sessionUsernames.getOrDefault(senderSessionId, "Guest");

            final ChatMessage chatMsg = new ChatMessage(rId, userId, username, message, timestamp);
            CompletableFuture.runAsync(() -> {
                try {
                    chatMessageRepository.save(chatMsg);
                    logger.trace("Successfully saved chat message in DB for roomId={}", roomId);
                } catch (Exception e) {
                    logger.error("Failed to save chat message in DB for roomId={}: ", roomId, e);
                }
            }, dbExecutor);
        } catch (Exception e) {
            logger.error("Failed to process chat message for roomId={}: ", roomId, e);
        }
    }

    private void clearBoardData(String roomId) {
        try {
            boardService.clearBoard(roomId);
            logger.info("Successfully cleared board data for roomId={}", roomId);
        } catch (Exception e) {
            logger.error("Failed to clear board data for roomId={}: ", roomId, e);
        }
    }

    private void triggerSnapshotCompaction(String roomId) {
        CompletableFuture.runAsync(() -> {
            try {
                boardService.compactSnapshot(roomId);
            } catch (Exception e) {
                logger.error("Failed to run snapshot compaction for roomId={}: ", roomId, e);
            }
        }, dbExecutor);
    }

    private void broadcastToRoom(String roomId, String senderSessionId, Object messageObj) {
        Set<WebSocketSession> set = rooms.getOrDefault(roomId, Collections.emptySet());
        if (set.isEmpty())
            return;

        String textMessageStr;
        try {
            if (messageObj instanceof JsonNode) {
                textMessageStr = objectMapper.writeValueAsString(messageObj);
            } else if (messageObj instanceof String) {
                textMessageStr = (String) messageObj;
            } else {
                textMessageStr = objectMapper.writeValueAsString(messageObj);
            }
        } catch (Exception e) {
            logger.error("Failed to serialize message for broadcast in roomId={}: ", roomId, e);
            return;
        }

        TextMessage message = new TextMessage(textMessageStr);
        int broadcastCount = 0;
        for (WebSocketSession s : set) {
            if (s.isOpen() && !s.getId().equals(senderSessionId)) {
                try {
                    s.sendMessage(message);
                    broadcastCount++;
                } catch (IOException e) {
                    logger.warn("Failed to send broadcast message to sessionId={} in roomId={}: {}", s.getId(), roomId, e.getMessage());
                }
            }
        }
        logger.trace("Broadcasted message to {} sessions in roomId={}", broadcastCount, roomId);
    }


    private String extractRoomId(URI uri) {
        if (uri == null)
            return "unknown";
        String path = uri.getPath();
        String[] parts = path.split("/");
        return parts.length >= 4 ? parts[3] : "unknown";
    }

    // Per-session Token Bucket definition
    private static class TokenBucket {
        private final double capacity;
        private final double refillRate;
        private double tokens;
        private long lastRefillTimestamp;

        public TokenBucket(double capacity, double refillRate) {
            this.capacity = capacity;
            this.refillRate = refillRate;
            this.tokens = capacity;
            this.lastRefillTimestamp = System.currentTimeMillis();
        }

        public synchronized boolean tryConsume() {
            refill();
            if (tokens >= 1.0) {
                tokens -= 1.0;
                return true;
            }
            return false;
        }

        private void refill() {
            long now = System.currentTimeMillis();
            long delta = now - lastRefillTimestamp;
            if (delta > 0) {
                tokens = Math.min(capacity, tokens + (delta * refillRate));
                lastRefillTimestamp = now;
            }
        }
    }
}