package com.visync.service;

import com.visync.entity.BoardSnapshot;
import com.visync.entity.BoardStroke;
import com.visync.entity.DrawingEvent;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.BoardStrokeRepository;
import com.visync.repository.DrawingEventRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@Service
@Transactional
public class BoardService {

    private static final Logger logger = LoggerFactory.getLogger(BoardService.class);

    private final DrawingEventRepository drawingEventRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final BoardStrokeRepository boardStrokeRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public BoardService(
            DrawingEventRepository drawingEventRepository,
            BoardSnapshotRepository boardSnapshotRepository,
            BoardStrokeRepository boardStrokeRepository) {
        this.drawingEventRepository = drawingEventRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
        this.boardStrokeRepository = boardStrokeRepository;
    }

    public void saveCompletedStroke(String roomId, String userId, JsonNode payload) {
        if (payload == null) return;

        JsonNode stroke = payload.has("stroke") ? payload.get("stroke") : null;
        if (stroke == null || !stroke.isObject()) {
            logger.warn("Ignoring DRAW_END without a complete stroke for roomId={}", roomId);
            return;
        }

        ObjectNode normalized = ((ObjectNode) stroke).deepCopy();
        normalized.put("userId", userId);
        upsertStroke(UUID.fromString(roomId), normalized);
    }

    public void applyObjectMutation(String roomId, String eventType, JsonNode payload) {
        if (payload == null) return;
        UUID roomUuid = UUID.fromString(roomId);

        switch (eventType) {
            case "OBJECT_TRANSFORM" -> applyTransforms(roomUuid, payload);
            case "OBJECT_DUPLICATE" -> {
                JsonNode strokes = payload.get("strokes");
                if (strokes != null && strokes.isArray()) {
                    for (JsonNode stroke : strokes) upsertStroke(roomUuid, stroke);
                }
            }
            case "OBJECT_DELETE" -> deleteStrokeIds(roomUuid, payload.get("strokeIds"));
            default -> logger.warn("Unsupported board mutation type={}", eventType);
        }
    }

    public String getBoardState(UUID roomId) {
        migrateLegacyRoomIfNeeded(roomId);
        List<JsonNode> strokes = new ArrayList<>();
        for (BoardStroke row : boardStrokeRepository.findByRoomIdOrderByCreatedAtAsc(roomId)) {
            try {
                strokes.add(objectMapper.readTree(row.getStrokeData()));
            } catch (Exception e) {
                logger.error("Skipping corrupt stroke row id={} roomId={}", row.getId(), roomId, e);
            }
        }
        try {
            return objectMapper.writeValueAsString(strokes);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to serialize board state for room " + roomId, e);
        }
    }

    public List<DrawingEvent> getRecentEvents(UUID roomId) {
        migrateLegacyRoomIfNeeded(roomId);
        return List.of();
    }

    public void clearBoard(String roomId) {
        UUID roomUuid = UUID.fromString(roomId);
        boardStrokeRepository.deleteByRoomId(roomUuid);
        drawingEventRepository.deleteByRoomId(roomUuid);
        boardSnapshotRepository.deleteByRoomId(roomUuid);
        logger.info("Cleared board data for roomId={}", roomId);
    }

    public void undoStroke(String roomId, String strokeId) {
        UUID roomUuid = UUID.fromString(roomId);
        migrateLegacyRoomIfNeeded(roomUuid);
        boardStrokeRepository.deleteByRoomIdAndStrokeId(roomUuid, strokeId);
    }

    public void redoStroke(String roomId, String userId, JsonNode strokeNode) {
        if (strokeNode == null || !strokeNode.isObject()) return;
        ObjectNode normalized = ((ObjectNode) strokeNode).deepCopy();
        normalized.put("userId", userId);
        upsertStroke(UUID.fromString(roomId), normalized);
    }

    // Kept as a compatibility hook for connection-close callers. New writes are
    // already incrementally compacted into board_strokes.
    public void compactSnapshot(String roomId, boolean force) {
        migrateLegacyRoomIfNeeded(UUID.fromString(roomId));
    }

    private void upsertStroke(UUID roomId, JsonNode stroke) {
        String strokeId = text(stroke, "id");
        if (strokeId == null || strokeId.isBlank()) {
            logger.warn("Ignoring completed stroke without id for roomId={}", roomId);
            return;
        }
        try {
            String data = objectMapper.writeValueAsString(stroke);
            BoardStroke row = boardStrokeRepository.findByRoomIdAndStrokeId(roomId, strokeId)
                    .orElseGet(() -> new BoardStroke(roomId, strokeId, data));
            row.setStrokeData(data);
            boardStrokeRepository.save(row);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to persist stroke " + strokeId, e);
        }
    }

    private void applyTransforms(UUID roomId, JsonNode payload) {
        JsonNode transforms = payload.get("transforms");
        if (transforms != null && transforms.isArray()) {
            for (JsonNode item : transforms) {
                applyTransform(roomId, text(item, "strokeId"), item.get("transform"));
            }
        } else {
            applyTransform(roomId, text(payload, "strokeId"), payload.get("transform"));
        }
    }

    private void applyTransform(UUID roomId, String strokeId, JsonNode transform) {
        if (strokeId == null || transform == null || !transform.isObject()) return;
        boardStrokeRepository.findByRoomIdAndStrokeId(roomId, strokeId).ifPresent(row -> {
            try {
                ObjectNode stroke = (ObjectNode) objectMapper.readTree(row.getStrokeData());
                copyIfPresent(transform, stroke, "x");
                copyIfPresent(transform, stroke, "y");
                copyIfPresent(transform, stroke, "scaleX");
                copyIfPresent(transform, stroke, "scaleY");
                copyIfPresent(transform, stroke, "rotation");
                row.setStrokeData(objectMapper.writeValueAsString(stroke));
                boardStrokeRepository.save(row);
            } catch (Exception e) {
                throw new IllegalStateException("Failed to transform stroke " + strokeId, e);
            }
        });
    }

    private void deleteStrokeIds(UUID roomId, JsonNode idsNode) {
        if (idsNode == null || !idsNode.isArray()) return;
        List<String> ids = new ArrayList<>();
        for (JsonNode id : idsNode) ids.add(id.asText());
        if (!ids.isEmpty()) boardStrokeRepository.deleteByRoomIdAndStrokeIdIn(roomId, ids);
    }

    private void migrateLegacyRoomIfNeeded(UUID roomId) {
        if (boardStrokeRepository.existsByRoomId(roomId)) return;

        Map<String, ObjectNode> strokes = readLegacySnapshot(roomId);
        applyLegacyEvents(strokes, drawingEventRepository.findByRoomIdOrderByTimestampAsc(roomId));
        if (strokes.isEmpty()) return;

        for (ObjectNode stroke : strokes.values()) upsertStroke(roomId, stroke);
        drawingEventRepository.deleteByRoomId(roomId);
        boardSnapshotRepository.deleteByRoomId(roomId);
        logger.info("Migrated {} legacy strokes for roomId={}", strokes.size(), roomId);
    }

    private Map<String, ObjectNode> readLegacySnapshot(UUID roomId) {
        Map<String, ObjectNode> strokes = new LinkedHashMap<>();
        Optional<BoardSnapshot> snapshot = boardSnapshotRepository.findFirstByRoomIdOrderByCreatedAtDesc(roomId);
        if (snapshot.isEmpty()) return strokes;
        try {
            JsonNode state = objectMapper.readTree(snapshot.get().getBoardState());
            if (state.isArray()) {
                for (JsonNode stroke : state) {
                    String id = text(stroke, "id");
                    if (id != null && stroke.isObject()) strokes.put(id, ((ObjectNode) stroke).deepCopy());
                }
            }
        } catch (Exception e) {
            logger.error("Failed to parse legacy snapshot for roomId={}", roomId, e);
        }
        return strokes;
    }

    private void applyLegacyEvents(Map<String, ObjectNode> strokes, List<DrawingEvent> events) {
        for (DrawingEvent event : events) {
            try {
                JsonNode payload = objectMapper.readTree(event.getPayload());
                String strokeId = text(payload, "strokeId");
                switch (event.getEventType()) {
                    case "DRAW_START" -> {
                        if (strokeId == null) break;
                        ObjectNode stroke = objectMapper.createObjectNode();
                        stroke.put("id", strokeId);
                        stroke.put("userId", event.getUserId());
                        stroke.put("color", payload.has("color") ? payload.get("color").asText() : "#000000");
                        stroke.put("strokeWidth", payload.has("strokeWidth") ? payload.get("strokeWidth").asInt() : 2);
                        stroke.put("tool", payload.has("tool") ? payload.get("tool").asText() : "pen");
                        stroke.putArray("points");
                        strokes.put(strokeId, stroke);
                    }
                    case "DRAW_MOVE" -> appendLegacyPoint(strokes.get(strokeId), payload.get("point"));
                    case "DRAW_END" -> {
                        ObjectNode stroke = strokes.get(strokeId);
                        if (stroke != null && payload.has("points")) stroke.set("points", payload.get("points"));
                    }
                    case "OBJECT_TRANSFORM" -> applyLegacyTransform(strokes, payload);
                    case "OBJECT_DUPLICATE" -> {
                        JsonNode copies = payload.get("strokes");
                        if (copies != null && copies.isArray()) {
                            for (JsonNode copy : copies) {
                                String id = text(copy, "id");
                                if (id != null && copy.isObject()) strokes.put(id, ((ObjectNode) copy).deepCopy());
                            }
                        }
                    }
                    case "OBJECT_DELETE" -> {
                        JsonNode ids = payload.get("strokeIds");
                        if (ids != null && ids.isArray()) for (JsonNode id : ids) strokes.remove(id.asText());
                    }
                    default -> { }
                }
            } catch (Exception e) {
                logger.error("Failed to apply legacy event id={}", event.getId(), e);
            }
        }
    }

    private void appendLegacyPoint(ObjectNode stroke, JsonNode point) {
        if (stroke == null || point == null) return;
        String tool = stroke.has("tool") ? stroke.get("tool").asText() : "pen";
        var points = stroke.withArray("points");
        if ("pen".equals(tool) || points.size() < 2) points.add(point);
        else points.set(1, point);
    }

    private void applyLegacyTransform(Map<String, ObjectNode> strokes, JsonNode payload) {
        JsonNode transforms = payload.get("transforms");
        if (transforms != null && transforms.isArray()) {
            for (JsonNode item : transforms) {
                applyTransformNode(strokes.get(text(item, "strokeId")), item.get("transform"));
            }
        } else {
            applyTransformNode(strokes.get(text(payload, "strokeId")), payload.get("transform"));
        }
    }

    private void applyTransformNode(ObjectNode stroke, JsonNode transform) {
        if (stroke == null || transform == null) return;
        copyIfPresent(transform, stroke, "x");
        copyIfPresent(transform, stroke, "y");
        copyIfPresent(transform, stroke, "scaleX");
        copyIfPresent(transform, stroke, "scaleY");
        copyIfPresent(transform, stroke, "rotation");
    }

    private void copyIfPresent(JsonNode source, ObjectNode target, String field) {
        if (source.has(field)) target.set(field, source.get(field));
    }

    private String text(JsonNode node, String field) {
        return node != null && node.has(field) ? node.get(field).asText() : null;
    }
}
