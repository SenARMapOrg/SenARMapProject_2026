# ナビの「使い方」（よくある質問）

ナビ画面（`/navi/`）の上にある「？」ボタンから開く。中身は **よくある質問** だけ。

- 質問と答えは `programs/html/navi/faq.json`（`{"q": 質問, "a": 答え}` の並び）
- 画面は `programs/html/navi/script/help.js`。faq.json を読んで、開いて読める一覧にするだけで、サーバーには何も送らない
- 設定は要らない。faq.json を直して Pages にデプロイすれば、そのまま反映される
- `programs/html/tests/test_help.py` が、faq.json の形（q と a がある・同じ質問が2つない）を確かめる

画面のボタンや欄の名前を変えたときは、faq.json の書き方も合わせる。

## 外したもの（2026-11-15）

次の2つは使わなくなったので外した。

- **AI に質問する**：上にない質問を Gemini に答えさせていた（`functions/api/help-chat.js`・`POST /api/help-chat`）。
  Pages の環境変数 `GEMINI_API_KEY`・`GEMINI_MODEL` はもう使わないので消してよい。
  キーは Google AI Studio（https://aistudio.google.com/apikey）でも削除しておく
- **オペレーター（人）に相談する**：AI の答えの下に出していた「オペレーター（人）につなぐ」。
  ナビ画面からつなぐ入口が無くなったので、利用者からは使えない。
  受け手の集計システム（`programs/event_guide_counter` の `/api/support/*` と、管理画面の「相談窓口」）は残っている

### 送りすぎを止めるルール（Cloudflare のレート制限）

集計システムの記録・相談・AI への質問を1つのルールにまとめていた。`/api/help-chat` は無くなったので、
ルールの式から次の行を消してよい（残っていても害は無い）:

```
or (http.host eq "iku-navi.net" and http.request.uri.path eq "/api/help-chat")
```

残りの式（集計システムの `/api/track/` と `/api/support/start`・`/api/support/send`）はそのまま使う:

```
(http.host eq "event-guide-counter.iku-navi.net" and (starts_with(http.request.uri.path, "/api/track/") or http.request.uri.path in {"/api/support/start" "/api/support/send"}))
```

設定する場所と、残りの欄（IP ごと・10 秒に 20 回・10 秒ブロック）は `programs/event_guide_counter/README.md` の手順9。
