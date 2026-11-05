"""バックアップ環境（deploy_env/backup）用に作るサイトが、本番のドメインに頼らないことの確認。"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "deploy_env" / "backup" / "build_site.py"
DOMAIN = "example-backup.test"


def build(tmp_path):
    out = tmp_path / "site"
    env = {**os.environ, "BACKUP_DOMAIN": DOMAIN, "GOOGLE_MAPS_API_KEY": "dummy-key"}
    subprocess.run([sys.executable, str(SCRIPT), "--out", str(out)], check=True, capture_output=True, env=env)
    return out


def test_本番のURLがバックアップのドメインに置き換わる(tmp_path):
    out = build(tmp_path)
    assert f'"https://api.{DOMAIN}"' in (out / "navi" / "script" / "state.js").read_text(encoding="utf-8")
    assert f"https://cdn.{DOMAIN}/Straight.png" in (out / "navi" / "script" / "state.js").read_text(encoding="utf-8")
    assert f"https://{DOMAIN}/navi/" in (out / "ohtori_events" / "ohtori_events.csv").read_text(encoding="utf-8")
    for path in out.rglob("*"):
        if path.suffix in {".html", ".js", ".csv", ".xml", ".json"}:
            text = path.read_text(encoding="utf-8")
            for prod in ("https://iku-navi.net", "https://api.iku-navi.net", "https://cdn.iku-navi.net"):
                assert prod not in text, f"{path} に {prod} が残っている"


def test_Cloudflareでしか動かない集計はそのまま(tmp_path):
    track = (build(tmp_path) / "navi" / "script" / "track.js").read_text(encoding="utf-8")
    assert "https://event-guide-counter.iku-navi.net" in track


def test_検索に出さずPages用の設定とテストは配信しない(tmp_path):
    out = build(tmp_path)
    assert "Disallow: /" in (out / "robots.txt").read_text(encoding="utf-8")
    assert "dummy-key" in (out / "navi" / "script" / "config.js").read_text(encoding="utf-8")
    assert (out / "campus" / "index.html").exists()
    for name in ("tests", "_headers", "_redirects", "sitemap.xml"):
        assert not (out / name).exists(), name


def test_ドメインが空や本番のときは作らない(tmp_path):
    for domain in ("", "iku-navi.net"):
        env = {**os.environ, "BACKUP_DOMAIN": domain, "GOOGLE_MAPS_API_KEY": "dummy-key"}
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--out", str(tmp_path / "site")], capture_output=True, env=env
        )
        assert result.returncode != 0
