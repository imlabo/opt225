-- 翌営業日予測と答え合わせ
CREATE TABLE IF NOT EXISTS predictions (
  trade_date    TEXT PRIMARY KEY,   -- 予測を出した日(この日の引け時点のデータ)
  spot          REAL NOT NULL,
  p_up          REAL NOT NULL,
  call          TEXT NOT NULL,      -- up | down | flat
  range_lo      REAL NOT NULL,
  range_hi      REAL NOT NULL,
  sigma1d       REAL NOT NULL,
  features_json TEXT NOT NULL,
  detail_json   TEXT NOT NULL,
  actual_date   TEXT,               -- 答え合わせに使った翌営業日
  actual_spot   REAL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | evaluated | skipped
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 学習履歴(重みの推移を可視化・監査するため)
CREATE TABLE IF NOT EXISTS model_log (
  trade_date   TEXT PRIMARY KEY,
  n            INTEGER NOT NULL,
  weights_json TEXT NOT NULL,
  k            REAL NOT NULL,
  metrics_json TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
