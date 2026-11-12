"""JS の経路計算（programs/html/shared/route-core.mjs）が、Python の経路探索API と同じ答えを返すことの確認。

経路計算を Python から JS に移す途中なので、同じ問い合わせを両方に投げて1件ずつ比べる（route_js_check.py）。
Python 側（ikunavi/）だけを直すと、ここが落ちて JS の直し忘れに気付ける。
"""
import os
import shutil

import pytest

import route_js_check

needs_node = pytest.mark.skipif(
    shutil.which("node") is None and not os.environ.get("CI"),
    reason="node が無い（CI では必ず動かす）",
)


def _report(mismatches, total):
    lines = [f"{total:,} 件中 {len(mismatches):,} 件で Python と JS の答えが違う"]
    lines += [f"  {q}\n    {d}" for q, d in mismatches[:10]]
    return "\n".join(lines)


@needs_node
def test_小さなキャンパスで全部の組み合わせが同じ(tiny_campus):
    # 合成データは長さが整数で、同じ長さの経路が複数できる（どれを選ぶかまで同じかを見る）
    mismatches, total = route_js_check.check(full=True, progress=lambda _: None)
    assert total > 0
    assert not mismatches, _report(mismatches, total)


@needs_node
def test_今のdataで同じ(real_data):
    mismatches, total = route_js_check.check(full=False, progress=lambda _: None)
    assert total > 5000
    assert not mismatches, _report(mismatches, total)
