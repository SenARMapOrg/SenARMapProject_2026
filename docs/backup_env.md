# バックアップ環境

Cloudflare（Tunnel・Pages・R2・DNS）が使えないときに、別のドメインで案内を続けるための環境。
本番の Swarm とは別のサーバーで、普段から動かしておく。

```
https://<ドメイン>      → Caddy → public/site（programs/html を置き換えたもの）
https://api.<ドメイン>  → Caddy → python（経路API）
https://cdn.<ドメイン>  → Caddy → public/cdn（経路写真の複製）
```

- 自動では切り替わらない。障害のときは SNS や掲示でバックアップのURLを案内する。
- `iku-navi.net` のQRコードはこちらに来ない（DNS が Cloudflare にあるため）。
- ドメインの DNS は Cloudflare 以外で管理する。
- cloudflared はつながない（つなぐと本番の通信がこのサーバーへ流れることがある）。

## 使えない機能

| 機能 | 理由 | この環境での動き |
|---|---|---|
| AIチャット | Pages Functions で動いている | 使えない旨を表示 |
| 有人サポート・案内人数の集計 | `event-guide-counter.iku-navi.net` で動いている | 送れない（本番の Cloudflare が生きていても、別ドメインからの記録は受け付けない） |
| `/redirect/`（counter） | 置いていない | 404 |

## 準備

1. サーバーの 80/tcp・443/tcp・443/udp を外から開ける。
2. DNS で `<ドメイン>`・`api.<ドメイン>`・`cdn.<ドメイン>` をサーバーのIPへ向ける。
3. Google Cloud で、Maps API キーのリファラー制限に `https://<ドメイン>/*` を足す。
4. サーバーに Docker と python3 を入れて、リポジトリを clone する。
5. 設定を書いて起動する。写真の複製で、初回は約550MBをダウンロードする。

```bash
cd SenARMapProject_2026/deploy_env/backup
cp sample.env .env
vim .env
./update.sh
```

## 確認

```bash
D=<ドメイン>
curl -sI https://$D/navi/ | head -1
curl -s https://api.$D/api/edge_images | head -c 200   # cdn.<ドメイン> のURLが返ること
curl -sI -H "Origin: https://$D" https://api.$D/api/all | grep -i access-control
curl -sI https://cdn.$D/Straight.png | head -1
```

最後に、スマホのモバイル回線で教室を検索して、経路・写真・地図が出ることを確かめる。

## 更新

`./update.sh` で、今のブランチの最新を取り込む。データの修正を追いかけるなら cron に入れる。

```cron
*/30 * * * * /path/to/SenARMapProject_2026/deploy_env/backup/update.sh >> /tmp/iku-backup.log 2>&1
```

- 止めたいときは `deploy_env/backup/update.lock` を置く。
- 同じ名前で差し替えた写真は `python3 sync_cdn.py --verify` で取り直す。CDN に無い写真は名前を表示するだけで、処理は止めない。
