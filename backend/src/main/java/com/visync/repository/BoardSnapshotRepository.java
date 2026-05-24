package com.visync.repository;

import com.visync.entity.BoardSnapshot;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface BoardSnapshotRepository extends JpaRepository<BoardSnapshot, UUID> {
    Optional<BoardSnapshot> findFirstByRoomIdOrderByCreatedAtDesc(UUID roomId);
    void deleteByRoomId(UUID roomId);
}
