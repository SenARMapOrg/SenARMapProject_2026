# 鳳祭 案内人数集計

鳳祭（イベントモード）で、**どの案内係が何人を案内したか**を集計する仕組み。
`programs/timetables` と同じ構成（Cloudflare Pages Functions + Hono + D1）を踏襲している。

---

## 残っている作業（2026-10-02 時点）

2026-10-02: Node のある開発機で `npm install`・型チェック・テスト・ビルドを通し、ローカル（wrangler + ローカルD1）で
一通り動かした（QRのURLでナビを開く → 到着が1件だけ増える・再読み込みしても増えない、検索の記録、
管理画面での人数・検索ログ・QRの表示）。残りは Cloudflare・Google 側の設定（A の後半）と本番での確認（B）。
各項目の詳しい手順は後述の「セットアップ」を参照。

### A. まずこれをやらないと何も動かない

- [x] **`npm install` を実行する**（`package-lock.json` をコミット済み）
- [x] **型チェック・テスト・ビルドを通す**：`npm run typecheck && npm test && npm run build`
- [ ] **D1 を2つ作る**：`npx wrangler d1 create event-guide-counter-db` と `…-db-preview`
      → 発行された `database_id` を `wrangler.toml` の `[[d1_databases]]`（本番）と `[[env.preview.d1_databases]]`（プレビュー）の `database_id` に書く
      （今は `00000000-0000-0000-0000-000000000000` のプレースホルダ）
- [ ] **Google OAuth クライアントを作る**
      → `GOOGLE_CLIENT_ID` を `wrangler.toml` の `[vars]` と `[env.preview.vars]` に書く（今は `REPLACE_ME.apps.googleusercontent.com`）
- [ ] **シークレットを設定する**：`npx wrangler pages secret put GOOGLE_CLIENT_SECRET` と `ADMIN_EMAILS`
      → `ADMIN_EMAILS` が未設定だと**誰もログインできない**（意図どおりの安全側の挙動）
- [ ] **マイグレーションを適用する**：`npm run db:migrate:remote`（＋ `:preview`、ローカルは `:local`）
      → デプロイでは自動適用されない。忘れると全API が 500 になる
- [ ] **ドメインを決めて3箇所を書き換える**
      → `wrangler.toml` の `OAUTH_REDIRECT_URI`（`[vars]` と `[env.preview.vars]`）、
        `programs/html/navi/script/track.js` の **19行目** `TRACK_API_BASE`、
        Google Cloud Console の承認済みリダイレクト URI。
        今はすべて `event-guide-counter.iku-navi.net` を仮に入れている
- [ ] **`NAVI_BASE_URL` を確認する**（`wrangler.toml` の `[vars]` と `[env.preview.vars]`、既定 `https://iku-navi.net`）
      → 管理画面が出す QR の宛先になる
- [ ] **`TRACK_ALLOWED_ORIGINS` を確認する**（同じく `[vars]` と `[env.preview.vars]`、既定 `https://iku-navi.net,https://www.iku-navi.net`）
      → 記録を受け付けるページのオリジン。IKU NAVI 本体のURLと違うと**何も記録されない**
- [ ] **Cloudflare のレート制限ルールを設定する**（下の「セキュリティ」参照）

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

## セキュリティ

### 記録API（`/api/track/*`）について

記録APIはログイン不要で、案内係コード（QRに印刷されていて誰でも読める）さえ分かれば送れてしまう。
**集計結果は「水増ししようと思えばできる」前提の目安**として扱い、人数に応じて賞品を出すなどの使い方はしないこと
（案内係本人がプライベートウィンドウで何度も開くだけでも増やせる）。

コードでは手軽な水増し・嫌がらせを止めている（`functions/api/_lib/track-guard.ts`）:

- `TRACK_ALLOWED_ORIGINS` 以外のページからの送信は記録しない
  （別のWebサイトに仕込んだスクリプトで、そのサイトの閲覧者のブラウザから大量に送らせる、を防ぐ）。
  Origin ヘッダは自作のプログラムなら偽れるので、これだけでは「プログラムから直接大量に送る」は防げない
- 本文は4KBまで、案内係コード・端末IDは決まった形式のものだけ受け付ける。登録されていない案内係コードは記録しない
- 応答はいつも同じ204にして、記録したかどうか・案内係コードが存在するかを外から分からないようにしている

**プログラムから大量に送られる場合への備えとして、Cloudflare のレート制限ルールを設定する**:
ダッシュボード → このサイトのドメイン（iku-navi.net）→ Security → WAF → Rate limiting rules で、
「URI Path が `/api/track/` で始まる」リクエストを「同じIPから10秒あたり20件まで」程度に制限する（超えたらブロック）。
鳳祭当日は学内Wi-Fiなどで多くの来場者が同じIPになりうるので、厳しくしすぎないこと。

### その他

- 管理画面・管理APIは許可したメールアドレスだけ（`ADMIN_EMAILS`）・ログインから12時間以内・閲覧記録あり。
  管理APIは別サイトからのリクエスト（`Sec-Fetch-Site` が same-origin 以外）を404で拒否する
- 検索ログの出発地・目的地は来場者のブラウザから送られる値なので、管理画面では必ず文字として表示している
  （`textContent`。HTMLとして解釈しない）
- 記録・閲覧記録の保存期間は未定で、自動削除はしていない。鳳祭が終わったら不要な記録は管理画面のリセット・削除で消す

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
# Origin が無い・許可されていないページからの送信は記録されない（localhost どうしは許可される）。
# ref は8文字の案内係コード、deviceId は UUID 形式でないと記録されない
curl -X POST http://localhost:8788/api/track/arrival \
  -H 'Origin: http://localhost:8000' -H 'Content-Type: text/plain' \
  -d '{"ref":"ABCD2345","deviceId":"0b6f5c1e-3a7d-4f7e-9b1c-2d3e4f5a6b7c"}'

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
