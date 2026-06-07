package com.visync.service;

import org.springframework.stereotype.Service;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

@Service
public class TokenService {

    private static final String HMAC_ALGO = "HmacSHA256";
    private final String secretKey;

    public TokenService() {
        String envKey = System.getenv("JWT_SECRET");
        if (envKey == null || envKey.isEmpty()) {
            throw new IllegalStateException(
                "JWT_SECRET environment variable must be set. " +
                "Generate one with: openssl rand -base64 32"
            );
        }
        this.secretKey = envKey;
    }

    public String generateToken(String userId, String roomId) {
        long expiry = System.currentTimeMillis() + 86400000L; // 24 hours validity
        String payload = userId + ":" + roomId + ":" + expiry;
        String signature = sign(payload);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8)) + "." + signature;
    }

    public boolean validateToken(String token, String expectedUserId, String expectedRoomId) {
        if (token == null || !token.contains(".")) {
            return false;
        }
        try {
            String[] parts = token.split("\\.");
            if (parts.length != 2) return false;

            String payloadStr = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String signature = parts[1];

            if (!signature.equals(sign(payloadStr))) {
                return false;
            }

            String[] payloadParts = payloadStr.split(":");
            if (payloadParts.length != 3) return false;

            String userId = payloadParts[0];
            String roomId = payloadParts[1];
            long expiry = Long.parseLong(payloadParts[2]);

            if (System.currentTimeMillis() > expiry) {
                return false;
            }

            return userId.equals(expectedUserId) && roomId.equals(expectedRoomId);
        } catch (Exception e) {
            return false;
        }
    }

    public String[] parseTokenWithoutValidation(String token) {
        if (token == null || !token.contains(".")) {
            return null;
        }
        try {
            String[] parts = token.split("\\.");
            String payloadStr = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String[] payloadParts = payloadStr.split(":");
            if (payloadParts.length != 3) return null;
            return payloadParts;
        } catch (Exception e) {
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
