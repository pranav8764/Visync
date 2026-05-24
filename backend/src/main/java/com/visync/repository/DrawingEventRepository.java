package com.visync.repository;

import com.visync.entity.DrawingEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.List;
import java.util.UUID;

@Repository
public interface DrawingEventRepository extends JpaRepository<DrawingEvent, UUID> {
    List<DrawingEvent> findByRoomIdOrderByTimestampAsc(UUID roomId);
    void deleteByRoomId(UUID roomId);
}
