# 時間割共有サービス (timetables)

大学のGoogleアカウントでログインし、時間割を登録して友達と共有できるサービス。
`programs/image_uploader` と同じ構成（Cloudflare Pages Functions + Hono）を踏襲し、
DBには **Cloudflare D1**（マネージドSQLite）を使うことで、VPS・Railsサーバーなしで運用する。

- **バックエンド**: Cloudflare Pages Functions（Hono）+ D1。`functions/api/[[route]].ts` がエントリーポイントで、
  実際のルーティングは `functions/api/_lib/routes/*.ts` に分割してある
- **認証**: Google OAuth 2.0 (Authorization Code + PKCE)。IDトークンの `hd` クレームを検証し、
  `ALLOWED_EMAIL_DOMAIN` で指定した大学ドメインのアカウント以外はログインできない
- **セッション**: JWTではなく、D1に保存したランダムトークンをHttpOnly Cookieとして発行する方式
  （いつでもDBから削除するだけで強制ログアウトできる。JWTのように有効期限まで無効化できない問題がない）
- **フロントエンド**: Vite + Vanilla TypeScript（フレームワークなし）

⚠️ **このREADMEは「仮実装」として一通り動作確認済みだが、本番投入前に必ず「4. 本番投入前に確認すること」を読むこと。**

---

## 1. ローカル開発

```bash
cd programs/timetables
npm install

# ターミナル1: フロントエンドをビルド&監視
npm run dev:vite

# ターミナル2: Pages Functions + D1(ローカルSQLite) + 静的配信をまとめて動かす
npm run build   # 初回は先に1回ビルドしておく
npm run dev
```

`http://localhost:8788` で動作する。ローカルのD1マイグレーションは別途:

```bash
npm run db:migrate:local
```

Google OAuthをローカルで実際に通す場合は `.dev.vars`（`.gitignore`済み）を作成する:

```
GOOGLE_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

`GOOGLE_CLIENT_ID` / `ALLOWED_EMAIL_DOMAIN` / `OAUTH_REDIRECT_URI` は秘密情報ではないので
`wrangler.toml` の `[vars]` に書く（後述）。ローカルでOAuthコールバックを受けるには、
Google Cloud Console側の「承認済みのリダイレクトURI」に `http://localhost:8788/api/auth/callback` も
追加し、`wrangler.toml` の `OAUTH_REDIRECT_URI` を一時的にlocalhost向けに変える必要がある。

型チェックのみ: `npm run typecheck`

**ここまでの動作確認について**: OAuthログイン自体は実際のGoogleアカウント・Client Secretがないと
通せないため未検証。それ以外（セッションCookie発行、`/api/me`、時間割のCRUD、友達申請〜承認〜解除、
アクセス制御、アカウント削除のカスケード削除、CSRF対策、バリデーション）は、D1にテスト用の
ユーザー/セッション行を直接INSERTしてHTTPリクエストで一通り確認済み。

---

## 2. Cloudflare側の初期設定（初回のみ）

### 2-1. Google Cloud Console でOAuthクライアントを作成

1. [Google Cloud Console](https://console.cloud.google.com/) → 新規プロジェクト作成（または既存プロジェクトを使用）
2. **APIとサービス → OAuth同意画面** を設定
   - ユーザーの種類: 「内部」ではなく「外部」を選ぶ（大学ドメイン以外のGoogle Cloud組織の場合。
     大学のGoogle Workspace管理者権限があるなら「内部」にすると同意画面の審査が不要になり楽）
   - スコープ: `openid`, `email`, `profile`（デフォルトで足りる）
3. **認証情報 → 認証情報を作成 → OAuthクライアントID**
   - アプリケーションの種類: 「ウェブアプリケーション」
   - 承認済みのリダイレクトURI: `https://timetables.iku-navi.net/api/auth/callback`
     （本番ドメインが決まったら実際の値に。開発中は `http://localhost:8788/api/auth/callback` も追加可）
4.発行された **クライアントID** と **クライアントシークレット** を控える

### 2-2. D1データベースを作成

```bash
cd programs/timetables
npx wrangler d1 create timetables-db
```

出力される `database_id` を `wrangler.toml` の `[[d1_databases]]` セクションに書き込む
（現在 `REPLACE_WITH_REAL_D1_DATABASE_ID` のプレースホルダーになっている）。

リモートDBにスキーマを反映:

```bash
npm run db:migrate:remote
```

### 2-3. wrangler.toml を実際の値に書き換え

- `[[d1_databases]].database_id` — 2-2で取得したID
- `[vars].GOOGLE_CLIENT_ID` — 2-1で取得したクライアントID（秘密情報ではないのでコミットしてよい）
- `[vars].ALLOWED_EMAIL_DOMAIN` — 大学のGoogle Workspaceドメイン。
  **現在 `senshu-u.jp` を設定済み**（`programs/image_uploader/README.md` の記載を参考にした値）。
  実際にログインテストをして問題なければそのままでよいが、必ず一度確認すること
- `[vars].OAUTH_REDIRECT_URI` — 実際に使う本番ドメインに合わせる

`GOOGLE_CLIENT_SECRET` は **wrangler.toml に書かない**。Cloudflareダッシュボードのシークレットとして設定する
（4-1参照）。

---

## 3. デプロイ（Git連携 — 本体サイト・image_uploaderと同じ方式）

### 3-1. 初回セットアップ（ダッシュボードでの作業）

Cloudflareダッシュボード → **Workers & Pages → Create → Pages → Connect to Git** でこのリポジトリを選択し、
以下を設定する（**モノレポなので Root directory の指定が必須**）。

| 設定項目 | 値 |
|---|---|
| Production branch | `main` |
| Root directory (Advanced) | `programs/timetables` |
| Build command | `npm install && npm run build` |
| Build output directory | `dist` |
| D1データベースのバインディング | Settings → Functions → D1 database bindings で `DB` → `timetables-db` を追加 |
| 環境変数（Production / Preview 両方） | `ALLOWED_EMAIL_DOMAIN`, `OAUTH_REDIRECT_URI`, `GOOGLE_CLIENT_ID` |
| シークレット（Production / Preview 両方） | `GOOGLE_CLIENT_SECRET` |

D1バインディングは `wrangler.toml` に書いてあっても、**Git連携ビルドではダッシュボード側の設定が優先される**ため、
ダッシュボードでも必ず設定すること（`wrangler.toml` はローカルの `wrangler pages dev`/手動デプロイ用）。

### 3-2. カスタムドメイン

Pagesプロジェクト → Custom domains から追加する（手動でDNSレコードを作らないこと。
`docs/cloudflare_pages_migration.md` / `programs/image_uploader/README.md` の同様の手順を参照）。

### 3-3. 以降の更新

`main` にマージするだけで自動的に再ビルド・再デプロイされる。DBスキーマを変更した場合のみ、
`migrations/` に新しいファイルを追加し `npx wrangler d1 migrations apply timetables-db --remote` を
手動で実行する必要がある（マイグレーションの自動適用はCI化していない）。

⚠️ **実際にやらかした教訓**: `0002_add_term.sql`（前期/後期対応）を追加した際、`--local` でしか
動作確認せず `--remote` の適用を忘れてデプロイしてしまい、本番で時間割の読み書きが全部
「サーバー内部エラー」になった。**新しいマイグレーションを追加したら、コミット・デプロイの
前後どちらかで必ず `npm run db:migrate:remote` を実行したことを確認すること。**
（`npx wrangler d1 execute timetables-db --remote --command "SELECT * FROM d1_migrations;"` で
本番に適用済みのマイグレーション一覧を確認できる）

---

## 4. 本番投入前に確認すること（重要）

このサービスは氏名相当の表示名・大学メールアドレス・時間割・交友関係という**個人情報そのもの**を扱う。
「仮で作った」からといって雑に扱ってよいデータではないため、実運用に進める前に以下を確認すること。

### 実装済みの配慮

- **ドメイン制限はサーバー側で検証**している（`functions/api/_lib/routes/auth.ts` の `callback`）。
  ログインURLの `hd` パラメータは見た目の絞り込みに過ぎず、IDトークンの `hd` クレームを
  署名検証した上で照合して初めて「大学関係者である」ことを保証している
- **アカウント削除機能**（画面下部「アカウントを削除する」）で、セッション・時間割・友達関係を
  含む全データを即座に削除できる。個人情報を扱うサービスには退会導線が必須
- **友達申請も大学ドメイン限定**（学外への総当たり送信の踏み台にされることを防ぐ）
- **友達関係はサーバー側で必ず検証**してから他人の時間割を返す（`GET /api/timetable/friend/:userId`）。
  フロントの表示制御だけに頼っていない
- 友達申請の**簡易レート制限**（1時間20件）で連投・嫌がらせ的な大量送信を軽減
- Cookieは `HttpOnly; Secure; SameSite=Lax`。状態変更リクエストは `Origin` ヘッダ検証も併用（多層防御）
- セッションはJWTではなくDB管理のランダムトークンなので、不正利用が発覚した場合にDBの行を削除すれば
  即座に強制ログアウトできる

### 投入前に判断・対応が必要なこと

- **プライバシーポリシー / 利用規約の掲示**: 「誰が」「何のために」「どのデータを」「いつまで」保持するかを
  ユーザーに明示する文書が必要（法務・サークル運営側と要相談。このリポジトリには含めていない）
- **`location`（教室）フィールドの扱い**: 時間割に教室名を入れると、友達に「今どこにいるか」が
  ほぼリアルタイムでわかることになる。IKU NAVI本体（AR経路案内）と組み合わせるとその場所への
  道案内まで一直線にできてしまうため、ストーカー被害等のリスクを考慮した上で
  「教室名は任意項目のまま残す/削除する/友達関係の相互承認を必須にする（実装済み）」などの方針を確認すること
- **Cloudflareダッシュボード側のレート制限/WAF**: アプリ内の簡易レート制限に加えて、
  Cloudflareの `Security → WAF` でこのPagesプロジェクト向けのレート制限ルールを設定することを推奨
  （特に `/api/auth/login` と `/api/friends/requests` は連打されると外部サービス(Google)側にも
  負荷をかけるため）
- **`ALLOWED_EMAIL_DOMAIN` の実値確認**: `senshu-u.jp` を仮設定しているが、実際にテストアカウントで
  ログインして意図した通りに制限されるか必ず確認すること
- **セッション有効期限（30日）が妥当か**: `functions/api/_lib/db.ts` の `SESSION_TTL_MS` で調整できる。
  個人情報を扱う性質上、共有端末での利用が想定されるなら短くする・明示的ログアウト導線を
  目立たせるなどの検討が要る
- **OAuth同意画面の公開ステータス**: Google Cloud Console側で「テストモード」のままだと
  登録した数十件のテストユーザーしかログインできない。全学に公開するなら「本番公開」に切り替える
  （大学のWorkspace組織内であれば「内部」設定でこの制限自体を回避できる）

### 対象外・今後の検討事項

- パスワードリセット等は無い（Googleログインのみのため不要）
- 時間割の「共同編集」「コマの重複警告（自分の別のコマとの時間帯重複チェック）」は未実装
- メール通知（申請が来た時に大学メールへ通知するなど）は未実装。現状はアプリを開かないと気づけない
