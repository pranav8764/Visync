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

}
