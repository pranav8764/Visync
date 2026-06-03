package com.visync.repository;

import com.visync.entity.DrawingEvent;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;
import java.util.List;
import java.util.UUID;

@Repository
public interface DrawingEventRepository extends JpaRepository<DrawingEvent, UUID> {
    List<DrawingEvent> findByRoomIdOrderByTimestampAsc(UUID roomId);
    
    @Modifying
    @Transactional
    @Query("DELETE FROM DrawingEvent d WHERE d.roomId = :roomId")
    void deleteByRoomId(@Param("roomId") UUID roomId);

    @Modifying
    @Transactional
    @Query("DELETE FROM DrawingEvent d WHERE d.roomId = :roomId AND d.strokeId = :strokeId")
    void deleteByRoomIdAndStrokeId(@Param("roomId") UUID roomId, @Param("strokeId") String strokeId);

    @Modifying
    @Transactional
    @Query("DELETE FROM DrawingEvent d WHERE d.id IN :ids")
    void deleteAllByIds(@Param("ids") List<UUID> ids);
}
