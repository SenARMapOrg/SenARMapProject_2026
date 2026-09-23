"""イベントモード（data/event.csv に登録した屋台・催し）"""
from flask import Blueprint, jsonify

from .. import cache

bp = Blueprint("events", __name__)


@bp.route("/api/events")
def api_events():
    """
    event.csv に登録されたイベント（屋台など）の一覧を返す。
    返却形式: [ { "title": "たこ焼き屋台", "building": 10, "floor": 1 }, ... ]
    """
    _, events_list = cache.get_event_index()
    return jsonify(events_list)
