CREATE TABLE IF NOT EXISTS board_strokes (
    id UUID PRIMARY KEY,
    room_id UUID NOT NULL,
    stroke_id VARCHAR(255) NOT NULL,
    stroke_data TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL,
    updated_at TIMESTAMP NOT NULL,
    CONSTRAINT uk_board_strokes_room_stroke UNIQUE (room_id, stroke_id)
);

CREATE INDEX IF NOT EXISTS idx_board_strokes_room ON board_strokes (room_id);
