package com.visync.config;

import com.visync.repository.RoomRepository;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

@Component
public class RoomStartupResetRunner implements CommandLineRunner {

    private final RoomRepository roomRepository;

    public RoomStartupResetRunner(RoomRepository roomRepository) {
        this.roomRepository = roomRepository;
    }

    @Override
    public void run(String... args) throws Exception {
        try {
            roomRepository.resetAllActiveRooms();
            System.out.println("Successfully reset all active rooms to inactive on server startup.");
        } catch (Exception e) {
            System.err.println("Failed to reset active rooms on startup: " + e.getMessage());
        }
    }
}
