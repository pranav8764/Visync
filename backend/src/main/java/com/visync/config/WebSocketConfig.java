package com.visync.config;

import com.visync.ws.RoomWebSocketHandler;
import com.visync.service.TokenService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final RoomWebSocketHandler handler;
    private final TokenService tokenService;

    @Value("${visync.cors.allowed-origins:http://localhost:3000,http://localhost:3001,http://10.191.177.243:3000,http://10.191.177.243:3001}")
    private String allowedOrigins;
    
    public WebSocketConfig(RoomWebSocketHandler handler, TokenService tokenService) { 
        this.handler = handler; 
        this.tokenService = tokenService;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/rooms")
                .setAllowedOriginPatterns(allowedOrigins.split(","))
                .addInterceptors(new AuthHandshakeInterceptor(tokenService))
                .withSockJS();
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(65536); // 64KB
        container.setMaxBinaryMessageBufferSize(65536); // 64KB
        // Close idle sessions after 2 minutes to prevent memory leaks from
        // abruptly disconnected clients (Wi-Fi drop, laptop lid close, etc.)
        container.setMaxSessionIdleTimeout(120000L);
        return container;
    }
}