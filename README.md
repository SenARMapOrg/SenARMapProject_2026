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

## 技術スタック

- **バックエンド:** Python 3 / Flask / Gunicorn / NetworkX / pandas
- **フロントエンド:** HTML / CSS / Vanilla JavaScript / Google Maps API / Inline SVG
- **インフラ:** Docker (Swarm) / ConoHa VPS / Cloudflare Pages（静的配信）
- **ネットワーク:** Cloudflare Tunnels（API 公開）/ Cloudflare R2（画像 CDN）

## ディレクトリ構成

```
SenARMapProject_2026/
├── programs/
│   ├── 3D_Graph/          # Flask バックエンド (app.py) + 3D 経路ビューア（経路探索APIの実体）
│   ├── html/               # Cloudflare Pages 公開ルート（ナビ UI・AR画面・blog・SVG 等。本番で実際に配信されるのはこちら）
│   ├── Website/             # プロジェクト紹介 LP（学内発表用、Pages では非公開）
│   ├── Map_Editor/          # ノード・エッジ・経路写真をまとめて入力する統合編集GUI（PyQt6）
│   ├── Image_Checker/       # CDN上のエッジ画像の存在確認GUI（PyQt6）
│   ├── Route_Checker/       # 全教室ペア間ルートの異常検出GUI（PyQt6）
│   ├── Image_Renamer/       # 画像の一括リネーム／リサイズツール（PyQt6）
│   ├── SVG_Pointer/         # SVG座標取得ツール（PyQt5）
│   ├── Human_Remover/       # YOLOv8 による経路写真の人物匿名化バッチツール（PyQt6）
│   ├── events/              # イベントモード（event.csv）設定用GUI（PyQt6）
│   ├── image_uploader/      # Cloudflare Pages + R2 を使った画像一括アップローダー
│   ├── timetables/          # 時間割共有サービス（Cloudflare Pages Functions + D1、別サービス）
│   └── syllabus_courses/    # timetables 用シラバススクレイパー
├── data/                    # CSV / JSON データ（ノード・エッジ・食堂・画像マッピング・名前DB・イベント等、建物別サブディレクトリあり）
├── docs/                    # 設計ドキュメント（技術概要・API仕様・座標設計・非機能要件・名前DB/イベントモード・Cloudflare移行手順・PROJECT_BIBLEほか）
├── deploy_env/              # 本番 Docker Swarm 構成 + Cloudflare Pages ビルド設定（+ 不採用のk8s構成）
├── enviroments/             # ローカル開発用 Docker 構成
└── paper/                   # 学会発表・活動報告用の論文・資料（LaTeX）
```


