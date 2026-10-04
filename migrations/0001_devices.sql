-- One row per phone that turned on nudges. Holds only what is needed to send a
-- reminder: the push address, the reminder schedule and two timestamps.
-- No water amounts ever reach the server.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,            -- sha256(endpoint), hex
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  origin TEXT NOT NULL,           -- app origin, used as the VAPID contact
  tz TEXT NOT NULL,
  interval_min INTEGER NOT NULL,
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL,
  smart INTEGER NOT NULL DEFAULT 1,
  last_sip_at INTEGER,            -- epoch ms of the last logged drink (no amount)
  quiet_until INTEGER,            -- epoch ms; no nudges before this (goal reached)
  next_at INTEGER NOT NULL,       -- epoch ms of the next nudge
  last_nudge_at INTEGER,
  last_test_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX devices_next_at ON devices (next_at);
