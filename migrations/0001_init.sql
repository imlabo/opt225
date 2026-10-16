-- 週ごとの取得メタデータ
CREATE TABLE IF NOT EXISTS weeks (
  week_end    TEXT PRIMARY KEY,          -- YYYY-MM-DD (週の最終営業日)
  week_start  TEXT NOT NULL,
  source_url  TEXT,
  is_sample   INTEGER NOT NULL DEFAULT 0,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 投資部門別の売買枚数
-- product: 'call' | 'put' | 'fut'(日経225先物ラージ換算)
-- investor: 'individual' | 'corporate' | 'foreign' | 'securities' | 'proprietary'
CREATE TABLE IF NOT EXISTS flows (
  week_end  TEXT NOT NULL REFERENCES weeks(week_end) ON DELETE CASCADE,
  product   TEXT NOT NULL,
  investor  TEXT NOT NULL,
  sell      INTEGER NOT NULL,
  buy       INTEGER NOT NULL,
  PRIMARY KEY (week_end, product, investor)
);

-- 分析結果(週ごと)
CREATE TABLE IF NOT EXISTS analyses (
  week_end    TEXT PRIMARY KEY REFERENCES weeks(week_end) ON DELETE CASCADE,
  score       REAL NOT NULL,             -- -100(下落) .. +100(上昇)
  bias        TEXT NOT NULL,
  vol_signal  TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- X投稿ログ(二重投稿防止)
CREATE TABLE IF NOT EXISTS posts (
  week_end   TEXT PRIMARY KEY REFERENCES weeks(week_end) ON DELETE CASCADE,
  tweet_id   TEXT,
  text       TEXT NOT NULL,
  status     TEXT NOT NULL,              -- 'posted' | 'failed' | 'dry_run'
  error      TEXT,
  posted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
