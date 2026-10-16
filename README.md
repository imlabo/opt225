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

## データソース (`src/jpx.ts`)
JPX「投資部門別取引状況」週次 CSV `Tousi_DV_W_YYYYMMDD_YYYYMMDD.csv`(コード形式)。同週の PDF 版と突合済み。

| 帳票種別 | 商品 | | 投資部門コード | 部門 |
|---|---|---|---|---|
| 301 | 日経225先物 | | 11 | 自己 |
| 303 | 日経225オプション プット | | 51 | 個人 |
| 304 | 日経225オプション コール | | 60 | 海外投資家 |
| | | | 41 | 証券会社 |
| | | | 21–24, 31–33 | 法人(金融機関・投信・事業法人・その他法人の合計) |

数量金額区分 1=数量(枚), 2=金額(円, オプションはプレミアム代金)。JPX の一覧ページに載るのは直近数週分のみのため、履歴は毎週の取得で D1 に蓄積していきます(初回は掲載分をすべて取り込み)。

## デプロイ (GitHub Actions)
`main` への push で `.github/workflows/deploy.yml` が テスト → D1 作成(初回のみ)→ マイグレーション → デプロイ → シークレット同期 を実行します。

リポジトリの **Settings → Secrets and variables → Actions** に登録:

| 種類 | 名前 | 内容 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | Cloudflare API トークン(テンプレート「Edit Cloudflare Workers」+ D1 の Edit 権限) |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare アカウント ID |
| Secret | `ADMIN_TOKEN` | 管理 API 用の任意の長いランダム文字列 |
| Secret | `X_API_KEY` / `X_API_SECRET` | X Developer Portal の API Key / Secret |
| Secret | `X_ACCESS_TOKEN` / `X_ACCESS_SECRET` | 投稿アカウントの Access Token / Secret(Read and Write) |
| Variable | `SITE_URL` | 公開 URL(投稿文に載る) |
| Variable | `X_POST_ENABLED` | `true` で実投稿。未設定・`false` の間は `posts` に `dry_run` として記録のみ |

デプロイ後、Cron(木・金 16:30 JST)が自動で取得・分析・投稿します。すぐに初回データを入れる場合:
```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "https://<site>/admin/run"
```

`.github/workflows/jpx-check.yml` は JPX の最新 CSV を取得・解析して結果を `jpx-check` ブランチに保存する診断用ワークフローです(毎週木曜にも実行。フォーマット変更の早期検知用)。

## 日次分析 (`src/daily.ts`, `src/jpx-daily.ts`)
| データ | 取得元 | 内容 |
|---|---|---|
| 建玉 | 当日取引高等 `YYYYMMDDopen_interest.xlsx`「別紙1」 | 日経225オプションの行使価格別 建玉・前日比・取引高(期近3限月) |
| 清算値段 | 先物・オプション清算値段等 `rbYYYYMMDD.csv`(Shift_JIS) | 清算価格・IV・原資産価格(日経平均)・先物清算価格・残日数 |

期近(SQ まで 3 日以上の最も近い限月)について、下の壁(現値以下で最大のプット建玉)、上の壁(現値以上で最大のコール建玉)、最大苦痛価格、P/C建玉比、ATM IV、SQ までの 1σ 変動幅を算出します。日次では投資部門別の内訳は公表されていません。

CSV(約4MB)と Excel の解析は Workers 無料枠の CPU 時間(10ms)に収まらないため、`.github/workflows/daily.yml`(平日 18:30 / 21:30 JST)で `scripts/daily-fetch.mts` が解析し、必要な行だけを `POST /admin/ingest-daily` に送ります。Worker 側で D1 保存・分析・表示・X 投稿(1日1回)を行います。

公開 API: `GET /api/daily/latest`, `GET /api/daily/history`

## 管理 API (`Authorization: Bearer ADMIN_TOKEN`)
| エンドポイント | 内容 |
|---|---|
| `POST /admin/run[?force=1&backfill=N]` | 取得→分析→投稿を手動実行 |
| `POST /admin/ingest-daily[?post=force]` | 日次データ投入(daily ワークフローから) |
| `POST /admin/ingest[?post=1]` | 週データを JSON で直接投入(JPX レイアウト変更時のフォールバック) |
| `POST /admin/parse-preview` | JPX の週次 CSV をボディで送って解析結果のみ確認 (`--data-binary @file.csv`) |
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
npx wrangler d1 migrations apply opt225 --local
node scripts/gen-sample.mjs > sample.sql && npx wrangler d1 execute opt225 --local --file sample.sql  # 乱数サンプル
echo 'ADMIN_TOKEN=devtoken' > .dev.vars && npx wrangler dev
npm test
```

## 注意
- JPX がコード体系や CSV 列を変えた場合、`fetchWeek` が「option rows not found」で失敗します。`jpx-check` ワークフローで中身を確認し、`PRODUCT_CODES` / `INVESTOR_CODES` を更新してください。急ぎの場合は `/admin/ingest` で手動投入できます。
- 推計は枚数ベースで、行使価格・限月差は考慮していません(金額は D1 に保存済み)。投資助言ではありません。
