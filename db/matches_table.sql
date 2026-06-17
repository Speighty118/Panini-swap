-- ============================================
-- MATCHES TABLE
-- Stores output of the periodic find_matches() batch job
-- so the API can read candidates without recomputing live.
-- ============================================

CREATE TABLE matches (
    id              SERIAL PRIMARY KEY,
    user_a_id       INTEGER NOT NULL REFERENCES users(id),
    user_b_id       INTEGER NOT NULL REFERENCES users(id),
    a_gives_b_count INTEGER NOT NULL,
    b_gives_a_count INTEGER NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
                    -- pending -> proposed (swap created) -> stale (superseded by newer run)
    computed_at     TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_a_id, user_b_id)
);

CREATE INDEX idx_matches_user_a ON matches(user_a_id, status);
CREATE INDEX idx_matches_user_b ON matches(user_b_id, status);
