# 鳳祭 案内人数集計

鳳祭（イベントモード）で、**どの案内係が何人を案内したか**を集計する仕組み。
`programs/timetables` と同じ構成（Cloudflare Pages Functions + Hono + D1）を踏襲している。

---

## 残っている作業（2026-10-02 時点）

コードは一通り書いたが、**まだ一度も動かしていない**（開発機に Node が無いため）。
A を上から順にやれば動く。各項目の詳しい手順は後述の「セットアップ」を参照。

### A. まずこれをやらないと何も動かない

- [ ] **`npm install` を実行する**（Node のある環境で）
      → `package-lock.json` が未生成。これが無いと CI の `npm ci` も失敗する。生成されたら一緒にコミットする
- [ ] **型チェック・テスト・ビルドを通す**：`npm run typecheck && npm test && npm run build`
      → TypeScript 側は未実行なので、ここで初めてエラーが出る可能性がある
- [ ] **D1 を2つ作る**：`npx wrangler d1 create event-guide-counter-db` と `…-db-preview`
      → 発行された `database_id` を `wrangler.toml` の **11行目**（本番）と **46行目**（プレビュー）に書く
      （今は `00000000-0000-0000-0000-000000000000` のプレースホルダ）
- [ ] **Google OAuth クライアントを作る**
      → `GOOGLE_CLIENT_ID` を `wrangler.toml` の **20行目**と**50行目**に書く（今は `REPLACE_ME.apps.googleusercontent.com`）
- [ ] **シークレットを設定する**：`npx wrangler pages secret put GOOGLE_CLIENT_SECRET` と `ADMIN_EMAILS`
      → `ADMIN_EMAILS` が未設定だと**誰もログインできない**（意図どおりの安全側の挙動）
- [ ] **マイグレーションを適用する**：`npm run db:migrate:remote`（＋ `:preview`、ローカルは `:local`）
      → デプロイでは自動適用されない。忘れると全API が 500 になる
- [ ] **ドメインを決めて3箇所を書き換える**
      → `wrangler.toml` の `OAUTH_REDIRECT_URI`（**17・49行目**）、
        `programs/html/navi/script/track.js` の **19行目** `TRACK_API_BASE`、
        Google Cloud Console の承認済みリダイレクト URI。
        今はすべて `event-guide-counter.iku-navi.net` を仮に入れている
- [ ] **`NAVI_BASE_URL` を確認する**（`wrangler.toml` **22・51行目**、既定 `https://iku-navi.net`）
      → 管理画面が出す QR の宛先になる

### B. 鳳祭の前にやること

- [ ] 管理画面 `/admin` にログインできるか確認する
- [ ] 案内係を登録して、**QRを実機のスマホで読んで到着が1件だけ増えるか**確認する
      （連続で読み込んでも増えない＝重複排除が効いている、が今回の作り替えの要点）
- [ ] ルート検索して検索人数と検索ログ（出発地→目的地）が入るか確認する
- [ ] 案内係ごとのQRを印刷して配る
- [ ] 記録していることをイベントページなどで一言案内するか決める

### C. あとから判断すればよいこと

- [ ] **旧 Rails 版（別リポジトリ `User-counter`）をいつ止めるか**
      → 今回は並行稼働させる方針なのでコードは一切触っていない。
        鳳祭のQRを新システム向けに差し替えれば、Rails 版は実質使われなくなる
- [ ] **記録の保存期間を決める**
      → 自動削除は実装していない。必要になったら `functions/api/_lib/db/audit.ts` の
        コメントにある通り `DELETE … WHERE created_at < …` を足すだけで足りる

---

## 何をどう数えているか

案内係ごとのQRコードは IKU NAVI を直接指す:

```
https://iku-navi.net/navi/?event=1&ref=<案内係コード>
```

IKU NAVI のページが**実際に表示されたあと**、ページ内のJS（`programs/html/navi/script/track.js`）が
`navigator.sendBeacon` でこのサイトのAPIに記録を送る。集計するのは次の3つ:

1. **到着人数** … QRを読んでIKU NAVIが実際に開いた端末の数
2. **検索人数** … 実際にルート検索まで進んだ端末の数
3. **検索内容** … どこからどこまで検索したか（教室名・イベント名）

### なぜサーバー側で数えないのか

以前は Rails のリダイレクトカウンター（別リポジトリ `User-counter`）が
「リダイレクトのリクエストが来た回数」を数えていたため、QRリーダー・LINEなどのリンクプレビューや
ブラウザの先読みでも数えられ、1人を2回数えてしまうことがあった。
ページが表示されてから送れば、人が開いた分だけ数えられる。
（設計の経緯は `docs/event_guide_counter_plan.md`）

### 数え方の限界

- 1台のスマホを数人で見る場合は1人になる（数えられるのは「案内した端末の数」）
- ブラウザを乗り換えると端末IDが別になるため、別の人として数えられることがある
- 到着は「案内係 × 端末 × 日付」で1人（同じ人が別日に来たら別カウント）、
  検索は全件保存して集計時に端末数で数える

### プライバシー

- QRのURLに入るのは**ランダムな案内係コード**だけで、名前などの個人情報は入らない
  （コードと案内係名の対応表はこのDB＝管理者だけが見られる場所にしか持たない）
- 端末IDは初回に作るランダムな値で、個人情報とは結びつけない
- 検索内容は「出発地・目的地の名前」だけで、個人を特定する情報は記録しない
- 記録の保存期間は未定のため、自動削除は実装していない

## 構成

```
admin.html, src/              管理画面（このサイトで唯一のページ。ログイン画面も兼ねる）
functions/admin.ts            /admin の門番。HTMLは静的ファイルに置かず、ここから返す
functions/api/[[route]].ts    Hono のエントリーポイント（/api/*）
functions/api/_lib/routes/
  auth.ts                     Googleログイン（ADMIN_EMAILS以外にはセッションを発行しない）
  admin.ts                    管理API（案内係の追加・削除・リセット・集計の取得）
  track.ts                    記録を受け取る公開API（ログイン不要。navi の track.js から呼ばれる）
functions/api/_lib/db/        D1アクセス（guides / track / sessions / audit）
migrations/                   D1のスキーマ
```

### 認証

- 一般ユーザーのログインは無く、**ログインできる＝管理者**。
  `ADMIN_EMAILS`（カンマ区切りのメールアドレス）に無いアカウントにはセッションを発行しない。
  未設定なら誰もログインできない（設定し忘れで全員が見られる事故が起きない向きに倒している）。
- セッションは30日有効だが、管理APIはログインから**12時間以内**に限る（`ADMIN_SESSION_MAX_AGE_MS`）。
- 管理画面を見た記録・管理者以外がログインを試みた記録は `admin_audit_log` に残る。
  記録を書けない状態では一覧を表示しない（503）。

## セットアップ

### 1. 依存のインストール

```bash
npm install
```

### 2. D1 データベースの作成

```bash
npx wrangler d1 create event-guide-counter-db
npx wrangler d1 create event-guide-counter-db-preview
```

出力される `database_id` を `wrangler.toml` の `[[d1_databases]]` と
`[[env.preview.d1_databases]]` に書き込む（初期値は `00000000-...` のプレースホルダ）。

### 3. Google OAuth クライアントの作成

Google Cloud Console で「OAuth 2.0 クライアント ID」（ウェブアプリケーション）を作り、
承認済みのリダイレクト URI に `wrangler.toml` の `OAUTH_REDIRECT_URI` と同じ値を登録する。
発行された `GOOGLE_CLIENT_ID` は `wrangler.toml` の `[vars]` に書き、
`GOOGLE_CLIENT_SECRET` は**書かずに**シークレットとして設定する:

```bash
npx wrangler pages secret put GOOGLE_CLIENT_SECRET
npx wrangler pages secret put ADMIN_EMAILS   # 管理画面を見られるメールアドレス（カンマ区切り）
```

`wrangler.toml` に `pages_build_output_dir` があるため、**D1バインディングと `[vars]` は
`wrangler.toml` が正**になり、ダッシュボードでは変更できない。シークレットだけダッシュボード管理。

### 4. マイグレーションの適用

デプロイでは自動適用されないので、必ず手動で実行する（`--remote` を忘れるとローカルに当たる）:

```bash
npm run db:migrate:local     # ローカル開発用
npm run db:migrate:remote    # 本番
npm run db:migrate:preview   # プレビュー環境
```

### 5. IKU NAVI 側の設定

`programs/html/navi/script/track.js` の `TRACK_API_BASE` を、このサイトの実運用ドメインに書き換える
（初期値は `https://event-guide-counter.iku-navi.net`）。

## ローカルでの動作確認

```bash
npm run build
npm run db:migrate:local
npx wrangler pages dev dist --binding ADMIN_EMAILS=you@example.com
```

記録APIはログイン不要なので `curl` で確認できる（`ref` は管理画面で案内係を追加すると発行される）:

```bash
curl -X POST http://localhost:8788/api/track/arrival \
  -H 'Content-Type: text/plain' -d '{"ref":"ABCD1234","deviceId":"test-device"}'

npx wrangler d1 execute event-guide-counter-db --local --command "SELECT * FROM arrivals;"
```

Google ログインをローカルで試す場合は、Google Cloud Console のリダイレクト URI に
`http://localhost:8788/api/auth/callback` を追加し、`wrangler.toml` の `OAUTH_REDIRECT_URI` を
一時的にそのURLへ変える（timetables と同じ手順）。

## テスト

```bash
npm test
npm run typecheck
```

`tests/helpers/d1-sqlite.ts` が Node 標準の SQLite で D1 の代わりをするので、
`migrations/*.sql` を実際に流し込んだDBに対して `db/*.ts` をそのまま動かして確かめている。
