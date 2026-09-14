-- The question box: every question asked, what it cost, and the settings that bound it.
--
-- One row per question, written before the model is called, with the most that
-- question could cost reserved in cost_usd. The daily cap is a SUM over today's rows,
-- so two questions arriving together both see both reservations and neither can spend
-- past it. The row is corrected to the real cost when the answer comes back.
--
-- No IP address is stored: ip_hash is a hash of the address and the day, enough to
-- count one visitor's questions in an hour and nothing that follows them across days.

CREATE TABLE ask_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  asked_at      TEXT NOT NULL,
  day           TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  question      TEXT NOT NULL,
  -- pending, answered, error, resting-cap, resting-rate, resting-off
  status        TEXT NOT NULL,
  answer        TEXT,
  view_url      TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_ask_log_day ON ask_log(day);
CREATE INDEX idx_ask_log_ip ON ask_log(ip_hash, asked_at);

-- Settings a person changes without a deploy. daily_cap_usd is read on every question;
-- absent means $0.10.
CREATE TABLE ask_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
