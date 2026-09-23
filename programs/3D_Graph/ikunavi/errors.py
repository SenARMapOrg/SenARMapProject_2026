"""APIのエラー応答。

ルート関数の途中で ApiError を送出すると {"error": メッセージ} と
指定ステータスのJSONになる。エラーのたびに return jsonify(...), status を
書かずに済むので、ルート本体は正常系だけを読めばよくなる。
"""
from flask import jsonify


class ApiError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


def register_error_handler(app):
    @app.errorhandler(ApiError)
    def _handle_api_error(err):
        return jsonify({"error": err.message}), err.status
