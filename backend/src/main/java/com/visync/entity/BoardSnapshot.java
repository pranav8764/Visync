package com.visync.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;
import java.util.UUID;

@Entity
@Table(name = "board_snapshots")
public class BoardSnapshot {

    @Id
    private UUID id;

    @Column(name = "room_id", nullable = false)
    private UUID roomId;

    @Column(name = "board_state", columnDefinition = "TEXT")
    private String boardState;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    public BoardSnapshot() {
        this.id = UUID.randomUUID();
        this.createdAt = LocalDateTime.now();
    }

    public BoardSnapshot(UUID roomId, String boardState) {
        this();
        this.roomId = roomId;
        this.boardState = boardState;
    }

    // Getters and Setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getRoomId() { return roomId; }
    public void setRoomId(UUID roomId) { this.roomId = roomId; }

    public String getBoardState() { return boardState; }
    public void setBoardState(String boardState) { this.boardState = boardState; }

    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
}
