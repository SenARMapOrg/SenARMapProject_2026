# ナビの「使い方」（よくある質問と AI への質問）

ナビ画面（`/navi/`）の上にある「？」ボタンから開く。中身は2つ。

1. **よくある質問**：`programs/html/navi/faq.json` の質問と答えを並べたもの。AI を使わないので、設定なしで動く
2. **AI に質問する**：上にない質問を Gemini に答えさせる。`GEMINI_API_KEY` を設定するまでは「今は使えません」と出る

## しくみ

```
ブラウザ（navi/script/help.js）
  └─ POST /api/help-chat  … 同じ iku-navi.net の Pages Functions（functions/api/help-chat.js）
        ├─ /navi/faq.json を読み、「使い方の説明」として Gemini に渡す
        └─ Gemini API（generateContent）
```

- API キーはサーバー側（Pages の環境変数）にだけ置き、ブラウザには出さない
- Gemini には「faq.json に書かれていることだけで答える」「場所を推測で答えず、目的地に入れて検索するよう案内する」
  「使い方と関係ない質問には答えない」と指示している（`functions/api/help-chat.js` の `SYSTEM_PROMPT`）
- **答えの元は faq.json**。AI の答えを直したいときは、まず faq.json の説明を足す・直す
- 受け付けるのは、同じサイト（`Origin` が同じ）からの POST だけ。1回の質問は 400 文字まで、やりとりは直近 10 件まで送る
- 会話はサーバーに保存しない（ページを閉じると消える）

## 使えるようにする手順

### 1. Gemini の API キーを作る（Google AI Studio）

1. https://aistudio.google.com/apikey を開き、プロジェクトの Google アカウントでログインする
2. 「API キーを作成」を押し、キー（`AIza…`）を控える。**キーはリポジトリやチャットに貼らない**

### 2. Cloudflare Pages に設定する

1. https://dash.cloudflare.com/ → 「Workers & Pages」→ IKU NAVI 本体の Pages プロジェクト
2. 「設定」→「変数とシークレット」→ **Production** に追加する
   | 名前 | 種類 | 値 |
   |---|---|---|
   | `GEMINI_API_KEY` | シークレット（暗号化） | 手順1のキー |
   | `GEMINI_MODEL` | テキスト（省略可） | 省略すると `gemini-3.5-flash-lite` |
3. Preview でも試したいときは、Preview にも同じものを入れる
4. 設定は次のデプロイから効く。「デプロイ」タブで最新のデプロイを「再試行」すればすぐ効く

### 3. 送りすぎを止める（Cloudflare）

無料プランのレート制限ルールは 1 つしか作れないので、集計システムのルール（`programs/event_guide_counter/README.md` の手順9）の式に足す。
ルールの「式を編集」で、次のようにする（IP ごと・10 秒に 20 回を超えたらブロック、のまま）:

```
(http.host eq "event-guide-counter.iku-navi.net" and starts_with(http.request.uri.path, "/api/track/"))
or (http.host eq "iku-navi.net" and http.request.uri.path eq "/api/help-chat")
```

### 4. 本番で確かめる

1. スマートフォンで https://iku-navi.net/navi/ を開き、「？」を押す
2. よくある質問が開けること、「AI に質問する」に「ゼミ44Aへの行き方は？」と送って、目的地に入れて検索するよう答えが返ること
3. 「今日の天気は？」など関係ない質問に、答えないこと

## 費用とデータの扱い

- **無料枠**：料金はかからないが、1 分・1 日あたりの回数に上限がある。超えると「いま質問が集中しています」と出る。
  また、**無料枠では、送った質問が Google の製品改善に使われる**（画面に「個人情報は書かないでください」と出している）
- **有料枠**（AI Studio で請求先を設定）：質問は製品改善に使われない。料金は使った分だけ
  （2026-10 時点の Gemini 3.5 Flash-Lite は、入力 100 万トークンあたり $0.30、出力 $2.50。
  1 回の質問は、説明を含めて入力 2,000〜3,000 トークンほど）。使いすぎに気づけるよう、Google Cloud で予算のアラートを設定しておく
- 料金とモデルは変わるので、https://ai.google.dev/gemini-api/docs/pricing と https://ai.google.dev/gemini-api/docs/models で確かめる

## 止めたいとき

Pages の `GEMINI_API_KEY` を消して再デプロイすると、AI への質問だけが止まり「今は使えません」と出る（よくある質問はそのまま使える）。
キーが漏れたときは、AI Studio でそのキーを削除してから作り直す。

## よくある質問を直すとき

`programs/html/navi/faq.json` を直してデプロイするだけ（画面と AI の両方に効く）。
画面のボタンや欄の名前を変えたときは、faq.json の書き方も合わせる（AI もこの名前で案内する）。
