package com.visync.ws;

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
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;
import java.net.URI;
import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.*;

@Component
@Repository
public class RoomWebSocketHandler extends TextWebSocketHandler {

    private final RoomRepository roomRepository;
    private final DrawingEventRepository drawingEventRepository;
    private final ChatMessageRepository chatMessageRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;

    private final ConcurrentMap<String, Set<WebSocketSession>> rooms = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, String> sessionUsernames = new ConcurrentHashMap<>(); // sessionId -> username
    private final ConcurrentMap<String, String> sessionUserIds = new ConcurrentHashMap<>();   // sessionId -> userId
    private final ConcurrentMap<String, String> sessionRoomIds = new ConcurrentHashMap<>();   // sessionId -> roomId

    private final ObjectMapper objectMapper = new ObjectMapper();

    public RoomWebSocketHandler(RoomRepository roomRepository,
                                  DrawingEventRepository drawingEventRepository,
                                  ChatMessageRepository chatMessageRepository,
                                  BoardSnapshotRepository boardSnapshotRepository) {
        this.roomRepository = roomRepository;
        this.drawingEventRepository = drawingEventRepository;
        this.chatMessageRepository = chatMessageRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        // Connection established, waiting for USER_JOIN event to assign room
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String roomId = sessionRoomIds.remove(session.getId());
        String userId = sessionUserIds.remove(session.getId());
        String username = sessionUsernames.remove(session.getId());

        if (roomId != null) {
            Set<WebSocketSession> set = rooms.get(roomId);
            if (set != null) {
                set.remove(session);
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

                broadcastToRoom(roomId, session.getId(), leaveEvent);
            }
        }
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        JsonNode rootNode;
        try {
            rootNode = objectMapper.readTree(payload);
        } catch (Exception e) {
            System.err.println("Invalid JSON message: " + e.getMessage());
            return;
        }

        String eventType = rootNode.has("eventType") ? rootNode.get("eventType").asText() : "";
        String roomId = rootNode.has("roomId") ? rootNode.get("roomId").asText() : "";
        String userId = rootNode.has("userId") ? rootNode.get("userId").asText() : "";
        long timestamp = rootNode.has("timestamp") ? rootNode.get("timestamp").asLong() : System.currentTimeMillis();
        JsonNode payloadNode = rootNode.get("payload");

        if (roomId.isEmpty() || eventType.isEmpty()) return;

        // Process message according to eventType
        switch (eventType) {
            case "USER_JOIN":
                handleUserJoin(session, roomId, userId, timestamp, payloadNode);
                break;
            case "CURSOR_MOVE":
                // Transient cursor tracking - broadcast only, do not persist
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
            case "DRAW_START":
            case "DRAW_MOVE":
            case "DRAW_END":
                // 1. Broadcast immediately to minimize latency!
                broadcastToRoom(roomId, session.getId(), rootNode);

                // 2. Persist drawing events asynchronously in background thread!
                final String currentRoomId = roomId;
                final String currentUserId = userId;
                final String currentEventType = eventType;
                final JsonNode currentPayloadNode = payloadNode;
                final long currentTimestamp = timestamp;
                CompletableFuture.runAsync(() -> {
                    persistDrawingEvent(currentRoomId, currentUserId, currentEventType, currentPayloadNode, currentTimestamp);
                });
                
                // If DRAW_END, check if we should trigger snapshot compaction
                if (eventType.equals("DRAW_END")) {
                    triggerSnapshotCompaction(roomId);
                }
                break;
            case "CHAT_MESSAGE":
                persistAndBroadcastChatMessage(roomId, userId, rootNode, payloadNode, timestamp, session.getId());
                break;
            case "BOARD_CLEAR":
                broadcastToRoom(roomId, session.getId(), rootNode);
                final String clearRoomId = roomId;
                CompletableFuture.runAsync(() -> {
                    clearBoardData(clearRoomId);
                });
                break;
            case "UNDO":
            case "REDO":
                // Broadcast state undo/redo triggers to other active rooms
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
            default:
                // Default fallback: broadcast to all other users
                broadcastToRoom(roomId, session.getId(), rootNode);
                break;
        }
    }

    private void handleUserJoin(WebSocketSession session, String roomId, String userId, long timestamp, JsonNode payloadNode) {
        String username = (payloadNode != null && payloadNode.has("username")) ? payloadNode.get("username").asText() : "Guest";
        
        sessionRoomIds.put(session.getId(), roomId);
        rooms.computeIfAbsent(roomId, k -> ConcurrentHashMap.newKeySet()).add(session);

        sessionUserIds.put(session.getId(), userId);
        sessionUsernames.put(session.getId(), username);

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
        } catch (IOException e) {
            System.err.println("Failed to send presence list: " + e.getMessage());
        }
    }

    private void persistDrawingEvent(String roomId, String userId, String eventType, JsonNode payloadNode, long timestamp) {
        try {
            UUID rId = UUID.fromString(roomId);
            String payloadStr = objectMapper.writeValueAsString(payloadNode);
            DrawingEvent event = new DrawingEvent(rId, userId, eventType, payloadStr, timestamp);
            drawingEventRepository.save(event);
        } catch (Exception e) {
            System.err.println("Failed to save drawing event: " + e.getMessage());
        }
    }

    private void persistAndBroadcastChatMessage(String roomId, String userId, JsonNode originalMsg, JsonNode payloadNode, long timestamp, String senderSessionId) {
        try {
            // 1. Broadcast immediately to minimize latency!
            broadcastToRoom(roomId, senderSessionId, originalMsg);

            // 2. Persist asynchronously in background thread!
            UUID rId = UUID.fromString(roomId);
            String message = (payloadNode != null && payloadNode.has("message")) ? payloadNode.get("message").asText() : "";
            String username = sessionUsernames.getOrDefault(senderSessionId, "Guest");
            
            final ChatMessage chatMsg = new ChatMessage(rId, userId, username, message, timestamp);
            CompletableFuture.runAsync(() -> {
                try {
                    chatMessageRepository.save(chatMsg);
                } catch (Exception e) {
                    System.err.println("Failed to save chat message: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            System.err.println("Failed to process chat message: " + e.getMessage());
        }
    }

    private void clearBoardData(String roomId) {
        try {
            UUID rId = UUID.fromString(roomId);
            drawingEventRepository.deleteByRoomId(rId);
            boardSnapshotRepository.deleteByRoomId(rId);
        } catch (Exception e) {
            System.err.println("Failed to clear board data: " + e.getMessage());
        }
    }

    private void triggerSnapshotCompaction(String roomId) {
        // Run asynchronously to not block WebSocket threads
        CompletableFuture.runAsync(() -> {
            try {
                UUID rId = UUID.fromString(roomId);
                List<DrawingEvent> allEvents = drawingEventRepository.findByRoomIdOrderByTimestampAsc(rId);
                
                // If there are a significant number of drawing events (e.g. > 100), compact them
                if (allEvents.size() > 100) {
                    // Fetch existing latest snapshot
                    Optional<BoardSnapshot> latestSnapshotOpt = boardSnapshotRepository.findFirstByRoomIdOrderByCreatedAtDesc(rId);
                    
                    // We reconstruct the active strokes JSON state
                    // In the client, the strokes are a list of stroke objects
                    // Let's combine them on the backend as a simplified list of strokes
                    // Structure: Map<strokeId, StrokeNode>
                    Map<String, Map<String, Object>> strokes = new LinkedHashMap<>();
                    
                    // Apply existing snapshot first
                    if (latestSnapshotOpt.isPresent()) {
                        String existingState = latestSnapshotOpt.get().getBoardState();
                        try {
                            List<Map<String, Object>> existingStrokes = objectMapper.readValue(existingState, List.class);
                            for (Map<String, Object> stroke : existingStrokes) {
                                String sId = (String) stroke.get("id");
                                if (sId != null) {
                                    strokes.put(sId, stroke);
                                }
                            }
                        } catch (Exception ex) {
                            System.err.println("Failed to parse existing board snapshot state: " + ex.getMessage());
                        }
                    }
                    
                    // Now apply incremental events
                    for (DrawingEvent event : allEvents) {
                        try {
                            JsonNode plNode = objectMapper.readTree(event.getPayload());
                            String sId = plNode.has("strokeId") ? plNode.get("strokeId").asText() : null;
                            if (sId == null) continue;
                            
                            switch (event.getEventType()) {
                                case "DRAW_START":
                                    Map<String, Object> newStroke = new HashMap<>();
                                    newStroke.put("id", sId);
                                    newStroke.put("userId", event.getUserId());
                                    newStroke.put("color", plNode.has("color") ? plNode.get("color").asText() : "#000000");
                                    newStroke.put("strokeWidth", plNode.has("strokeWidth") ? plNode.get("strokeWidth").asInt() : 2);
                                    newStroke.put("tool", plNode.has("tool") ? plNode.get("tool").asText() : "pen");
                                    newStroke.put("points", new ArrayList<Map<String, Double>>());
                                    strokes.put(sId, newStroke);
                                    break;
                                case "DRAW_MOVE":
                                    Map<String, Object> stroke = strokes.get(sId);
                                    if (stroke != null) {
                                        List<Map<String, Double>> pts = (List<Map<String, Double>>) stroke.get("points");
                                        if (plNode.has("point")) {
                                            JsonNode ptNode = plNode.get("point");
                                            Map<String, Double> pt = new HashMap<>();
                                            pt.put("x", ptNode.get("x").asDouble());
                                            pt.put("y", ptNode.get("y").asDouble());
                                            pts.add(pt);
                                        }
                                    }
                                    break;
                                case "DRAW_END":
                                    // Nothing special, stroke is already active
                                    break;
                            }
                        } catch (Exception ex) {
                            System.err.println("Error parsing event payload during compaction: " + ex.getMessage());
                        }
                    }
                    
                    // Save new snapshot
                    String newSnapshotState = objectMapper.writeValueAsString(new ArrayList<>(strokes.values()));
                    BoardSnapshot newSnapshot = new BoardSnapshot(rId, newSnapshotState);
                    boardSnapshotRepository.save(newSnapshot);
                    
                    // Delete compacted events
                    drawingEventRepository.deleteByRoomId(rId);
                }
            } catch (Exception e) {
                System.err.println("Failed to run snapshot compaction: " + e.getMessage());
            }
        });
    }

    private void broadcastToRoom(String roomId, String senderSessionId, Object messageObj) {
        Set<WebSocketSession> set = rooms.getOrDefault(roomId, Collections.emptySet());
        if (set.isEmpty()) return;

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
            System.err.println("Failed to serialize message: " + e.getMessage());
            return;
        }

        TextMessage message = new TextMessage(textMessageStr);
        for (WebSocketSession s : set) {
            if (s.isOpen() && !s.getId().equals(senderSessionId)) {
                try {
                    s.sendMessage(message);
                } catch (IOException e) {
                    System.err.println("Failed to broadcast message: " + e.getMessage());
                }
            }
        }
    }

    private String extractRoomId(URI uri) {
        if (uri == null) return "unknown";
        String path = uri.getPath(); // e.g. /ws/rooms/{roomId}
        String[] parts = path.split("/");
        return parts.length >= 4 ? parts[3] : "unknown";
    }
}