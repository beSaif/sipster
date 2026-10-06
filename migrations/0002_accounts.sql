-- Accounts, friends and the leaderboard. Signing in stays optional: the app works exactly as
-- before without an account, and the `devices` table keeps serving nudges on its own.
-- Timestamps are Unix milliseconds. Days are the user's local date as 'YYYY-MM-DD'.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT NOT NULL UNIQUE,          -- Google's stable account id (OpenID Connect `sub`)
  email       TEXT NOT NULL UNIQUE,          -- verified by Google, lower-cased; follows the Google account
  username    TEXT UNIQUE COLLATE NOCASE,    -- chosen after the first sign-in; NULL until then
  social_push INTEGER NOT NULL DEFAULT 1,    -- push notifications for friend requests and co.
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,               -- sha256(token) hex
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

-- One-time codes handed to the browser right after a Google sign-in (docs/SOCIAL.md, "Handoff").
CREATE TABLE login_codes (
  id         TEXT PRIMARY KEY,               -- sha256(code) hex
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- What the leaderboard is built from: one row per account and local day.
CREATE TABLE daily_totals (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,                  -- 'YYYY-MM-DD', the user's local date
  ml         INTEGER NOT NULL,
  goal_ml    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- A row per request; `pending` becomes `accepted` in place. Never two rows for the same pair.
CREATE TABLE friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX friendships_addressee ON friendships(addressee_id, status);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who sees it
  kind       TEXT NOT NULL,                  -- friend_request | friend_accepted | goal_reached
  actor_id   TEXT REFERENCES users(id) ON DELETE CASCADE,            -- who caused it
  ref        TEXT,                           -- goal_reached: the day it was reached
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX notifications_user ON notifications(user_id, created_at);

-- A phone that is signed in also receives its account's social pushes.
ALTER TABLE devices ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX devices_user ON devices(user_id);
