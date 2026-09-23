"""IKU NAVI 経路探索API本体。

構成:
  config.py     … データのパスと定数
  transform.py  … 建物ローカル座標 → キャンパス共通座標 の変換
  dataset.py    … CSV読み込み（全建物＋屋外を1組のDataFrameに）
  graph.py      … NetworkXグラフの構築
  naming.py     … 内部識別子 → 表示名
  cache.py      … 起動後に一度だけ作る派生データ
  search.py     … 候補ノードの解決と最短経路探索
  serialize.py  … 探索結果 → APIレスポンス用dict
  payloads.py   … /api/graph 用のペイロード
  routes/       … エンドポイント（Blueprint）
"""
import os
import re

from flask import Flask, request

from . import cache, naming, payloads
from .config import BASE_DIR, CORS_ALLOWED_ORIGINS, CORS_ORIGIN_PATTERN
from .errors import register_error_handler
from .routes import BLUEPRINTS

_cors_origin_pattern = re.compile(CORS_ORIGIN_PATTERN)


def _register_cors(app):
    @app.after_request
    def add_cors_headers(response):
        origin = request.headers.get("Origin", "")
        if origin in CORS_ALLOWED_ORIGINS or _cors_origin_pattern.match(origin):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Vary"] = "Origin"
        return response


def create_app():
    app = Flask(
        __name__,
        template_folder=os.path.join(BASE_DIR, "templates"),
        static_folder=os.path.join(BASE_DIR, "static"),
    )
    _register_cors(app)
    register_error_handler(app)
    for bp in BLUEPRINTS:
        app.register_blueprint(bp)
    return app


def clear_all_caches():
    """CSVを読み直したいときに、全モジュールのキャッシュを捨てる"""
    cache.clear_caches()
    naming.clear_caches()
    payloads.clear_caches()
