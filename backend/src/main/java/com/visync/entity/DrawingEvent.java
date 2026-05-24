package com.visync.entity;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "drawing_events")
public class DrawingEvent {

    @Id
    private UUID id;

    @Column(name = "room_id", nullable = false)
    private UUID roomId;

    @Column(name = "user_id", nullable = false)
    private String userId;

    @Column(name = "event_type", nullable = false)
    private String eventType;

    @Column(columnDefinition = "TEXT")
    private String payload;

    @Column(nullable = false)
    private Long timestamp;

    public DrawingEvent() {
        this.id = UUID.randomUUID();
    }

    public DrawingEvent(UUID roomId, String userId, String eventType, String payload, Long timestamp) {
        this();
        this.roomId = roomId;
        this.userId = userId;
        this.eventType = eventType;
        this.payload = payload;
        this.timestamp = timestamp;
    }

    // Getters and Setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }

    public UUID getRoomId() { return roomId; }
    public void setRoomId(UUID roomId) { this.roomId = roomId; }

    public String getUserId() { return userId; }
    public void setUserId(String userId) { this.userId = userId; }

    public String getEventType() { return eventType; }
    public void setEventType(String eventType) { this.eventType = eventType; }

    public String getPayload() { return payload; }
    public void setPayload(String payload) { this.payload = payload; }

    public Long getTimestamp() { return timestamp; }
    public void setTimestamp(Long timestamp) { this.timestamp = timestamp; }
}
