package com.visync.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import com.visync.entity.BoardSnapshot;
import com.visync.entity.DrawingEvent;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.DrawingEventRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.stream.Collectors;

@Service
@Transactional
public class BoardService {

    private static final Logger logger = LoggerFactory.getLogger(BoardService.class);

    private final DrawingEventRepository drawingEventRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    private final ConcurrentMap<String, List<DrawingEvent>> roomEventsBuffer = new ConcurrentHashMap<>();

    // Self-injection to ensure @Scheduled -> compactSnapshot() goes through the Spring proxy,
    // so @Transactional is respected (direct this.compactSnapshot() bypasses AOP).
    @Lazy
    @Autowired
    private BoardService self;

    public BoardService(DrawingEventRepository drawingEventRepository,
            BoardSnapshotRepository boardSnapshotRepository) {
        this.drawingEventRepository = drawingEventRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
    }

    public void bufferDrawingEvent(String roomId, String userId, String eventType, String payloadStr, long timestamp) {
        UUID rId = UUID.fromString(roomId);
        DrawingEvent event = new DrawingEvent(rId, userId, eventType, payloadStr, timestamp);

        // Extract strokeId from the payload so undo/delete queries can match on it
        try {
            JsonNode payloadNode = objectMapper.readTree(payloadStr);
            if (payloadNode != null && payloadNode.has("strokeId")) {
                event.setStrokeId(payloadNode.get("strokeId").asText());
            }
        } catch (Exception e) {
            logger.warn("Failed to extract strokeId from payload for roomId={}: {}", roomId, e.getMessage());
        }

        roomEventsBuffer.computeIfAbsent(roomId, k -> Collections.synchronizedList(new ArrayList<>())).add(event);
        logger.trace("Buffered drawing event type={} for roomId={}, strokeId={}", eventType, roomId, event.getStrokeId());
    }

    public List<DrawingEvent> getRecentEvents(UUID roomId) {
        List<DrawingEvent> dbEvents = drawingEventRepository.findByRoomIdOrderByTimestampAsc(roomId);
        List<DrawingEvent> bufferedEvents = roomEventsBuffer.get(roomId.toString());
        if (bufferedEvents != null && !bufferedEvents.isEmpty()) {
            List<DrawingEvent> combined = new ArrayList<>(dbEvents);
            synchronized (bufferedEvents) {
                combined.addAll(bufferedEvents);
            }
            logger.debug("Merging room history: dbEvents={}, bufferedEvents={} for roomId={}", 
                    dbEvents.size(), bufferedEvents.size(), roomId);
            return combined;
        }
        return dbEvents;
    }


    public void clearBoard(String roomId) {
        logger.info("Clearing board drawing events and snapshots for roomId={}", roomId);
        UUID rId = UUID.fromString(roomId);
        // Clear the in-memory buffer first so stale events don't get flushed back to DB
        roomEventsBuffer.remove(roomId);
        drawingEventRepository.deleteByRoomId(rId);
        boardSnapshotRepository.deleteByRoomId(rId);
        logger.info("Cleared board successfully for roomId={}", roomId);
    }

    public void undoStroke(String roomId, String strokeId) {
        logger.info("Undoing strokeId={} for roomId={}", strokeId, roomId);
        UUID rId = UUID.fromString(roomId);
        drawingEventRepository.deleteByRoomIdAndStrokeId(rId, strokeId);

        Optional<BoardSnapshot> latestSnapshotOpt = boardSnapshotRepository
                .findFirstByRoomIdOrderByCreatedAtDesc(rId);

        if (latestSnapshotOpt.isPresent()) {
            BoardSnapshot snapshot = latestSnapshotOpt.get();
            String existingState = snapshot.getBoardState();
            try {
                List<Map<String, Object>> strokesList = objectMapper.readValue(existingState, List.class);
                boolean removed = strokesList.removeIf(stroke -> strokeId.equals(stroke.get("id")));
                if (removed) {
                    String updatedState = objectMapper.writeValueAsString(strokesList);
                    snapshot.setBoardState(updatedState);
                    boardSnapshotRepository.save(snapshot);
                    logger.debug("Successfully updated snapshot to remove strokeId={} for roomId={}", strokeId, roomId);
                } else {
                    logger.debug("StrokeId={} was not found in the latest snapshot for roomId={}", strokeId, roomId);
                }
            } catch (Exception ex) {
                logger.error("Failed to update snapshot during undo for roomId={}, strokeId={}: ", roomId, strokeId, ex);
            }
        } else {
            logger.debug("No snapshot found to update during undo for roomId={}", roomId);
        }
    }

    public void redoStroke(String roomId, String userId, JsonNode strokeNode) {
        if (strokeNode == null) return;
        UUID rId = UUID.fromString(roomId);
        String strokeId = strokeNode.has("id") ? strokeNode.get("id").asText() : "";
        if (strokeId.isEmpty()) return;

        logger.info("Redoing strokeId={} for roomId={} by userId={}", strokeId, roomId, userId);

        String color = strokeNode.has("color") ? strokeNode.get("color").asText() : "#000000";
        int strokeWidth = strokeNode.has("strokeWidth") ? strokeNode.get("strokeWidth").asInt() : 2;
        String tool = strokeNode.has("tool") ? strokeNode.get("tool").asText() : "pen";

        try {
            // Reconstruct DRAW_START
            ObjectNode startPayload = objectMapper.createObjectNode();
            startPayload.put("strokeId", strokeId);
            startPayload.put("color", color);
            startPayload.put("strokeWidth", strokeWidth);
            startPayload.put("tool", tool);

            JsonNode pointsNode = strokeNode.get("points");
            if (pointsNode != null && pointsNode.isArray() && pointsNode.size() > 0) {
                startPayload.set("point", pointsNode.get(0));
            }

            DrawingEvent startEvent = new DrawingEvent(
                rId,
                userId,
                "DRAW_START",
                objectMapper.writeValueAsString(startPayload),
                System.currentTimeMillis()
            );
            startEvent.setStrokeId(strokeId);
            drawingEventRepository.save(startEvent);

            // Reconstruct DRAW_MOVEs
            if (pointsNode != null && pointsNode.isArray()) {
                for (int i = 0; i < pointsNode.size(); i++) {
                    ObjectNode movePayload = objectMapper.createObjectNode();
                    movePayload.put("strokeId", strokeId);
                    movePayload.set("point", pointsNode.get(i));

                    DrawingEvent moveEvent = new DrawingEvent(
                        rId,
                        userId,
                        "DRAW_MOVE",
                        objectMapper.writeValueAsString(movePayload),
                        System.currentTimeMillis() + i + 1
                    );
                    moveEvent.setStrokeId(strokeId);
                    drawingEventRepository.save(moveEvent);
                }
            }

            // Reconstruct DRAW_END
            ObjectNode endPayload = objectMapper.createObjectNode();
            endPayload.put("strokeId", strokeId);
            DrawingEvent endEvent = new DrawingEvent(
                rId,
                userId,
                "DRAW_END",
                objectMapper.writeValueAsString(endPayload),
                System.currentTimeMillis() + (pointsNode != null ? pointsNode.size() : 0) + 2
            );
            endEvent.setStrokeId(strokeId);
            drawingEventRepository.save(endEvent);
            logger.debug("Successfully saved redone drawing events for strokeId={} in roomId={}", strokeId, roomId);

        } catch (Exception e) {
            logger.error("Failed to save drawing events during redo for roomId={}, strokeId={}: ", roomId, strokeId, e);
        }
    }

    public void compactSnapshot(String roomId) {
        compactSnapshot(roomId, false);
    }

    public void compactSnapshot(String roomId, boolean force) {
        UUID rId = UUID.fromString(roomId);

        // 1. Flush in-memory buffered events to database
        List<DrawingEvent> bufferedEvents = roomEventsBuffer.get(roomId);
        if (bufferedEvents != null) {
            List<DrawingEvent> toSave = null;
            synchronized (bufferedEvents) {
                if (!bufferedEvents.isEmpty()) {
                    toSave = new ArrayList<>(bufferedEvents);
                }
            }
            if (toSave != null && !toSave.isEmpty()) {
                try {
                    drawingEventRepository.saveAll(toSave);
                    logger.info("Flushed {} buffered drawing events to Postgres for roomId={}", toSave.size(), roomId);
                    synchronized (bufferedEvents) {
                        bufferedEvents.removeAll(toSave);
                    }
                } catch (Exception e) {
                    logger.error("Failed to flush buffered drawing events to database for roomId={}: ", roomId, e);
                    // Do not clear the buffer or continue snapshot compaction, keep them in memory to retry next time
                    return;
                }
            }
            // Clean up empty buffers to save memory
            synchronized (bufferedEvents) {
                if (bufferedEvents.isEmpty()) {
                    roomEventsBuffer.remove(roomId);
                }
            }
        }

        // 2. Fetch all events from the database
        List<DrawingEvent> allEvents = drawingEventRepository.findByRoomIdOrderByTimestampAsc(rId);

        if (allEvents.isEmpty()) {
            logger.debug("No drawing events to compact for roomId={}", roomId);
            return;
        }

        logger.info("Evaluating compaction for roomId={}: eventsCount={}, force={}", roomId, allEvents.size(), force);

        if (force || allEvents.size() > 100) {
            logger.info("Executing snapshot compaction for roomId={} with {} events", roomId, allEvents.size());
            Optional<BoardSnapshot> latestSnapshotOpt = boardSnapshotRepository
                    .findFirstByRoomIdOrderByCreatedAtDesc(rId);
            Map<String, Map<String, Object>> strokes = new LinkedHashMap<>();

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
                    logger.error("Failed to parse existing board snapshot state for roomId={}: ", roomId, ex);
                }
            }

            for (DrawingEvent event : allEvents) {
                try {
                    JsonNode plNode = objectMapper.readTree(event.getPayload());
                    String sId = plNode.has("strokeId") ? plNode.get("strokeId").asText() : null;
                    if (sId == null)
                        continue;

                    switch (event.getEventType()) {
                        case "DRAW_START":
                            Map<String, Object> newStroke = new HashMap<>();
                            newStroke.put("id", sId);
                            newStroke.put("userId", event.getUserId());
                            newStroke.put("color", plNode.has("color") ? plNode.get("color").asText() : "#000000");
                            newStroke.put("strokeWidth",
                                    plNode.has("strokeWidth") ? plNode.get("strokeWidth").asInt() : 2);
                            newStroke.put("tool", plNode.has("tool") ? plNode.get("tool").asText() : "pen");
                            newStroke.put("points", new ArrayList<Map<String, Double>>());
                            strokes.put(sId, newStroke);
                            break;
                        case "DRAW_MOVE":
                            Map<String, Object> stroke = strokes.get(sId);
                            if (stroke != null) {
                                List<Map<String, Double>> pts = (List<Map<String, Double>>) stroke.get("points");
                                String tool = (String) stroke.get("tool");
                                if (plNode.has("point")) {
                                    JsonNode ptNode = plNode.get("point");
                                    Map<String, Double> pt = new HashMap<>();
                                    pt.put("x", ptNode.get("x").asDouble());
                                    pt.put("y", ptNode.get("y").asDouble());

                                    if ("pen".equals(tool) || "eraser".equals(tool)) {
                                        pts.add(pt);
                                    } else {
                                        if (pts.isEmpty()) {
                                            pts.add(pt);
                                        } else if (pts.size() == 1) {
                                            pts.add(pt);
                                        } else {
                                            pts.set(1, pt);
                                        }
                                    }
                                }
                            }
                            break;
                        case "DRAW_END":
                            if (plNode.has("points") && plNode.get("points").isArray()) {
                                Map<String, Object> strokeToEnd = strokes.get(sId);
                                if (strokeToEnd != null) {
                                    List<Map<String, Double>> endPts = new ArrayList<>();
                                    for (JsonNode pNode : plNode.get("points")) {
                                        Map<String, Double> pt = new HashMap<>();
                                        pt.put("x", pNode.get("x").asDouble());
                                        pt.put("y", pNode.get("y").asDouble());
                                        endPts.add(pt);
                                    }
                                    strokeToEnd.put("points", endPts);
                                }
                            }
                            break;
                        case "OBJECT_TRANSFORM":
                            if (plNode.has("transforms") && plNode.get("transforms").isArray()) {
                                for (JsonNode tNode : plNode.get("transforms")) {
                                    applyTransformToStroke(strokes, tNode.get("strokeId").asText(), tNode.get("transform"));
                                }
                            } else {
                                applyTransformToStroke(strokes, sId, plNode.get("transform"));
                            }
                            break;
                        case "OBJECT_DUPLICATE":
                            if (plNode.has("strokes") && plNode.get("strokes").isArray()) {
                                for (JsonNode newStrokeNode : plNode.get("strokes")) {
                                    Map<String, Object> duplicatedStroke = objectMapper.convertValue(newStrokeNode, Map.class);
                                    if (duplicatedStroke != null && duplicatedStroke.get("id") != null) {
                                        strokes.put((String) duplicatedStroke.get("id"), duplicatedStroke);
                                    }
                                }
                            }
                            break;
                        case "OBJECT_DELETE":
                            if (plNode.has("strokeIds") && plNode.get("strokeIds").isArray()) {
                                for (JsonNode idNode : plNode.get("strokeIds")) {
                                    strokes.remove(idNode.asText());
                                }
                            }
                            break;
                    }
                } catch (Exception ex) {
                    logger.error("Error parsing event payload during compaction for roomId={}, eventId={}: ", roomId, event.getId(), ex);
                }
            }

            try {
                String newSnapshotState = objectMapper.writeValueAsString(new ArrayList<>(strokes.values()));
                BoardSnapshot newSnapshot = new BoardSnapshot(rId, newSnapshotState);
                boardSnapshotRepository.save(newSnapshot);

                // Collect IDs of the compiled events
                List<UUID> compiledIds = allEvents.stream().map(DrawingEvent::getId).collect(Collectors.toList());
                // Delete ONLY the compiled events
                drawingEventRepository.deleteAllByIds(compiledIds);

                logger.info("Successfully compacted {} events into a new snapshot for roomId={}", compiledIds.size(), roomId);

                // Cleanup older snapshots, keep only the latest one
                cleanOldSnapshots(rId);
            } catch (Exception ex) {
                logger.error("Failed to save snapshot or delete events during compaction for roomId={}: ", roomId, ex);
            }
        }
    }

    private void applyTransformToStroke(Map<String, Map<String, Object>> strokes, String strokeId, JsonNode transform) {
        if (strokeId == null || transform == null) return;
        Map<String, Object> strokeToTransform = strokes.get(strokeId);
        if (strokeToTransform != null) {
            if (transform.has("x")) strokeToTransform.put("x", transform.get("x").asDouble());
            if (transform.has("y")) strokeToTransform.put("y", transform.get("y").asDouble());
            if (transform.has("scaleX")) strokeToTransform.put("scaleX", transform.get("scaleX").asDouble());
            if (transform.has("scaleY")) strokeToTransform.put("scaleY", transform.get("scaleY").asDouble());
            if (transform.has("rotation")) strokeToTransform.put("rotation", transform.get("rotation").asDouble());
            logger.debug("Applied transform to strokeId={}", strokeId);
        }
    }

    private void cleanOldSnapshots(UUID roomId) {
        try {
            List<BoardSnapshot> snapshots = boardSnapshotRepository.findByRoomIdOrderByCreatedAtDesc(roomId);
            if (snapshots.size() > 1) {
                List<BoardSnapshot> toDelete = snapshots.subList(1, snapshots.size());
                boardSnapshotRepository.deleteAll(toDelete);
                logger.info("Successfully deleted {} old snapshots for roomId={}", toDelete.size(), roomId);
            }
        } catch (Exception ex) {
            logger.error("Failed to clean up old board snapshots for roomId={}: ", roomId, ex);
        }
    }

    @org.springframework.scheduling.annotation.Scheduled(fixedRate = 10000)
    public void flushAndCompactAllRooms() {
        if (roomEventsBuffer.isEmpty()) return;

        logger.info("Background task: Flushing and compacting active rooms. Active buffer count: {}", roomEventsBuffer.size());
        for (String roomId : roomEventsBuffer.keySet()) {
            try {
                // Call through the proxy so @Transactional is respected
                self.compactSnapshot(roomId, false);
            } catch (Exception e) {
                logger.error("Failed background flush and compaction for roomId={}: ", roomId, e);
            }
        }
    }
}

