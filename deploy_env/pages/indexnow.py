"""IndexNow（https://www.indexnow.org/）で、サイトの URL の更新を検索エンジン（Bing など）にすぐ知らせる。

公開中の sitemap.xml に載っている URL を、まとめて api.indexnow.org に送る。
api.indexnow.org に送れば、IndexNow に参加しているほかの検索エンジンにも共有される。

    python3 deploy_env/pages/indexnow.py            # 送る
    python3 deploy_env/pages/indexnow.py --dry-run  # 送る URL を表示するだけ

キーは programs/html/<キー>.txt としてサイトのルートに置いてある（検索エンジンがこれを読んで、
送り主がこのサイトの持ち主だと確かめる）。キーは公開して使うもので、秘密の値ではない。
キーを変えるときは、ファイル名・中身・下の KEY の 3 つを揃えて変える。

GitHub Actions（.github/workflows/indexnow.yml）が、main への push のあと Pages のデプロイを待ってから実行する。
標準ライブラリだけで動く。
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

HOST = "iku-navi.net"
SITE = f"https://{HOST}"
KEY = "5702f9d774744ddf99354672fbfc5367"
KEY_LOCATION = f"{SITE}/{KEY}.txt"
ENDPOINT = "https://api.indexnow.org/indexnow"
SITEMAP_NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"
USER_AGENT = "IKU-NAVI-IndexNow/1.0"

# 応答コードの意味（https://www.indexnow.org/documentation）
STATUS = {
    200: "受け付けられた",
    202: "受け付けられた（キーの確認待ち）",
    400: "リクエストの形が正しくない",
    403: "キーが正しくない（キーファイルが無い・中身が違う）",
    422: "URL がこのサイトのものでない、またはキーが合わない",
    429: "送りすぎ（しばらく待つ）",
}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return res.read().decode("utf-8")


def urls_from_sitemap(xml_text):
    """sitemap.xml の <loc> を、このサイトのものだけ順番どおり（重複なし）に取り出す。"""
    root = ET.fromstring(xml_text)
    urls = []
    for loc in root.iter(f"{SITEMAP_NS}loc"):
        url = (loc.text or "").strip()
        if url.startswith(SITE + "/") and url not in urls:
            urls.append(url)
    return urls


def payload(urls):
    return {"host": HOST, "key": KEY, "keyLocation": KEY_LOCATION, "urlList": urls}


def wait_for_key(tries, interval):
    """キーファイルが公開されるまで待つ（初めて入れたときは、Pages のデプロイが終わるまで 404 になる）。"""
    for i in range(tries):
        try:
            if get(KEY_LOCATION).strip() == KEY:
                return True
            print(f"[indexnow] キーファイルの中身が違う: {KEY_LOCATION}", file=sys.stderr)
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"[indexnow] キーファイルがまだ読めない（{i + 1}/{tries}）: {e}", file=sys.stderr)
        if i + 1 < tries:
            time.sleep(interval)
    return False


def submit(urls):
    body = json.dumps(payload(urls)).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": USER_AGENT},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status
    except urllib.error.HTTPError as e:
        return e.code


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="送らずに、送る URL を表示するだけ")
    ap.add_argument("--key-tries", type=int, default=20, help="キーファイルの公開を確かめる回数（既定 20 回）")
    ap.add_argument("--key-interval", type=int, default=30, help="確かめる間隔（秒、既定 30 秒）")
    args = ap.parse_args()

    urls = urls_from_sitemap(get(f"{SITE}/sitemap.xml"))
    if not urls:
        print("[indexnow] sitemap.xml に URL が無い", file=sys.stderr)
        return 1
    print(f"[indexnow] {len(urls)} 件の URL を送る")
    for u in urls:
        print(f"  {u}")
    if args.dry_run:
        return 0

    if not wait_for_key(args.key_tries, args.key_interval):
        print(f"[indexnow] キーファイルが公開されていないので送らない: {KEY_LOCATION}", file=sys.stderr)
        return 1

    status = submit(urls)
    print(f"[indexnow] 応答 {status}: {STATUS.get(status, '想定外の応答')}")
    return 0 if status in (200, 202) else 1


if __name__ == "__main__":
    sys.exit(main())
