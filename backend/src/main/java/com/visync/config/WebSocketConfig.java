package com.visync.config;

import com.visync.ws.RoomWebSocketHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Repository;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@Repository
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final RoomWebSocketHandler handler;
    
    public WebSocketConfig(RoomWebSocketHandler handler) { 
        this.handler = handler; 
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/rooms")
                .setAllowedOriginPatterns("*")
                .withSockJS();
    }
}