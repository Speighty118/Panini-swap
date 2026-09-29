-- Apply only during an explicitly authorized backend release.
CREATE TABLE IF NOT EXISTS founder_native_accounts (
 user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 preserved_founder BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS founder_native_purchases (
 transaction_id TEXT PRIMARY KEY,
 user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
 product_id TEXT NOT NULL,
 active BOOLEAN NOT NULL,
 event_ms BIGINT NOT NULL,
 amount_gbp INTEGER,
 purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS founder_native_purchases_user ON founder_native_purchases(user_id);
CREATE TABLE IF NOT EXISTS founder_native_events (
 event_id TEXT PRIMARY KEY,
 payload JSONB NOT NULL,
 processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
