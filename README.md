# IKU NAVI - 専修大学 生田キャンパス ARナビゲーション

2026年度 専修大学 ネットワーク情報学部 生亀プロジェクト

## 概要

専修大学 生田キャンパス内をナビゲートする AR 対応ナビゲーション Web アプリ。  
CSV ベースのノード・エッジデータから Dijkstra 法で最短経路を計算し、屋外は Google Maps、屋内は SVG フロアマップでルートを表示する。  
AR 領域にはエッジ間の経路写真（Cloudflare R2 CDN 配信）を表示し、スマートフォンの GPS と組み合わせてステップナビゲーションを行う。

## 実際のサイト

本番環境のIKU NAVIへは下のリンクから
[IKU NAVI](https://iku-navi.net/ "IKU NAVI")

![プロジェクトロゴ](/images/logo.png)

## テスト

```bash
# 経路探索API（programs/3D_Graph）とナビ画面のHTML/JSの噛み合わせ
pip install -r programs/3D_Graph/requirements-dev.txt
pytest

# 時間割サービス
cd programs/timetables && npm ci && npm run typecheck && npm test
```

push / Pull Request のたびに GitHub Actions（`.github/workflows/test.yml`）が同じものを実行し、
`main` への push では通った場合だけ本番 Docker イメージがビルドされる。
詳しくは `docs/PROJECT_BIBLE.md` の 8.4 節を参照。

## 技術スタック

- **バックエンド:** Python 3 / Flask / Gunicorn / NetworkX / pandas
- **フロントエンド:** HTML / CSS / Vanilla JavaScript / Google Maps API / Inline SVG
- **インフラ:** Docker (Swarm) / ConoHa VPS / Cloudflare Pages（静的配信）
- **ネットワーク:** Cloudflare Tunnels（API 公開）/ Cloudflare R2（画像 CDN）

## ディレクトリ構成

```
SenARMapProject_2026/
├── programs/
│   ├── 3D_Graph/          # Flask バックエンド (app.py + ikunavi/) + 3D 経路ビューア（経路探索APIの実体）
│   ├── html/               # Cloudflare Pages 公開ルート（ナビ UI・AR画面・blog・SVG 等。本番で実際に配信されるのはこちら）
│   ├── Website/             # プロジェクト紹介 LP（学内発表用、Pages では非公開）
│   ├── IKU_NAVI_Tools/      # データ作成・検証用デスクトップアプリ（PyQt6）。マップ編集・イベント設定・ルート検証・画像チェック・画像リネーム・人物ぼかし・SVG座標取得をタブで切り替えて使う
│   ├── image_uploader/      # Cloudflare Pages + R2 を使った画像一括アップローダー
│   ├── timetables/          # 時間割共有サービス（Cloudflare Pages Functions + D1、別サービス）
│   └── syllabus_courses/    # timetables 用シラバススクレイパー
├── data/                    # CSV / JSON データ（ノード・エッジ・食堂・画像マッピング・名前DB・イベント等、建物別サブディレクトリあり）
├── pytest.ini               # テスト設定（programs/3D_Graph/tests と programs/html/tests を実行）
├── docs/                    # 設計ドキュメント（技術概要・API仕様・座標設計・非機能要件・名前DB/イベントモード・Cloudflare移行手順・PROJECT_BIBLEほか）
├── deploy_env/              # 本番 Docker Swarm 構成 + Cloudflare Pages ビルド設定（+ 不採用のk8s構成）
├── enviroments/             # ローカル開発用 Docker 構成
└── paper/                   # 学会発表・活動報告用の論文・資料（LaTeX）
```


