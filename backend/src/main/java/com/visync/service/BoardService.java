package com.visync.service;

import com.visync.entity.BoardSnapshot;
import com.visync.entity.DrawingEvent;
import com.visync.repository.BoardSnapshotRepository;
import com.visync.repository.DrawingEventRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.*;

@Service
@Transactional
public class BoardService {

    private final DrawingEventRepository drawingEventRepository;
    private final BoardSnapshotRepository boardSnapshotRepository;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public BoardService(DrawingEventRepository drawingEventRepository,
            BoardSnapshotRepository boardSnapshotRepository) {
        this.drawingEventRepository = drawingEventRepository;
        this.boardSnapshotRepository = boardSnapshotRepository;
    }

    public void clearBoard(String roomId) {
        UUID rId = UUID.fromString(roomId);
        drawingEventRepository.deleteByRoomId(rId);
        boardSnapshotRepository.deleteByRoomId(rId);
    }

    public void compactSnapshot(String roomId) {
        compactSnapshot(roomId, false);
    }

    public void compactSnapshot(String roomId, boolean force) {
        UUID rId = UUID.fromString(roomId);
        List<DrawingEvent> allEvents = drawingEventRepository.findByRoomIdOrderByTimestampAsc(rId);

        if (allEvents.isEmpty()) {
            return;
        }

        if (force || allEvents.size() > 100) {
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
                    System.err.println("Failed to parse existing board snapshot state: " + ex.getMessage());
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
                            break;
                    }
                } catch (Exception ex) {
                    System.err.println("Error parsing event payload during compaction: " + ex.getMessage());
                }
            }

            try {
                String newSnapshotState = objectMapper.writeValueAsString(new ArrayList<>(strokes.values()));
                BoardSnapshot newSnapshot = new BoardSnapshot(rId, newSnapshotState);
                boardSnapshotRepository.save(newSnapshot);

                drawingEventRepository.deleteByRoomId(rId);
            } catch (Exception ex) {
                System.err.println("Failed to save snapshot or delete events: " + ex.getMessage());
            }
        }
    }
}
