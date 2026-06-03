package com.visync.config;

import com.visync.service.TokenService;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;

import jakarta.servlet.http.HttpServletRequest;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;

public class AuthHandshakeInterceptor implements HandshakeInterceptor {

    private final TokenService tokenService;

    public AuthHandshakeInterceptor(TokenService tokenService) {
        this.tokenService = tokenService;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) throws Exception {
        String query = request.getURI().getQuery();
        String token = null;
        if (query != null) {
            for (String param : query.split("&")) {
                String[] pair = param.split("=");
                if (pair.length == 2 && "token".equals(pair[0])) {
                    token = URLDecoder.decode(pair[1], StandardCharsets.UTF_8.name());
                    break;
                }
            }
        }

        if (token == null && request instanceof ServletServerHttpRequest) {
            HttpServletRequest servletRequest = ((ServletServerHttpRequest) request).getServletRequest();
            token = servletRequest.getParameter("token");
        }

        if (token != null) {
            String[] payload = tokenService.parseTokenWithoutValidation(token);
            if (payload != null) {
                String userId = payload[0];
                String roomId = payload[1];
                if (tokenService.validateToken(token, userId, roomId)) {
                    attributes.put("userId", userId);
                    attributes.put("roomId", roomId);
                    return true;
                }
            }
        }

        return false;
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        // No-op
    }
}
