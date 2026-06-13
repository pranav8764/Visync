package com.visync.repository;

import com.visync.entity.BoardStroke;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Repository
public interface BoardStrokeRepository extends JpaRepository<BoardStroke, UUID> {
    List<BoardStroke> findByRoomIdOrderByCreatedAtAsc(UUID roomId);
    Optional<BoardStroke> findByRoomIdAndStrokeId(UUID roomId, String strokeId);
    void deleteByRoomIdAndStrokeId(UUID roomId, String strokeId);
    void deleteByRoomIdAndStrokeIdIn(UUID roomId, List<String> strokeIds);
    void deleteByRoomId(UUID roomId);
    boolean existsByRoomId(UUID roomId);
}
