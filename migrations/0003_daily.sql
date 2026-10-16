-- 日次: 日経225オプションの行使価格別 建玉・清算値段
CREATE TABLE IF NOT EXISTS daily_strikes (
  trade_date TEXT NOT NULL,      -- YYYY-MM-DD
  month      TEXT NOT NULL,      -- YYYYMM (限月)
  strike     INTEGER NOT NULL,
  put_oi     INTEGER, put_chg INTEGER, put_vol INTEGER, put_px REAL, put_iv REAL,
  call_oi    INTEGER, call_chg INTEGER, call_vol INTEGER, call_px REAL, call_iv REAL,
  PRIMARY KEY (trade_date, month, strike)
);

-- 日次サマリー(分析結果)
CREATE TABLE IF NOT EXISTS daily_snapshots (
  trade_date  TEXT PRIMARY KEY,
  spot        REAL NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_posts (
  trade_date TEXT PRIMARY KEY,
  tweet_id   TEXT,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
