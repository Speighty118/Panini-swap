CREATE TABLE IF NOT EXISTS apple_support_events (
 event_id TEXT PRIMARY KEY,
 transaction_id TEXT NOT NULL,
 event_type TEXT NOT NULL,
 event_ms BIGINT NOT NULL,
 purchased_at TIMESTAMPTZ NOT NULL,
 user_id INTEGER,
 product_id TEXT NOT NULL,
 currency TEXT,
 amount_minor BIGINT,
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS apple_support_events_transaction ON apple_support_events(transaction_id,event_ms);
CREATE TABLE IF NOT EXISTS apple_support_tracking (
 id INTEGER PRIMARY KEY CHECK(id=1), started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO apple_support_tracking(id) VALUES(1) ON CONFLICT DO NOTHING;

ALTER TABLE apple_support_events ADD COLUMN IF NOT EXISTS record_source TEXT NOT NULL DEFAULT 'webhook';
