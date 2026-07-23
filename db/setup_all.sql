-- ============================================
-- PANINI STICKER SWAP — DATABASE SCHEMA
-- PostgreSQL
-- ============================================

-- Users
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255),              -- null if signed up via Facebook OAuth
    facebook_id     VARCHAR(100) UNIQUE,
    address_line1   VARCHAR(255),
    address_line2   VARCHAR(255),
    city            VARCHAR(100),
    postcode        VARCHAR(20),
    country         VARCHAR(100) DEFAULT 'United Kingdom',
    rating_avg      NUMERIC(3,2) DEFAULT 0,    -- e.g. 4.83
    rating_count    INTEGER DEFAULT 0,
    is_verified     BOOLEAN DEFAULT FALSE,     -- e.g. verified FB group member
    is_active       BOOLEAN DEFAULT TRUE,      -- soft ban/deactivate flag
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Master sticker list (seed once per album/edition)
CREATE TABLE albums (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL     -- e.g. "World Cup 2026"
);

CREATE TABLE stickers (
    id              SERIAL PRIMARY KEY,
    album_id        INTEGER NOT NULL REFERENCES albums(id),
    sticker_number  VARCHAR(10) NOT NULL,      -- e.g. "23", "B14" (some albums have lettered subsets)
    team_name       VARCHAR(100),
    description     VARCHAR(255),
    is_shiny        BOOLEAN DEFAULT FALSE,     -- foil/special variants are often separately desired
    UNIQUE(album_id, sticker_number)
);

-- What each user has spare
CREATE TABLE user_duplicates (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id      INTEGER NOT NULL REFERENCES stickers(id),
    quantity        INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, sticker_id)
);

-- What each user needs
CREATE TABLE user_needs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sticker_id      INTEGER NOT NULL REFERENCES stickers(id),
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, sticker_id)
);

-- A proposed/active/completed swap between two users
CREATE TABLE swaps (
    id              SERIAL PRIMARY KEY,
    user_a_id       INTEGER NOT NULL REFERENCES users(id),
    user_b_id       INTEGER NOT NULL REFERENCES users(id),
    album_id        INTEGER NOT NULL REFERENCES albums(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'proposed',
                    -- proposed -> accepted -> posted_a / posted_b -> completed -> rated
                    -- can also be: declined, cancelled, disputed
    user_a_accepted BOOLEAN DEFAULT FALSE,
    user_b_accepted BOOLEAN DEFAULT FALSE,
    user_a_posted   BOOLEAN DEFAULT FALSE,
    user_b_posted   BOOLEAN DEFAULT FALSE,
    user_a_received BOOLEAN DEFAULT FALSE,
    user_b_received BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMP DEFAULT NOW(),
    updated_at      TIMESTAMP DEFAULT NOW(),
    CHECK (user_a_id <> user_b_id)
);

-- The specific stickers involved in a swap (direction matters)
CREATE TABLE swap_items (
    id              SERIAL PRIMARY KEY,
    swap_id         INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
    sticker_id      INTEGER NOT NULL REFERENCES stickers(id),
    from_user_id    INTEGER NOT NULL REFERENCES users(id),
    to_user_id      INTEGER NOT NULL REFERENCES users(id)
);

-- Ratings, given after both sides confirm receipt
CREATE TABLE ratings (
    id              SERIAL PRIMARY KEY,
    swap_id         INTEGER NOT NULL REFERENCES swaps(id),
    rater_id        INTEGER NOT NULL REFERENCES users(id),
    ratee_id        INTEGER NOT NULL REFERENCES users(id),
    stars           INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    comment         VARCHAR(500),
    created_at      TIMESTAMP DEFAULT NOW(),
    UNIQUE(swap_id, rater_id)
);

-- Indexes for the matching query (this is the expensive one)
CREATE INDEX idx_duplicates_user ON user_duplicates(user_id);
CREATE INDEX idx_duplicates_sticker ON user_duplicates(sticker_id);
CREATE INDEX idx_needs_user ON user_needs(user_id);
CREATE INDEX idx_needs_sticker ON user_needs(sticker_id);
CREATE INDEX idx_swaps_users ON swaps(user_a_id, user_b_id);
-- ============================================
-- MATCHES TABLE
-- Stores output of the periodic find_matches() batch job
-- so the API can read candidates without recomputing live.
-- ============================================

CREATE TABLE matches (
    id              SERIAL PRIMARY KEY,
    user_a_id       INTEGER NOT NULL REFERENCES users(id),
    user_b_id       INTEGER NOT NULL REFERENCES users(id),
    album_id        INTEGER NOT NULL REFERENCES albums(id),
    a_gives_b_count INTEGER NOT NULL,
    b_gives_a_count INTEGER NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
                    -- pending -> proposed (swap created) -> stale (superseded by newer run)
    computed_at     TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_a_id, user_b_id, album_id)
);

CREATE INDEX idx_matches_user_a ON matches(user_a_id, album_id, status);
CREATE INDEX idx_matches_user_b ON matches(user_b_id, album_id, status);
-- ============================================
-- MATCHING QUERY
-- Finds pairs of users where each can give the other
-- at least MIN_MATCH (5) stickers they need.
-- Run as a periodic batch job, not on every page load.
-- ============================================

-- Step 1: "who-needs-what-from-whom" — for every user pair,
-- which of user B's duplicates does user A need?
-- We build this as a reusable view.

-- NOTE: excludes stickers already locked into an active (proposed/accepted)
-- swap, so the same duplicate can't be matched into two swaps at once.
-- Also exposes album_id (joined from stickers) so matches/proposals can be
-- scoped to a single album — without this, two users active in more than
-- one album would get their swap candidates silently blended together.
CREATE OR REPLACE VIEW v_possible_gives AS
SELECT
    d.user_id   AS giver_id,
    n.user_id   AS receiver_id,
    d.sticker_id,
    s.album_id  AS album_id
FROM user_duplicates d
JOIN user_needs n ON n.sticker_id = d.sticker_id
JOIN stickers s ON s.id = d.sticker_id
WHERE d.user_id <> n.user_id
  AND NOT EXISTS (
    SELECT 1
    FROM swap_items si
    JOIN swaps sw ON sw.id = si.swap_id
    WHERE si.sticker_id = d.sticker_id
      AND si.from_user_id = d.user_id
      AND sw.status IN ('proposed', 'accepted')
  );

-- Step 2: aggregate into pair-level counts, only keep pairs where
-- BOTH directions meet the minimum threshold, scoped to one album.

CREATE OR REPLACE FUNCTION find_matches(min_match INTEGER DEFAULT 5, p_album_id INTEGER DEFAULT 1)
RETURNS TABLE (
    user_a INTEGER,
    user_b INTEGER,
    a_gives_b_count INTEGER,
    b_gives_a_count INTEGER
) AS $$
BEGIN
    RETURN QUERY
    WITH a_to_b AS (
        SELECT giver_id AS user_a, receiver_id AS user_b, COUNT(*) AS cnt
        FROM v_possible_gives
        WHERE album_id = p_album_id
        GROUP BY giver_id, receiver_id
        HAVING COUNT(*) >= min_match
    ),
    b_to_a AS (
        SELECT giver_id AS user_b, receiver_id AS user_a, COUNT(*) AS cnt
        FROM v_possible_gives
        WHERE album_id = p_album_id
        GROUP BY giver_id, receiver_id
        HAVING COUNT(*) >= min_match
    )
    SELECT
        a.user_a,
        a.user_b,
        a.cnt::INTEGER AS a_gives_b_count,
        b.cnt::INTEGER AS b_gives_a_count
    FROM a_to_b a
    JOIN b_to_a b ON a.user_a = b.user_a AND a.user_b = b.user_b
    WHERE a.user_a < a.user_b;  -- dedupe (A,B) vs (B,A)
END;
$$ LANGUAGE plpgsql;

-- Usage:
-- SELECT * FROM find_matches(5, 1);  -- album_id 1 = World Cup 2026

-- Step 3: once a match is chosen, get the ACTUAL sticker list to propose
-- (call this with the two specific user ids when creating a swap)

CREATE OR REPLACE FUNCTION get_swap_proposal(p_user_a INTEGER, p_user_b INTEGER, min_match INTEGER DEFAULT 5, p_album_id INTEGER DEFAULT 1)
RETURNS TABLE (
    direction       VARCHAR(10),
    sticker_id      INTEGER,
    sticker_number  VARCHAR(10),
    from_user_id    INTEGER,
    to_user_id      INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 'a_to_b'::VARCHAR(10), s.id, s.sticker_number, p_user_a, p_user_b
    FROM v_possible_gives g
    JOIN stickers s ON s.id = g.sticker_id
    WHERE g.giver_id = p_user_a AND g.receiver_id = p_user_b AND g.album_id = p_album_id

    UNION ALL

    SELECT 'b_to_a'::VARCHAR(10), s.id, s.sticker_number, p_user_b, p_user_a
    FROM v_possible_gives g
    JOIN stickers s ON s.id = g.sticker_id
    WHERE g.giver_id = p_user_b AND g.receiver_id = p_user_a AND g.album_id = p_album_id;
END;
$$ LANGUAGE plpgsql;

-- Usage:
-- SELECT * FROM get_swap_proposal(12, 47, 5, 1);
-- (Then in app code, pick min_match items from each direction —
--  or all of them — to insert into swap_items when the swap is created)
