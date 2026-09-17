CREATE TABLE IF NOT EXISTS monitor_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    current_status TEXT,
    available_seats INTEGER,
    availability_text TEXT,
    booking_url TEXT,
    last_success_at TEXT,
    last_checked_at TEXT,
    last_unavailable_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    failure_started_at TEXT,
    last_error TEXT,
    updated_at TEXT
);

INSERT OR IGNORE INTO monitor_state(id) VALUES (1);

CREATE TABLE IF NOT EXISTS monitor_checks (
    id TEXT PRIMARY KEY,
    scheduled_at TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    available_seats INTEGER,
    error TEXT,
    duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_monitor_checks_scheduled
    ON monitor_checks(scheduled_at DESC);

CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitor_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    queued_at TEXT,
    delivered_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(event_id, channel),
    FOREIGN KEY(event_id) REFERENCES monitor_events(id)
);

CREATE INDEX IF NOT EXISTS idx_monitor_deliveries_pending
    ON monitor_deliveries(status, queued_at, id);
