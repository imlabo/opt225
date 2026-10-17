-- 市場心理指数
CREATE TABLE IF NOT EXISTS fg_nikkei (
  date            TEXT PRIMARY KEY,
  score           REAL NOT NULL,
  rating          TEXT NOT NULL,
  components_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fg_cnn (
  date   TEXT PRIMARY KEY,
  score  REAL NOT NULL,
  rating TEXT NOT NULL
);
-- CNN の前日・1週前などの参考値(最新のみ)
CREATE TABLE IF NOT EXISTS fg_meta (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
