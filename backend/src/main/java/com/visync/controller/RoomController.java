package com.visync.controller;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.visync.entity.BoardSnapshot;
import com.visync.entity.ChatMessage;
import com.visync.entity.DrawingEvent;
import com.visync.entity.Room;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.ChatMessageRepository;
import com.visync.repository.DrawingEventRepository;
import com.visync.repository.RoomRepository;
import com.visync.service.TokenService;
import com.visync.service.BoardService;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {

    private static final Logger logger = LoggerFactory.getLogger(RoomController.class);

    private final RoomRepository roomRepository;
    private final DrawingEventRepository drawingEventRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final ChatMessageRepository chatMessageRepository;
    private final TokenService tokenService;
    private final BoardService boardService;

    public RoomController(RoomRepository roomRepository,
            DrawingEventRepository drawingEventRepository,
            BoardSnapshotRepository boardSnapshotRepository,
            ChatMessageRepository chatMessageRepository,
            TokenService tokenService,
            BoardService boardService) {
        this.roomRepository = roomRepository;
        this.drawingEventRepository = drawingEventRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
        this.chatMessageRepository = chatMessageRepository;
        this.tokenService = tokenService;
        this.boardService = boardService;
    }


    @PostMapping
    public ResponseEntity<Room> createRoom(@RequestBody CreateRoomRequest request) {
        logger.info("REST request to create room with name={}, createdBy={}", request.getName(), request.getCreatedBy());
        if (request.getName() == null || request.getName().trim().isEmpty()) {
            logger.warn("Create room failed: Room name is missing or empty.");
            return ResponseEntity.badRequest().build();
        }
        String creator = request.getCreatedBy() != null ? request.getCreatedBy().trim() : "Guest";
        Room room = new Room(request.getName().trim(), creator);
        Room savedRoom = roomRepository.save(room);
        logger.info("Room created successfully. RoomId={}, name={}", savedRoom.getId(), savedRoom.getName());
        return ResponseEntity.ok(savedRoom);
    }

    @GetMapping("/{roomId}")
    public ResponseEntity<Room> getRoom(@PathVariable UUID roomId) {
        logger.debug("REST request to get room with id={}", roomId);
        return roomRepository.findById(roomId)
                .map(room -> {
                    logger.debug("Room found: RoomId={}", roomId);
                    return ResponseEntity.ok(room);
                })
                .orElseGet(() -> {
                    logger.warn("Room not found: RoomId={}", roomId);
                    return ResponseEntity.notFound().build();
                });
    }

    @GetMapping("/{roomId}/history")
    public ResponseEntity<RoomHistoryResponse> getRoomHistory(
            @PathVariable UUID roomId,
            @RequestParam("userId") String userId) {
        logger.debug("REST request to get room history for roomId={}, userId={}", roomId, userId);
        Optional<Room> roomOpt = roomRepository.findById(roomId);
        if (roomOpt.isEmpty()) {
            logger.warn("Room history request failed: Room not found. RoomId={}", roomId);
            return ResponseEntity.notFound().build();
        }

        // Fetch latest snapshot
        Optional<BoardSnapshot> latestSnapshotOpt = boardSnapshotRepository
                .findFirstByRoomIdOrderByCreatedAtDesc(roomId);
        String snapshotState = latestSnapshotOpt.map(BoardSnapshot::getBoardState).orElse("[]");
        logger.debug("Fetched room history snapshot state length={} for roomId={}", snapshotState.length(), roomId);

        // Fetch all chronological drawing events (merging Postgres and the active memory buffer).
        List<DrawingEvent> recentEvents = boardService.getRecentEvents(roomId);
        logger.debug("Fetched {} recent drawing events for roomId={}", recentEvents.size(), roomId);

        // Fetch the most recent 200 chat messages (newest-first), then reverse to chronological order
        List<ChatMessage> chatHistory = new ArrayList<>(chatMessageRepository.findByRoomIdOrderByTimestampDesc(roomId, PageRequest.of(0, 200)));
        Collections.reverse(chatHistory);
        logger.debug("Fetched {} chat messages for roomId={}", chatHistory.size(), roomId);

        // Generate token for WebSocket connection authentication
        String wsToken = tokenService.generateToken(userId, roomId.toString());
        logger.debug("Generated WebSocket auth token for userId={}, roomId={}", userId, roomId);

        return ResponseEntity.ok(new RoomHistoryResponse(snapshotState, recentEvents, chatHistory, wsToken));
    }

    // DTO Static Classes

    public static class CreateRoomRequest {
        private String name;
        private String createdBy;

        public String getName() {
            return name;
        }

        public void setName(String name) {
            this.name = name;
        }

        public String getCreatedBy() {
            return createdBy;
        }

        public void setCreatedBy(String createdBy) {
            this.createdBy = createdBy;
        }
    }

    public static class RoomHistoryResponse {
        private String boardSnapshot;
        private List<DrawingEvent> recentEvents;
        private List<ChatMessage> chatHistory;
        private String wsToken;

        public RoomHistoryResponse(String boardSnapshot, List<DrawingEvent> recentEvents,
                List<ChatMessage> chatHistory, String wsToken) {
            this.boardSnapshot = boardSnapshot;
            this.recentEvents = recentEvents;
            this.chatHistory = chatHistory;
            this.wsToken = wsToken;
        }

        public String getBoardSnapshot() {
            return boardSnapshot;
        }

        public void setBoardSnapshot(String boardSnapshot) {
            this.boardSnapshot = boardSnapshot;
        }

        public List<DrawingEvent> getRecentEvents() {
            return recentEvents;
        }

        public void setRecentEvents(List<DrawingEvent> recentEvents) {
            this.recentEvents = recentEvents;
        }

        public List<ChatMessage> getChatHistory() {
            return chatHistory;
        }

        public void setChatHistory(List<ChatMessage> chatHistory) {
            this.chatHistory = chatHistory;
        }

        public String getWsToken() {
            return wsToken;
        }

        public void setWsToken(String wsToken) {
            this.wsToken = wsToken;
        }
    }
}
