package com.visync.config;

import com.visync.repository.RoomRepository;
import org.springframework.boot.CommandLineRunner;

// Disabled to prevent resetting active room state across multi-instance rolling deployments.
// @org.springframework.stereotype.Component
public class RoomStartupResetRunner implements CommandLineRunner {

    private final RoomRepository roomRepository;

    public RoomStartupResetRunner(RoomRepository roomRepository) {
        this.roomRepository = roomRepository;
    }

    @Override
    public void run(String... args) throws Exception {
        System.out.println("RoomStartupResetRunner is disabled in production environments.");
    }
}
