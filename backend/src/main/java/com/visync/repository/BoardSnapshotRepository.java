package com.visync.repository;

import com.visync.entity.BoardSnapshot;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface BoardSnapshotRepository extends JpaRepository<BoardSnapshot, UUID> {
    Optional<BoardSnapshot> findFirstByRoomIdOrderByCreatedAtDesc(UUID roomId);
    
    @Transactional
    void deleteByRoomId(UUID roomId);
}

