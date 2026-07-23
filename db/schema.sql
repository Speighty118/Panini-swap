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

-- Admin broadcasts queued for a future date/time (sent by a periodic
-- cron job rather than immediately, unlike the instant broadcast path)
CREATE TABLE scheduled_announcements (
    id              SERIAL PRIMARY KEY,
    title           VARCHAR(255) NOT NULL,
    body            TEXT,
    send_at         TIMESTAMP NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
                    -- pending -> sent, or pending -> cancelled
    created_at      TIMESTAMP DEFAULT NOW(),
    sent_at         TIMESTAMP
);

CREATE INDEX idx_scheduled_announcements_due ON scheduled_announcements(status, send_at);

-- Indexes for the matching query (this is the expensive one)
CREATE INDEX idx_duplicates_user ON user_duplicates(user_id);
CREATE INDEX idx_duplicates_sticker ON user_duplicates(sticker_id);
CREATE INDEX idx_needs_user ON user_needs(user_id);
CREATE INDEX idx_needs_sticker ON user_needs(sticker_id);
CREATE INDEX idx_swaps_users ON swaps(user_a_id, user_b_id);
