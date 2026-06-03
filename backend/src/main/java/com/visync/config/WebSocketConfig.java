package com.visync.config;

import com.visync.ws.RoomWebSocketHandler;
import com.visync.service.TokenService;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.stereotype.Repository;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@Repository
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final RoomWebSocketHandler handler;
    private final TokenService tokenService;
    
    public WebSocketConfig(RoomWebSocketHandler handler, TokenService tokenService) { 
        this.handler = handler; 
        this.tokenService = tokenService;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/rooms")
                .setAllowedOriginPatterns("*")
                .addInterceptors(new AuthHandshakeInterceptor(tokenService))
                .withSockJS();
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        container.setMaxTextMessageBufferSize(65536); // 64KB
        container.setMaxBinaryMessageBufferSize(65536); // 64KB
        return container;
    }
}