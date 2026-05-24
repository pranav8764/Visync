package com.visync.repository;

import com.visync.entity.ChatMessage;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.UUID;

@Repository
public interface ChatMessageRepository extends JpaRepository<ChatMessage, UUID> {
    List<ChatMessage> findByRoomIdOrderByTimestampAsc(UUID roomId);
    void deleteByRoomId(UUID roomId);
}
