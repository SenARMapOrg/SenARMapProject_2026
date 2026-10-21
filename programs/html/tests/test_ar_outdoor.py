"""屋外ARの精度向上（位置のなめらか化・コンパスの補正）と、屋外ステップの自動送りの計算（navi/script/ar.js）。

ar.js はブラウザで普通のスクリプトとして読み込むファイルなので、Node の vm でそのまま読み込み、
定義されている関数を呼んで確かめる（トップレベルでは定数・変数・関数の宣言しかしていないため、
ブラウザの API が無くても読み込める）。Node が無い環境ではスキップする。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

AR_JS = Path(__file__).resolve().parents[1] / "navi" / "script" / "ar.js"

# 生田キャンパス付近の基準点。緯度1度 ≒ 111,320m、経度1度 ≒ 111,320m × cos(緯度)
LAT0, LNG0 = 35.6125, 139.5530

RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const ctx = { console, Date, Math };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), ctx);
// ステップ送りの確認用に、route.js が持つ状態と関数の代わりを用意する
vm.runInContext(`
  var pathCoords = [];
  var currentStep = 0;
  var stepLog = [];
  function goToStep(step, opts) { currentStep = step; stepLog.push(step); }
`, ctx);
const out = vm.runInContext(process.argv[2], ctx);
process.stdout.write(JSON.stringify(out));
"""


def run_js(expr: str):
    """ar.js を読み込んだ環境で式を評価し、結果を JSON で受け取る"""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    result = subprocess.run(
        [node, "-e", RUNNER, str(AR_JS), expr],
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def offset(north_m: float, east_m: float):
    """基準点から北に north_m、東に east_m 動いた緯度経度"""
    import math
    lat = LAT0 + north_m / 111320
    lng = LNG0 + east_m / (111320 * math.cos(math.radians(LAT0)))
    return lat, lng


# ---------------------------------------------------------------- 位置のなめらか化

def test_精度の悪い位置は使わない():
    out = run_js("arFilterGpsFix(null, 35.6, 139.55, 80, 0)")
    assert out == {"state": None, "accepted": False}


def test_揺れる位置をならして真の位置に近づける():
    # 実際は基準点に立ち止まっている。±8m の精度で東西南北に交互に揺れた位置が来る
    fixes = []
    for i, (n, e) in enumerate([(7, 0), (-7, 0), (0, 7), (0, -7)] * 5):
        lat, lng = offset(n, e)
        fixes.append([lat, lng, 8, i * 1000])
    out = run_js(f"""
      let s = null;
      for (const [lat, lng, acc, t] of {json.dumps(fixes)}) s = arFilterGpsFix(s, lat, lng, acc, t).state;
      const p = arFilteredPosition(s);
      ({{ lat: p.lat, lng: p.lng, accuracy: p.accuracy }})
    """)
    import math
    dn = (out["lat"] - LAT0) * 111320
    de = (out["lng"] - LNG0) * 111320 * math.cos(math.radians(LAT0))
    # 1回ごとの揺れは7mだが、ならした位置は基準点から数m以内に収まる
    assert math.hypot(dn, de) < 3
    assert out["accuracy"] < 8


def test_大きく外れた位置は捨てるが_外れが続けば移動したとみなす():
    near = offset(0, 0)
    far = offset(200, 0)  # 200m 北（建物の陰で大きく外れた位置）
    out = run_js(f"""
      let r = arFilterGpsFix(null, {near[0]}, {near[1]}, 5, 0);
      const results = [];
      for (let i = 1; i <= 3; i++) {{
        r = arFilterGpsFix(r.state, {far[0]}, {far[1]}, 5, i * 1000);
        results.push([r.accepted, (arFilteredPosition(r.state).lat - {LAT0}) * 111320]);
      }}
      results
    """)
    assert out[0][0] is False and abs(out[0][1]) < 1   # 1回目: 捨てる（位置は動かない）
    assert out[1][0] is False and abs(out[1][1]) < 1   # 2回目: まだ捨てる
    assert out[2][0] is True and abs(out[2][1] - 200) < 1  # 3回続いた: 移動したとみなす


# ---------------------------------------------------------------- コンパスの補正

def test_磁北基準の向きを真北基準に直す():
    out = run_js("[arTrueNorthAlpha(0, true), arTrueNorthAlpha(355, true), arTrueNorthAlpha(90, false)]")
    assert out[0] == pytest.approx(7.6)
    assert out[1] == pytest.approx(2.6)   # 360度をまたいでも 0〜360 に収まる
    assert out[2] == pytest.approx(90)    # 基準の無い（相対的な）向きは補正しない


def test_向きのなめらか化は0度をまたいでも近い向きへ回る():
    out = run_js("[arSmoothAngle(null, 10, 0.2), arSmoothAngle(350, 10, 0.5), arSmoothAngle(10, 350, 0.5)]")
    assert out[0] == pytest.approx(10)
    assert out[1] == pytest.approx(0)     # 350→10 は 20度だけ回る（340度逆回りしない）
    assert out[2] == pytest.approx(0)


# ---------------------------------------------------------------- 通過の判定

def node(north_m, east_m):
    lat, lng = offset(north_m, east_m)
    return {"lat": lat, "lng": lng, "building": 0}


def passed(user_n, user_e, accuracy, a, b):
    lat, lng = offset(user_n, user_e)
    user = {"lat": lat, "lng": lng, "accuracy": accuracy}
    return run_js(f"arStepPassed({json.dumps(user)}, {json.dumps(a)}, {json.dumps(b)})")


A, B = node(0, 0), node(50, 0)  # a から北へ50mの b


def test_次の地点の近くに来たら通過():
    assert passed(45, 0, 5, A, B) is True     # b の5m手前
    assert passed(30, 0, 5, A, B) is False    # まだ20m手前


def test_次の地点の近くを通らずに追い越しても通過():
    assert passed(65, 8, 5, A, B) is True     # b を15m過ぎ、区間の線から8m横
    assert passed(65, 40, 5, A, B) is False   # b より先だが、区間から40mも横にずれている（別の道）


def test_始点の座標が無くても_次の地点の近くなら通過():
    assert passed(48, 0, 5, None, B) is True  # 建物の出口（屋内で座標が無い）から出てきた場合
    assert passed(65, 0, 5, None, B) is False  # 追い越しは始点が無いと判定できない


# ---------------------------------------------------------------- 自動送り

def auto_advance(user_points, start_step=0, paused=False):
    """経路: 屋内 → 屋外0m → 屋外50m北 → 屋外100m北 → 屋内（到着）。位置を順に入れて、進んだステップを返す"""
    path = [{"building": 10, "lat": None},
            node(0, 0), node(50, 0), node(100, 0),
            {"building": 2, "lat": None}, {"building": 2, "lat": None}]
    users = []
    for n, e in user_points:
        lat, lng = offset(n, e)
        users.append({"lat": lat, "lng": lng, "accuracy": 5})
    return run_js(f"""
      pathCoords = {json.dumps(path)};
      currentStep = {start_step};
      {"arPauseAutoAdvance();" if paused else ""}
      for (const u of {json.dumps(users)}) arCheckAutoAdvance(u);
      ({{ step: currentStep, log: stepLog }})
    """)


def test_次の地点を通過したと2回続けて判定されたら1つ進む():
    out = auto_advance([(48, 0)], start_step=1)
    assert out["step"] == 1                   # 1回だけでは進まない（揺れ対策）
    out = auto_advance([(48, 0), (49, 0)], start_step=1)
    assert out == {"step": 2, "log": [2]}


def test_歩いていくと順にステップが進む():
    out = auto_advance([(10, 0), (48, 0), (50, 0), (70, 0), (97, 0), (99, 0)], start_step=1)
    assert out["log"] == [2, 3]


def test_次が屋内の地点なら位置では進めない():
    # ステップ3（屋外の最後の地点 → 建物の入口）は、入口に座標が無いので位置で判定しない
    out = auto_advance([(100, 0), (101, 0), (102, 0)], start_step=3)
    assert out["step"] == 3


def test_建物の出口から出て最初の地点に着いたら進む():
    out = auto_advance([(2, 0), (1, 0)], start_step=0)
    assert out["step"] == 1


def test_ボタンで動かした直後は自動送りしない():
    out = auto_advance([(48, 0), (49, 0)], start_step=1, paused=True)
    assert out["step"] == 1
