package com.visync.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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

    private static final Logger logger = LoggerFactory.getLogger(AuthHandshakeInterceptor.class);
    private final TokenService tokenService;

    public AuthHandshakeInterceptor(TokenService tokenService) {
        this.tokenService = tokenService;
    }

    @Override
    public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                                   WebSocketHandler wsHandler, Map<String, Object> attributes) throws Exception {
        logger.debug("Initiating WebSocket handshake for URI: {}", request.getURI());
        
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

        if (token == null) {
            logger.warn("Rejecting WebSocket handshake: Token is missing in query and request parameters. URI={}", request.getURI());
            return false;
        }

        String[] payload = tokenService.parseTokenWithoutValidation(token);
        if (payload == null) {
            logger.warn("Rejecting WebSocket handshake: Token payload cannot be parsed. Token value length={}", token.length());
            return false;
        }

        String userId = payload[0];
        String roomId = payload[1];
        
        if (tokenService.validateToken(token, userId, roomId)) {
            attributes.put("userId", userId);
            attributes.put("roomId", roomId);
            logger.debug("WebSocket handshake successful for userId={}, roomId={}", userId, roomId);
            return true;
        } else {
            logger.warn("Rejecting WebSocket handshake: Token validation failed for userId={}, roomId={}", userId, roomId);
            return false;
        }
    }

    @Override
    public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                               WebSocketHandler wsHandler, Exception exception) {
        if (exception != null) {
            logger.error("Exception occurred during post-handshake callback for URI {}: ", request.getURI(), exception);
        } else {
            logger.debug("Post-handshake completed successfully for URI: {}", request.getURI());
        }
    }
}

