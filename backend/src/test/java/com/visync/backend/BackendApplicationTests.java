package com.visync.backend;

import com.visync.service.BoardService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class BackendApplicationTests {

    @Autowired
    private BoardService boardService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void contextLoads() {
    }

    @Test
    void storesCompletedStrokesAndAppliesIncrementalTransforms() throws Exception {
        String roomId = UUID.randomUUID().toString();
        JsonNode completedStroke = objectMapper.readTree("""
                {
                  "stroke": {
                    "id": "stroke-1",
                    "userId": "untrusted-user",
                    "tool": "pen",
                    "color": "#000000",
                    "strokeWidth": 2,
                    "points": [{"x": 1, "y": 2}, {"x": 3, "y": 4}]
                  }
                }
                """);

        boardService.saveCompletedStroke(roomId, "authenticated-user", completedStroke);
        boardService.applyObjectMutation(roomId, "OBJECT_TRANSFORM", objectMapper.readTree("""
                {"strokeId": "stroke-1", "transform": {"x": 25, "rotation": 15}}
                """));

        JsonNode board = objectMapper.readTree(boardService.getBoardState(UUID.fromString(roomId)));
        assertThat(board.size()).isEqualTo(1);
        assertThat(board.get(0).get("userId").asText()).isEqualTo("authenticated-user");
        assertThat(board.get(0).get("points").size()).isEqualTo(2);
        assertThat(board.get(0).get("x").asInt()).isEqualTo(25);
        assertThat(board.get(0).get("rotation").asInt()).isEqualTo(15);
    }

    @Test
    void persistsTextContentAndTypographyUpdates() throws Exception {
        String roomId = UUID.randomUUID().toString();
        boardService.saveCompletedStroke(roomId, "text-author", objectMapper.readTree("""
                {
                  "stroke": {
                    "id": "text-1",
                    "tool": "text",
                    "color": "#000000",
                    "strokeWidth": 0,
                    "points": [{"x": 10, "y": 20}],
                    "text": "Draft",
                    "textWidth": 240,
                    "textHeight": 29,
                    "fontSize": 24,
                    "fontFamily": "Arial",
                    "fontStyle": "normal",
                    "textDecoration": ""
                  }
                }
                """));

        boardService.applyObjectMutation(roomId, "OBJECT_UPDATE", objectMapper.readTree("""
                {
                  "strokeId": "text-1",
                  "patch": {
                    "text": "Final copy",
                    "fontSize": 36,
                    "fontFamily": "Georgia",
                    "fontStyle": "bold italic",
                    "textDecoration": "underline",
                    "color": "#2563eb"
                  }
                }
                """));

        JsonNode text = objectMapper.readTree(boardService.getBoardState(UUID.fromString(roomId))).get(0);
        assertThat(text.get("text").asText()).isEqualTo("Final copy");
        assertThat(text.get("fontSize").asInt()).isEqualTo(36);
        assertThat(text.get("fontFamily").asText()).isEqualTo("Georgia");
        assertThat(text.get("fontStyle").asText()).isEqualTo("bold italic");
        assertThat(text.get("textDecoration").asText()).isEqualTo("underline");
        assertThat(text.get("color").asText()).isEqualTo("#2563eb");
    }

    @Test
    void persistsShapeStyleUpdates() throws Exception {
        String roomId = UUID.randomUUID().toString();
        boardService.saveCompletedStroke(roomId, "shape-author", objectMapper.readTree("""
                {
                  "stroke": {
                    "id": "shape-1",
                    "tool": "rect",
                    "color": "#1b1b1f",
                    "strokeWidth": 2,
                    "fill": "transparent",
                    "points": [{"x": 10, "y": 20}, {"x": 110, "y": 80}]
                  }
                }
                """));

        boardService.applyObjectMutation(roomId, "OBJECT_UPDATE", objectMapper.readTree("""
                {
                  "strokeId": "shape-1",
                  "patch": {
                    "color": "#1971c2",
                    "fill": "#a5d8ff",
                    "fillStyle": "cross-hatch",
                    "strokeWidth": 8,
                    "strokeStyle": "dashed",
                    "roughness": 2,
                    "roundness": "sharp",
                    "opacity": 0.6,
                    "zIndex": 3
                  }
                }
                """));

        JsonNode shape = objectMapper.readTree(boardService.getBoardState(UUID.fromString(roomId))).get(0);
        assertThat(shape.get("color").asText()).isEqualTo("#1971c2");
        assertThat(shape.get("fill").asText()).isEqualTo("#a5d8ff");
        assertThat(shape.get("fillStyle").asText()).isEqualTo("cross-hatch");
        assertThat(shape.get("strokeWidth").asInt()).isEqualTo(8);
        assertThat(shape.get("strokeStyle").asText()).isEqualTo("dashed");
        assertThat(shape.get("roughness").asInt()).isEqualTo(2);
        assertThat(shape.get("roundness").asText()).isEqualTo("sharp");
        assertThat(shape.get("opacity").asDouble()).isEqualTo(0.6);
        assertThat(shape.get("zIndex").asInt()).isEqualTo(3);
    }

}
