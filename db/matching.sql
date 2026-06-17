-- ============================================
-- MATCHING QUERY
-- Finds pairs of users where each can give the other
-- at least MIN_MATCH (5) stickers they need.
-- Run as a periodic batch job, not on every page load.
-- ============================================

-- Step 1: "who-needs-what-from-whom" — for every user pair,
-- which of user B's duplicates does user A need?
-- We build this as a reusable view.

CREATE OR REPLACE VIEW v_possible_gives AS
SELECT
    d.user_id   AS giver_id,
    n.user_id   AS receiver_id,
    d.sticker_id
FROM user_duplicates d
JOIN user_needs n ON n.sticker_id = d.sticker_id
WHERE d.user_id <> n.user_id;

-- Step 2: aggregate into pair-level counts, only keep pairs where
-- BOTH directions meet the minimum threshold.

CREATE OR REPLACE FUNCTION find_matches(min_match INTEGER DEFAULT 5)
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
        GROUP BY giver_id, receiver_id
        HAVING COUNT(*) >= min_match
    ),
    b_to_a AS (
        SELECT giver_id AS user_b, receiver_id AS user_a, COUNT(*) AS cnt
        FROM v_possible_gives
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
-- SELECT * FROM find_matches(5);

-- Step 3: once a match is chosen, get the ACTUAL sticker list to propose
-- (call this with the two specific user ids when creating a swap)

CREATE OR REPLACE FUNCTION get_swap_proposal(p_user_a INTEGER, p_user_b INTEGER, min_match INTEGER DEFAULT 5)
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
    WHERE g.giver_id = p_user_a AND g.receiver_id = p_user_b

    UNION ALL

    SELECT 'b_to_a'::VARCHAR(10), s.id, s.sticker_number, p_user_b, p_user_a
    FROM v_possible_gives g
    JOIN stickers s ON s.id = g.sticker_id
    WHERE g.giver_id = p_user_b AND g.receiver_id = p_user_a;
END;
$$ LANGUAGE plpgsql;

-- Usage:
-- SELECT * FROM get_swap_proposal(12, 47);
-- (Then in app code, pick min_match items from each direction —
--  or all of them — to insert into swap_items when the swap is created)
