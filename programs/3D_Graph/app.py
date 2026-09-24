"""IKU NAVI 経路探索APIのエントリポイント（gunicorn は app:app を読む）。

実装は ikunavi/ パッケージにある。構成の概要は ikunavi/__init__.py の
docstring と docs/PROJECT_BIBLE.md を参照。
"""
from ikunavi import create_app

app = create_app()

if __name__ == "__main__":
    app.run(debug=False, host="0.0.0.0", port=5001)
