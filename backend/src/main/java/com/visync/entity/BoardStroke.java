package com.visync.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;

import java.time.LocalDateTime;
import java.util.UUID;

@Entity
@Table(
    name = "board_strokes",
    uniqueConstraints = @UniqueConstraint(
        name = "uk_board_strokes_room_stroke",
        columnNames = {"room_id", "stroke_id"}
    ),
    indexes = @Index(name = "idx_board_strokes_room", columnList = "room_id")
)
public class BoardStroke {

    @Id
    private UUID id;

    @Column(name = "room_id", nullable = false)
    private UUID roomId;

    @Column(name = "stroke_id", nullable = false)
    private String strokeId;

    @Column(name = "stroke_data", nullable = false, columnDefinition = "TEXT")
    private String strokeData;

    @Column(name = "created_at", nullable = false, updatable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;

    public BoardStroke() {
        this.id = UUID.randomUUID();
    }

    public BoardStroke(UUID roomId, String strokeId, String strokeData) {
        this();
        this.roomId = roomId;
        this.strokeId = strokeId;
        this.strokeData = strokeData;
        this.createdAt = LocalDateTime.now();
        this.updatedAt = LocalDateTime.now();
    }

    @PrePersist
    void touchUpdatedAt() {
        if (createdAt == null) createdAt = LocalDateTime.now();
        updatedAt = LocalDateTime.now();
    }

    @PreUpdate
    void updateTimestamp() {
        updatedAt = LocalDateTime.now();
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public UUID getRoomId() { return roomId; }
    public void setRoomId(UUID roomId) { this.roomId = roomId; }
    public String getStrokeId() { return strokeId; }
    public void setStrokeId(String strokeId) { this.strokeId = strokeId; }
    public String getStrokeData() { return strokeData; }
    public void setStrokeData(String strokeData) { this.strokeData = strokeData; }
    public LocalDateTime getCreatedAt() { return createdAt; }
    public void setCreatedAt(LocalDateTime createdAt) { this.createdAt = createdAt; }
    public LocalDateTime getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(LocalDateTime updatedAt) { this.updatedAt = updatedAt; }
}
