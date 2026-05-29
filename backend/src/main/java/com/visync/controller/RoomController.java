package com.visync.controller;

import com.visync.entity.BoardSnapshot;
import com.visync.entity.ChatMessage;
import com.visync.entity.DrawingEvent;
import com.visync.entity.Room;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.ChatMessageRepository;
import com.visync.repository.DrawingEventRepository;
import com.visync.repository.RoomRepository;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/rooms")
public class RoomController {

    private final RoomRepository roomRepository;
    private final DrawingEventRepository drawingEventRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final ChatMessageRepository chatMessageRepository;

    public RoomController(RoomRepository roomRepository,
            DrawingEventRepository drawingEventRepository,
            BoardSnapshotRepository boardSnapshotRepository,
            ChatMessageRepository chatMessageRepository) {
        this.roomRepository = roomRepository;
        this.drawingEventRepository = drawingEventRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
        this.chatMessageRepository = chatMessageRepository;
    }

    @PostMapping
    public ResponseEntity<Room> createRoom(@RequestBody CreateRoomRequest request) {
        if (request.getName() == null || request.getName().trim().isEmpty()) {
            return ResponseEntity.badRequest().build();
        }
        String creator = request.getCreatedBy() != null ? request.getCreatedBy().trim() : "Guest";
        Room room = new Room(request.getName().trim(), creator);
        Room savedRoom = roomRepository.save(room);
        return ResponseEntity.ok(savedRoom);
    }

    @GetMapping("/{roomId}")
    public ResponseEntity<Room> getRoom(@PathVariable UUID roomId) {
        return roomRepository.findById(roomId)
                .map(ResponseEntity::ok)
                .orElse(ResponseEntity.notFound().build());
    }

    @GetMapping("/{roomId}/history")
    public ResponseEntity<RoomHistoryResponse> getRoomHistory(@PathVariable UUID roomId) {
        Optional<Room> roomOpt = roomRepository.findById(roomId);
        if (roomOpt.isEmpty()) {
            return ResponseEntity.notFound().build();
        }

        // Fetch latest snapshot
        Optional<BoardSnapshot> latestSnapshotOpt = boardSnapshotRepository
                .findFirstByRoomIdOrderByCreatedAtDesc(roomId);
        String snapshotState = latestSnapshotOpt.map(BoardSnapshot::getBoardState).orElse("[]");

        // Fetch all chronological drawing events
        List<DrawingEvent> allEvents = drawingEventRepository.findByRoomIdOrderByTimestampAsc(roomId);
        List<DrawingEvent> recentEvents;

        if (latestSnapshotOpt.isPresent()) {
            BoardSnapshot snapshot = latestSnapshotOpt.get();
            // In a production setup, we'd filter events created AFTER the snapshot.
            // Since we save snapshots periodically, we can filter drawing events that
            // occurred after the snapshot timestamp.
            // But for safety and simpler code in our MVP, if we have a snapshot, we can
            // fetch all events and filter out those prior or
            // just return recent events since then. To be safe, if we have a snapshot, we
            // only return drawing events that are still relevant.
            // Actually, we can return all events or filter based on timestamp. Since
            // snapshot captures the board at a certain time,
            // we can filter event.getTimestamp() > snapshot.getCreatedAt().toEpochSecond()
            // or similar.
            // A simple robust approach: just return recent events that aren't yet
            // snapshot-compacted,
            // or simply return the entire history if the canvas board clears drawingEvents
            // after snapshots.
            // Let's just return all drawing events that happened after the snapshot's
            // creation time.
            long snapshotEpoch = snapshot.getCreatedAt().atZone(java.time.ZoneId.systemDefault()).toInstant()
                    .toEpochMilli();
            recentEvents = allEvents.stream()
                    .filter(e -> e.getTimestamp() > snapshotEpoch)
                    .collect(Collectors.toList());
        } else {
            recentEvents = allEvents;
        }

        // Fetch all chat messages in chronological order
        List<ChatMessage> chatHistory = chatMessageRepository.findByRoomIdOrderByTimestampAsc(roomId);

        return ResponseEntity.ok(new RoomHistoryResponse(snapshotState, recentEvents, chatHistory));
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

        public RoomHistoryResponse(String boardSnapshot, List<DrawingEvent> recentEvents,
                List<ChatMessage> chatHistory) {
            this.boardSnapshot = boardSnapshot;
            this.recentEvents = recentEvents;
            this.chatHistory = chatHistory;
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
    }
}
