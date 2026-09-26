"""経路探索API（programs/3D_Graph）へのアクセス。

チェッカー系ツールは何百リクエストも並列に投げるため、リトライ付きの
Session を使う。ツールによって必要なヘッダとリトライ回数が違うので引数で渡す。
"""
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

DEFAULT_API = "http://localhost:5001"

JSON_HEADERS = {"Accept": "application/json"}

# CDN(Cloudflare)への画像取得はブラウザからのアクセスに見せる必要がある。
# Accept-Encoding に "br" を入れると Cloudflare が Brotli で返し、
# brotli パッケージ未インストール環境では解凍できず空になるため除外。
# requests のデフォルト (gzip, deflate) に任せる。
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
    "Connection":      "keep-alive",
}


def make_session(headers=None, total=2, backoff_factor=0.3,
                 status_forcelist=(500, 502, 503, 504)) -> requests.Session:
    """リトライを設定した requests.Session を返す"""
    session = requests.Session()
    if headers:
        session.headers.update(headers)
    adapter = HTTPAdapter(max_retries=Retry(
        total=total, backoff_factor=backoff_factor,
        status_forcelist=list(status_forcelist)))
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session
