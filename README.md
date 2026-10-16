# 日経225 OPフロー観測

JPX「投資部門別取引状況(先物・オプション/週間)」から日経225オプションの **個人・法人** の売買を取り込み、
推定ポジションから日経平均先物の方向感を週次でスコア化して表示、同時に X へ自動投稿する Cloudflare 完結型サイト。

## 構成 (WordPress なし・全部 Cloudflare)
| 役割 | 実装 |
|---|---|
| データ | **D1** (`weeks` / `flows` / `analyses` / `posts`) — `migrations/0001_init.sql` |
| サイト | **Workers** + Hono による SSR(`src/page.ts`)。外部 JS なし・インライン SVG チャート |
| 連携 | **Cron Triggers**(木・金 16:30 JST)で JPX 取得 → 分析 → X 投稿(`src/pipeline.ts`) |
| X 投稿 | X API v2 `POST /2/tweets`、OAuth 1.0a 署名を Web Crypto で自前実装(`src/x.ts`) |
| ドメイン/DNS | Cloudflare のカスタムドメインを Worker にルーティング |

## 推計ロジック (`src/analysis.ts`)
- 方向性フロー = (コール買−売) − (プット買−売)。JPX は部門別建玉を出していないため、直近4週累積を「推定ポジション」とする
- 26週 z スコアで標準化し、**個人=逆張り(−0.45)**、**法人=順張り(+0.35)**、海外=順張り(+0.2) で合成 → −100〜+100
- 個人のオプション純売り(ショート・ボラ)の z で「急変動警戒/変動拡大注意/平常/変動縮小気味」
- 重み・期間は `WEIGHTS` / `POSITION_WINDOW` / `Z_WINDOW` で調整可能

## セットアップ
```bash
npm i
npx wrangler d1 create nikkei-option-flow          # 出力の database_id を wrangler.toml に記入
npx wrangler d1 migrations apply nikkei-option-flow --remote
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put X_API_KEY        # X Developer Portal の API Key
npx wrangler secret put X_API_SECRET
npx wrangler secret put X_ACCESS_TOKEN   # 投稿するアカウントの Access Token (Read and Write 権限)
npx wrangler secret put X_ACCESS_SECRET
# wrangler.toml の SITE_URL を本番 URL に、X_POST_ENABLED を "true" に
npx wrangler deploy
```
`X_POST_ENABLED` が `"true"` でない、または鍵が未設定の間は投稿せず `posts` テーブルに `dry_run` として記録します。

### 初回データ投入
```bash
# 過去 N 週分を JPX から取り込み(最新週のみ X 投稿)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://<site>/admin/run?backfill=26"
```

## 管理 API (`Authorization: Bearer ADMIN_TOKEN`)
| エンドポイント | 内容 |
|---|---|
| `POST /admin/run[?force=1&backfill=N]` | 取得→分析→投稿を手動実行 |
| `POST /admin/ingest[?post=1]` | 週データを JSON で直接投入(JPX レイアウト変更時のフォールバック) |
| `POST /admin/parse-preview` | Excel をボディで送って解析結果のみ確認 (`--data-binary @file.xls`) |
| `POST /admin/clear-sample` | サンプルデータ削除 |

`/admin/ingest` の例:
```json
{"weekStart":"2026-10-12","weekEnd":"2026-10-16",
 "flows":[{"product":"call","investor":"individual","sell":50000,"buy":70000},
          {"product":"put","investor":"corporate","sell":23000,"buy":27000}]}
```
product: `call|put|fut`, investor: `individual|corporate|foreign|securities|proprietary`

公開 API: `GET /api/latest`, `GET /api/history`

## ローカル開発
```bash
npx wrangler d1 migrations apply nikkei-option-flow --local
node scripts/gen-sample.mjs > sample.sql && npx wrangler d1 execute nikkei-option-flow --local --file sample.sql  # 乱数サンプル
echo 'ADMIN_TOKEN=devtoken' > .dev.vars && npx wrangler dev
npm test
```

## 注意
- JPX の Excel 解析(`src/jpx.ts`)は列位置ではなく「日経225/プット/コール」「個人/法人…」「売り/買い」の文字列で探すヒューリスティック。
  初回は実ファイルで `/admin/parse-preview` を叩き、値が JPX の PDF と一致するか確認してください。
- 枚数ベースのためプレミアム・行使価格・限月差は考慮していません。投資助言ではありません。
