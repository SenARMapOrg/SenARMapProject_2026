# 鳳祭 案内人数集計

鳳祭（イベントモード）で、**どの案内係が何人を案内したか**を集計する仕組み。
`programs/timetables` と同じ構成（Cloudflare Pages Functions + Hono + D1）を踏襲している。

---

## 残っている作業（2026-10-02 時点）— 上から順にやる

コードは Node のある開発機で型チェック・テスト・ビルドを通し、ローカル（wrangler + ローカルD1）で一通り動かした
（QRのURLでナビを開く → 到着が1件だけ増える・再読み込みしても増えない、検索の記録、管理画面での人数・検索ログ・QRの表示）。
残りは **Cloudflare と Google の画面での設定** と **本番での確認** だけ。

ドメインは **`event-guide-counter.iku-navi.net`** を使う前提で、コードにはすでにこの値が入っている
（`wrangler.toml` の `OAUTH_REDIRECT_URI` と `track.js` の `TRACK_API_BASE`）。別のドメインにしたい場合だけ、最後の「ドメインを変える場合」を見る。

- [x] **手順1. D1 データベースを2つ作る**（ターミナル）
- [x] **手順2. Google のログイン用のクライアントを作る**（Google Cloud Console）
- [x] **手順3. `wrangler.toml` に ID を書く**（手順1・2で出た値。Claude に頼んでもよい）
- [ ] **手順4. D1 に表を作る（マイグレーション）**（ターミナル）
- [ ] **手順5. PR を main にマージする**（GitHub）
- [ ] **手順6. Cloudflare Pages にこのサイトを作る**（Cloudflare）
- [ ] **手順7. シークレットを設定する**（Cloudflare）
- [ ] **手順8. ドメインを付ける**（Cloudflare）
- [ ] **手順9. 送りすぎを止めるルールを作る**（Cloudflare）
- [ ] **手順10. 本番で動作確認する**（スマホ）
- [ ] **手順11. 鳳祭の準備・後片付け**

### 手順1. D1 データベースを2つ作る（ターミナル）

本番用とプレビュー用（main 以外のブランチのデプロイ用）の2つを作る。リポジトリの一番上で、1行ずつ実行する:

```bash
cd programs/event_guide_counter
npm install
npx wrangler login
npx wrangler d1 create event-guide-counter-db
npx wrangler d1 create event-guide-counter-db-preview
```

- `npx wrangler login` はブラウザが開くので、プロジェクトの Cloudflare アカウントで「Allow」を押す
  （すでにログインしていれば不要。`npx wrangler whoami` で確認できる）
- `d1 create` を実行するたびに `database_id = "xxxxxxxx-xxxx-..."` という行が出るので、**2つとも控える**（どちらが本番用かも）。
  この ID は公開されても問題ない

### 手順2. Google のログイン用のクライアントを作る（Google Cloud Console）

管理画面に Google アカウントでログインするためのもの。時間割共有と同じ Google Cloud のプロジェクトを使えば、同意画面の設定はもう済んでいる。

1. https://console.cloud.google.com/ を開き、上のプロジェクト選択で**時間割共有と同じプロジェクト**を選ぶ
2. 左のメニュー → **「APIとサービス」→「認証情報」**
3. 上の **「＋認証情報を作成」→「OAuth クライアント ID」**
4. **アプリケーションの種類**: 「ウェブ アプリケーション」
5. **名前**: `鳳祭 案内人数集計`（何でもよい）
6. **承認済みのリダイレクト URI** の「＋URI を追加」に、次をそのまま貼る:
   ```
   https://event-guide-counter.iku-navi.net/api/auth/callback
   ```
   （「承認済みの JavaScript 生成元」は空のままでよい）
7. **「作成」** を押すと **クライアント ID**（`….apps.googleusercontent.com`）と **クライアント シークレット**（`GOCSPX-…`）が出るので控える
   - クライアント ID は公開されても問題ない（手順3で `wrangler.toml` に書く）
   - **クライアント シークレットは秘密**。リポジトリ・チャット・PR に書かない（手順7で Cloudflare にだけ入れる）

### 手順3. `wrangler.toml` に ID を書く

`programs/event_guide_counter/wrangler.toml` の次の4か所を書き換えて、コミット・push・PR を出す
（**D1 の ID 2つとクライアント ID を Claude に伝えて「書き換えて PR に載せて」と頼んでもよい**。シークレットは伝えない）。

| 場所 | 今の値 | 書く値 |
|---|---|---|
| `[[d1_databases]]` の `database_id` | `00000000-0000-0000-0000-000000000000` | 手順1の **本番用**（`event-guide-counter-db`）の ID |
| `[vars]` の `GOOGLE_CLIENT_ID` | `REPLACE_ME.apps.googleusercontent.com` | 手順2のクライアント ID |
| `[[env.preview.d1_databases]]` の `database_id` | `00000000-0000-0000-0000-000000000000` | 手順1の **プレビュー用**（`event-guide-counter-db-preview`）の ID |
| `[env.preview.vars]` の `GOOGLE_CLIENT_ID` | `REPLACE_ME.apps.googleusercontent.com` | 手順2のクライアント ID（同じ値） |

### 手順4. D1 に表を作る（マイグレーション）（ターミナル）

手順3で書き換えた `wrangler.toml` がある状態で、リポジトリの一番上から1行ずつ実行する（それぞれ「Ok to proceed?」と聞かれたら `y`）:

```bash
cd programs/event_guide_counter
npm run db:migrate:remote
npm run db:migrate:preview
```

最後に `0001_init.sql │ ✅` と出れば成功。**これを忘れると、デプロイ後にすべての API がエラー（500）になる。**

### 手順5. PR を main にマージする（GitHub）

この集計システムのコードと手順3の変更を含む PR を main にマージする（マージはレビュー担当の人）。
手順6で作る Cloudflare Pages は main のコードをビルドするので、**マージ前に手順6をやるとビルドが失敗する**（失敗しても、マージ後にやり直せば直る）。

ナビ画面（IKU NAVI 本体）にも記録用のスクリプトが入るが、QR に `ref` が付いているときしか送らず、
送信先がまだ無くてもナビは普段どおり動くので、手順6〜9より先にマージして問題ない。

### 手順6. Cloudflare Pages にこのサイトを作る（Cloudflare）

1. https://dash.cloudflare.com/ を開き、プロジェクトのアカウントを選ぶ
2. 左のメニュー → **「Workers & Pages」** → 右上の **「作成」（Create）**
3. **「Pages」** タブ → **「Git に接続」（Connect to Git）**
4. リポジトリ **`SenARMapOrg/SenARMapProject_2026`** を選んで **「セットアップの開始」**
5. 次のとおり入力する:

   | 項目 | 入れる値 |
   |---|---|
   | プロジェクト名 | **`senarmapproject-2026-event-guide-counter`**（`wrangler.toml` の `name` と同じにする。違うと設定が効かない） |
   | 本番ブランチ | `main` |
   | フレームワーク プリセット | なし（None） |
   | ビルド コマンド | `npm install && npm run build` |
   | ビルド出力ディレクトリ | `dist` |
   | ルート ディレクトリ（「詳細設定」を開く） | **`programs/event_guide_counter`** |

6. **「保存してデプロイする」** を押し、ビルドが「成功」になるのを待つ
   - D1 の接続と環境変数は `wrangler.toml` から自動で入るので、ダッシュボードでは設定しない
     （設定画面に「このプロジェクトのバインディングは wrangler.toml を通じて管理されています」と出るのが正しい状態）

### 手順7. シークレットを設定する（Cloudflare）

1. 手順6で作ったプロジェクト（`senarmapproject-2026-event-guide-counter`）を開く
2. **「設定」（Settings）→「変数とシークレット」（Variables and Secrets）**
3. 環境が **「本番」（Production）** になっていることを確認して **「追加」** を押し、次の2つを追加する（種類はどちらも **「シークレット」**）:

   | 名前 | 値 |
   |---|---|
   | `GOOGLE_CLIENT_SECRET` | 手順2のクライアント シークレット（`GOCSPX-…`） |
   | `ADMIN_EMAILS` | 管理画面を見る人のメールアドレス。複数ならカンマ区切り（例: `a@senshu-u.jp,b@senshu-u.jp`） |

4. **「保存」**
5. シークレットは次のデプロイから効くので、**「デプロイ」タブ → 一番上の本番デプロイの「…」→「デプロイを再試行」** を押す

- **プレビュー（Preview）には設定しない**（プレビューの URL から本番の管理画面と同じものにログインできる経路を作らないため）
- ターミナルでやる場合は次の2行（実行すると値を聞かれるので貼り付ける）:
  ```bash
  npx wrangler pages secret put GOOGLE_CLIENT_SECRET --project-name senarmapproject-2026-event-guide-counter
  npx wrangler pages secret put ADMIN_EMAILS --project-name senarmapproject-2026-event-guide-counter
  ```

### 手順8. ドメインを付ける（Cloudflare）

1. 同じプロジェクトの **「カスタム ドメイン」（Custom domains）** タブ → **「カスタム ドメインを設定」**
2. `event-guide-counter.iku-navi.net` と入力 → **「続行」** → **「ドメインをアクティブ化」**
3. 状態が **「アクティブ」** になるまで待つ（数分。iku-navi.net が Cloudflare にあるので DNS は自動で作られる。
   **DNS レコードを自分で作らないこと**）
4. ブラウザで https://event-guide-counter.iku-navi.net/admin を開き、「Googleでログイン」のボタンが出れば OK

### 手順9. 送りすぎを止めるルールを作る（Cloudflare）

記録の受け付け（`/api/track/`）はログイン不要なので、プログラムから大量に送られたときのために、同じ IP からの送信数に上限を付ける。

1. https://dash.cloudflare.com/ → **`iku-navi.net`** のドメインを開く
2. 左のメニュー → **「セキュリティ」（Security）→「WAF」→「レート制限ルール」（Rate limiting rules）タブ** → **「ルールを作成」**
3. 次のとおり入力する:

   | 項目 | 入れる値 |
   |---|---|
   | ルール名 | `event-guide-counter track` |
   | 受信リクエストが一致する場合 | フィールド「ホスト名」・演算子「次と等しい」・値 `event-guide-counter.iku-navi.net`<br>**And** フィールド「URI パス」・演算子「次で始まる」・値 `/api/track/` |
   | 同じ特性を持つ場合 | IP |
   | レートが次を超えた場合 | リクエスト数 `20`、期間 `10 秒` |
   | アクションを実行 | ブロック、期間 `10 秒` |

4. **「デプロイ」**
- 無料プランではレート制限ルールは1つしか作れない。すでに別のルールがある場合は、作る前に相談する
- 鳳祭当日は学内 Wi-Fi などで多くの来場者が同じ IP になりうるので、これより厳しくしない

### 手順10. 本番で動作確認する（スマホ）

1. https://event-guide-counter.iku-navi.net/admin に `ADMIN_EMAILS` のアカウントでログインする
2. 案内係の名前欄に `テスト` と入れて **「追加」**
3. 「テスト」の行の **「QR表示」** を押し、出た QR を**スマホのカメラで読む** → IKU NAVI のナビ画面が開く
4. 管理画面を再読み込みして、「テスト」の **到着人数が 1** になっていることを確認
5. **もう一度同じ QR を読んで**から管理画面を再読み込みし、**到着人数が 1 のまま**であることを確認（2回数えないのが今回の作り替えの要点）
6. スマホのナビ画面でルート検索をする → 管理画面で **検索人数が 1**、「検索ログ」に出発地 → 目的地が出ることを確認
7. 確認が終わったら「テスト」の行の **「削除」** を押す

### 手順11. 鳳祭の準備・後片付け

- 案内係を全員分「追加」し、それぞれ「QR表示」の QR を印刷して配る（QR の下の URL の `ref=` が案内係のコード。名前は入っていない）
- 記録していることを、イベントページなどで一言案内するか決める
- 旧 Rails 版（別リポジトリ `User-counter`）をいつ止めるか決める（今は並行稼働の方針）
- 終わったら、不要な記録は管理画面の「リセット」「削除」で消す（自動では消えない）

### ドメインを変える場合

`event-guide-counter.iku-navi.net` 以外にする場合は、手順2・8で入れるドメインを変え、次の3か所も同じドメインに書き換える:

- `wrangler.toml` の `OAUTH_REDIRECT_URI`（`[vars]` と `[env.preview.vars]` の2か所）
- `programs/html/navi/script/track.js` の `TRACK_API_BASE`（`https://event-guide-counter.iku-navi.net` の部分）

IKU NAVI 本体のドメイン（`iku-navi.net`）を変える場合は、`wrangler.toml` の `NAVI_BASE_URL`（QR の宛先）と
`TRACK_ALLOWED_ORIGINS`（記録を受け付けるページ。違うと何も記録されない）も書き換える。

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

> 初めて本番に出すときの手順は、冒頭の「残っている作業」に画面の操作まで細かく書いてある。ここはその要点。

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
