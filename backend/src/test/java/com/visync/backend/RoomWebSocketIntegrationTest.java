package com.visync.backend;

import com.visync.entity.Room;
import com.visync.repository.RoomRepository;
import com.visync.service.TokenService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Real multi-user WebSocket integration tests: full Spring stack on a random
 * port (H2 test profile), real WS clients through the SockJS raw transport and
 * the auth handshake interceptor.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class RoomWebSocketIntegrationTest {

    @Autowired
    TokenService tokenService;

    @Autowired
    RoomRepository roomRepository;

    @LocalServerPort
    int port;

    static class CollectingHandler extends TextWebSocketHandler {
        final BlockingQueue<String> messages = new LinkedBlockingQueue<>();
        final ConcurrentLinkedQueue<CloseStatus> closeStatuses = new ConcurrentLinkedQueue<>();

        @Override
        protected void handleTextMessage(WebSocketSession session, TextMessage message) {
            messages.add(message.getPayload());
        }

        @Override
        public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
            closeStatuses.add(status);
        }

        /** Poll until a message matching all substrings arrives; non-matching messages are discarded. */
        String waitFor(long timeoutMs, String... substrings) throws InterruptedException {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                String msg = messages.poll(250, TimeUnit.MILLISECONDS);
                if (msg == null) continue;
                boolean all = true;
                for (String s : substrings) if (!msg.contains(s)) { all = false; break; }
                if (all) return msg;
            }
            return null;
        }
    }

    private WebSocketSession connect(String token, CollectingHandler handler) throws Exception {
        StandardWebSocketClient client = new StandardWebSocketClient();
        String url = "ws://localhost:" + port + "/ws/rooms/websocket?token="
                + URLEncoder.encode(token, StandardCharsets.UTF_8);
        return client.execute(handler, url).get(10, TimeUnit.SECONDS);
    }

    @Test
    void twoClientsSyncAndServerOverwritesIdentityFields() throws Exception {
        Room room = roomRepository.save(new Room("itest-sync", "itest"));
        String roomId = room.getId().toString();
        String tokenA = tokenService.generateToken("user-a", roomId);
        String tokenB = tokenService.generateToken("user-b", roomId);

        CollectingHandler handlerA = new CollectingHandler();
        CollectingHandler handlerB = new CollectingHandler();

        try (WebSocketSession sessionA = connect(tokenA, handlerA);
             WebSocketSession sessionB = connect(tokenB, handlerB)) {

            // A joins first and settles; only joined sessions receive broadcasts.
            sessionA.sendMessage(new TextMessage("{\"eventType\":\"USER_JOIN\",\"payload\":{\"username\":\"Alice\"}}"));
            Thread.sleep(400);

            // B joins: B must receive a PRESENCE_LIST naming A, and A must receive B's join broadcast.
            sessionB.sendMessage(new TextMessage("{\"eventType\":\"USER_JOIN\",\"payload\":{\"username\":\"Bob\"}}"));
            String bPresence = handlerB.waitFor(5000, "PRESENCE_LIST", "user-a", "Alice");
            assertThat(bPresence).as("B receives PRESENCE_LIST containing A").isNotNull();
            String aJoin = handlerA.waitFor(5000, "USER_JOIN", "Bob", "user-b");
            assertThat(aJoin).as("A receives B's USER_JOIN broadcast").isNotNull();

            // Spoofing attempt: forged identity fields must be overwritten by the server
            sessionA.sendMessage(new TextMessage(
                    "{\"eventType\":\"DRAW_MOVE\",\"userId\":\"hacker\",\"roomId\":\"other-room\",\"timestamp\":1,"
                            + "\"payload\":{\"point\":{\"x\":10,\"y\":20}}}"));
            String bDraw = handlerB.waitFor(5000, "DRAW_MOVE", "\"x\":10");
            assertThat(bDraw).as("B receives A's DRAW_MOVE").isNotNull();
            assertThat(bDraw).contains("\"userId\":\"user-a\"");
            assertThat(bDraw).contains("\"roomId\":\"" + roomId + "\"");
            assertThat(bDraw).doesNotContain("hacker").doesNotContain("other-room");

            // Sender must not receive its own echo
            String aEcho = handlerA.waitFor(1200, "DRAW_MOVE", "\"x\":10");
            assertThat(aEcho).as("sender does not receive its own echo").isNull();

            // Loopback broadcast latency, 50 DRAW_MOVE events (same machine: not production latency)
            List<Double> latenciesMs = new ArrayList<>();
            for (int i = 0; i < 50; i++) {
                long sendNs = System.nanoTime();
                sessionA.sendMessage(new TextMessage(
                        "{\"eventType\":\"DRAW_MOVE\",\"payload\":{\"point\":{\"x\":" + i + ",\"y\":" + i + "}}}"));
                String received = handlerB.waitFor(5000, "DRAW_MOVE", "\"x\":" + i);
                assertThat(received).as("event %d delivered", i).isNotNull();
                latenciesMs.add((System.nanoTime() - sendNs) / 1_000_000.0);
            }
            latenciesMs.sort(Double::compareTo);
            double avg = latenciesMs.stream().mapToDouble(Double::doubleValue).average().orElseThrow();
            double p95 = latenciesMs.get((int) Math.ceil(0.95 * latenciesMs.size()) - 1);
            double max = latenciesMs.get(latenciesMs.size() - 1);
            System.out.printf("WS_LOOPBACK_LATENCY n=50 avg=%.2fms p95=%.2fms max=%.2fms%n", avg, p95, max);
        }
    }

    @Test
    void joinWhileOthersDrawDoesNotKillSessions() throws Exception {
        Room room = roomRepository.save(new Room("itest-race", "itest"));
        String roomId = room.getId().toString();

        CollectingHandler drawerHandler = new CollectingHandler();
        String drawerToken = tokenService.generateToken("drawer", roomId);

        try (WebSocketSession drawer = connect(drawerToken, drawerHandler)) {
            drawer.sendMessage(new TextMessage("{\"eventType\":\"USER_JOIN\",\"payload\":{\"username\":\"Drawer\"}}"));

            int killedSessions = 0;
            int missingDrawEvents = 0;
            List<WebSocketSession> joiners = new ArrayList<>();
            try {
                for (int round = 0; round < 12; round++) {
                    // Drawer starts streaming points so broadcasts race with the joiner's PRESENCE_LIST send
                    Thread spammer = new Thread(() -> {
                        try {
                            for (int i = 0; i < 80; i++) {
                                drawer.sendMessage(new TextMessage(
                                        "{\"eventType\":\"DRAW_MOVE\",\"payload\":{\"point\":{\"x\":" + i + ",\"y\":0}}}"));
                                Thread.sleep(1);
                            }
                        } catch (Exception ignored) {
                        }
                    });
                    spammer.start();

                    CollectingHandler joinerHandler = new CollectingHandler();
                    String token = tokenService.generateToken("joiner-" + round, roomId);
                    WebSocketSession joiner = connect(token, joinerHandler);
                    joiners.add(joiner);
                    joiner.sendMessage(new TextMessage(
                            "{\"eventType\":\"USER_JOIN\",\"payload\":{\"username\":\"J" + round + "\"}}"));
                    spammer.join(5000);

                    String drawSeen = joinerHandler.waitFor(4000, "DRAW_MOVE");
                    if (drawSeen == null) missingDrawEvents++;
                    Thread.sleep(50);
                    if (!joiner.isOpen()) killedSessions++;
                }
            } finally {
                for (WebSocketSession j : joiners) {
                    if (j.isOpen()) j.close();
                }
            }

            System.out.printf("WS_RACE_RESULT killedSessions=%d missingDrawEvents=%d rounds=12%n",
                    killedSessions, missingDrawEvents);
            assertThat(killedSessions).as("sessions killed by concurrent-send race").isZero();
            assertThat(missingDrawEvents).as("joiners that never saw a DRAW_MOVE").isZero();
        }
    }

    @Test
    void rejectsHandshakeWithInvalidToken() {
        assertThatThrownBy(() -> connect("not-a-real-token", new CollectingHandler()))
                .isInstanceOf(ExecutionException.class);
    }
}
