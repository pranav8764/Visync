package com.visync.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

@Service
public class TokenService {

    private static final Logger logger = LoggerFactory.getLogger(TokenService.class);
    private static final String HMAC_ALGO = "HmacSHA256";
    private final String secretKey;

    public TokenService() {
        String envKey = System.getenv("JWT_SECRET");
        if (envKey == null || envKey.isEmpty()) {
            logger.error("JWT_SECRET environment variable is missing! Server cannot sign/validate WebSocket auth tokens.");
            throw new IllegalStateException(
                "JWT_SECRET environment variable must be set. " +
                "Generate one with: openssl rand -base64 32"
            );
        }
        logger.info("JWT_SECRET environment variable successfully loaded.");
        this.secretKey = envKey;
    }

    public String generateToken(String userId, String roomId) {
        long expiry = System.currentTimeMillis() + 86400000L; // 24 hours validity
        String payload = userId + ":" + roomId + ":" + expiry;
        String signature = sign(payload);
        logger.debug("Generating token for userId={}, roomId={}, expiry={}", userId, roomId, expiry);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8)) + "." + signature;
    }

    public boolean validateToken(String token, String expectedUserId, String expectedRoomId) {
        if (token == null) {
            logger.warn("Token validation failed: Token is null");
            return false;
        }
        if (!token.contains(".")) {
            logger.warn("Token validation failed: Token does not contain '.' character");
            return false;
        }
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 2) {
                logger.warn("Token validation failed: Token split parts length is not 2, got {}", parts.length);
                return false;
            }

            String payloadStr = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String signature = parts[1];

            if (!signature.equals(sign(payloadStr))) {
                logger.warn("Token validation failed: Signature mismatch for payload: {}", payloadStr);
                return false;
            }

            String[] payloadParts = payloadStr.split(":");
            if (payloadParts.length != 3) {
                logger.warn("Token validation failed: Payload does not have 3 parts split by ':', got {}", payloadStr);
                return false;
            }

            String userId = payloadParts[0];
            String roomId = payloadParts[1];
            long expiry = Long.parseLong(payloadParts[2]);

            if (System.currentTimeMillis() > expiry) {
                logger.warn("Token validation failed: Token expired at {}, current time is {}", expiry, System.currentTimeMillis());
                return false;
            }

            boolean userIdMatch = userId.equals(expectedUserId);
            boolean roomIdMatch = roomId.equals(expectedRoomId);
            if (!userIdMatch || !roomIdMatch) {
                logger.warn("Token validation failed: Expected userId/roomId mismatch. Expected: {}/{}, Got: {}/{}", 
                        expectedUserId, expectedRoomId, userId, roomId);
                return false;
            }

            logger.debug("Token validation succeeded for userId={}, roomId={}", userId, roomId);
            return true;
        } catch (Exception e) {
            logger.error("Token validation failed with exception: ", e);
            return false;
        }
    }

    public String[] parseTokenWithoutValidation(String token) {
        if (token == null) {
            logger.warn("Parse token without validation failed: Token is null");
            return null;
        }
        if (!token.contains(".")) {
            logger.warn("Parse token without validation failed: Token does not contain '.' character");
            return null;
        }
        try {
            String[] parts = token.split("\\.");
            String payloadStr = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String[] payloadParts = payloadStr.split(":");
            if (payloadParts.length != 3) {
                logger.warn("Parse token without validation failed: Payload does not have 3 parts split by ':', got {}", payloadStr);
                return null;
            }
            return payloadParts;
        } catch (Exception e) {
            logger.error("Parse token without validation failed with exception: ", e);
            return null;
        }
    }

    private String sign(String data) {
        try {
            Mac mac = Mac.getInstance(HMAC_ALGO);
            SecretKeySpec secretKeySpec = new SecretKeySpec(secretKey.getBytes(StandardCharsets.UTF_8), HMAC_ALGO);
            mac.init(secretKeySpec);
            byte[] rawHmac = mac.doFinal(data.getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(rawHmac);
        } catch (Exception e) {
            throw new RuntimeException("Failed to sign token", e);
        }
    }
}

