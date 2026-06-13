package com.visync.repository;

import com.visync.entity.ChatMessage;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.UUID;

@Repository
public interface ChatMessageRepository extends JpaRepository<ChatMessage, UUID> {
    List<ChatMessage> findByRoomIdOrderByTimestampAsc(UUID roomId);

    // Paginated query: fetch the most recent N messages (ordered newest-first for the query,
    // then reversed in the service/controller to deliver them in chronological order)
    List<ChatMessage> findByRoomIdOrderByTimestampDesc(UUID roomId, Pageable pageable);

    @Transactional
    void deleteByRoomId(UUID roomId);
}
