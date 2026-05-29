package com.visync.repository;

import com.visync.entity.Room;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;
import java.util.UUID;

@Repository
public interface RoomRepository extends JpaRepository<Room, UUID> {
    @org.springframework.data.jpa.repository.Modifying
    @org.springframework.data.jpa.repository.Query("UPDATE Room r SET r.isActive = false WHERE r.isActive = true")
    @org.springframework.transaction.annotation.Transactional
    void resetAllActiveRooms();
}
