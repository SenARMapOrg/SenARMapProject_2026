"""合成キャンパス（conftest.py が組み立てるテスト用データ）のグローバルID。

テストからは `from tiny_campus import B1, B2, OUT` で読む。`from conftest import ...` にすると、
リポジトリ内の別のテスト（programs/IKU_NAVI_Tools/tests など）にも conftest.py があるため、
まとめて実行したときに別の conftest を読んでしまう。
"""

B1 = {n: 100000 + n for n in range(1, 6)}
B2 = {n: 200000 + n for n in range(1, 6)}
OUT = {1: 9000001, 2: 9000002}
