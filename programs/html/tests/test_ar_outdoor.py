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


# ---------------------------------------------------------------- 経路の線への吸着

def snap(user_n, user_e, path, step):
    lat, lng = offset(user_n, user_e)
    user = {"lat": lat, "lng": lng, "accuracy": 8}
    out = run_js(f"""
      pathCoords = {json.dumps(path)};
      arSnapToRoute({json.dumps(user)}, arRouteSegmentsNear({step}))
    """)
    if out["snapped"]:
        # 結果を基準点からの北・東（m）に直して返す
        import math
        out["n"] = (out["lat"] - LAT0) * 111320
        out["e"] = (out["lng"] - LNG0) * 111320 * math.cos(math.radians(LAT0))
    return out


# 屋外0m → 50m北 → 50m北・50m東（北へ歩いて右に曲がる）
CORNER = [node(0, 0), node(50, 0), node(50, 50)]


def test_区間の線から少しずれた位置は線の上に寄せる():
    out = snap(20, 6, CORNER, 0)
    assert out["snapped"] is True
    assert out["n"] == pytest.approx(20, abs=0.01)
    assert out["e"] == pytest.approx(0, abs=0.01)
    assert out["bearing"] == pytest.approx(0, abs=0.01)    # 北向きの区間


def test_曲がり角の先の区間にも寄せる():
    # まだステップ0（北へ向かう区間）でも、曲がった先の区間に近ければそちらに寄せる
    out = snap(54, 30, CORNER, 0)
    assert out["snapped"] is True
    assert out["n"] == pytest.approx(50, abs=0.01)
    assert out["e"] == pytest.approx(30, abs=0.01)
    assert out["bearing"] == pytest.approx(90, abs=0.01)   # 東向きの区間


def test_区間の線から遠い位置は寄せない():
    out = snap(20, 25, CORNER, 0)
    assert out["snapped"] is False


def test_屋内の地点を含む区間には寄せない():
    path = [{"building": 10, "lat": None}, node(0, 0)]
    assert snap(0, 1, path, 0)["snapped"] is False


# ---------------------------------------------------------------- 歩いた向きでのコンパスの補正

def heading_offset(points, cams, route_bearing):
    """points: 北・東（m）の位置の列、cams: その時のカメラの方位（度）"""
    track = [{"north": n, "east": e, "cam": c} for (n, e), c in zip(points, cams)]
    return run_js(f"arEstimateHeadingOffset({json.dumps(track)}, {json.dumps(route_bearing)})")


STRAIGHT_NORTH = [(0, 0), (4, 0.5), (8, -0.5), (12, 0), (16, 0)]


def test_経路に沿ってまっすぐ歩いたらコンパスのずれを求める():
    # 北へ歩いているのに、コンパスは 15度（東寄り）を指している → ずれは −15度
    assert heading_offset(STRAIGHT_NORTH, [15, 14, 16, 15, 15], 0) == pytest.approx(-15, abs=0.5)
    # 0度をまたぐ向き（350度前後）でも正しく平均する
    assert heading_offset(STRAIGHT_NORTH, [350, 352, 348, 350, 350], 0) == pytest.approx(10, abs=0.5)


def test_歩いた距離が短いときは求めない():
    assert heading_offset([(0, 0), (3, 0), (6, 0)], [15, 15, 15], 0) is None


def test_経路から外れているときは求めない():
    assert heading_offset(STRAIGHT_NORTH, [15] * 5, None) is None


def test_経路と違う向きに歩いているときは求めない():
    # 経路は東向きなのに、北へ歩いている
    assert heading_offset(STRAIGHT_NORTH, [0] * 5, 90) is None


def test_横を見ながら歩いているときは求めない():
    assert heading_offset(STRAIGHT_NORTH, [80] * 5, 0) is None


def test_曲がる前の位置は捨てて_曲がった後のまっすぐな部分で求める():
    # 東へ歩いてから北へ曲がった。曲がった後だけで12m以上あれば、その部分で求める
    points = [(0, -20), (0, -10), (0, 0), (5, 0), (10, 0), (15, 0)]
    cams = [90, 90, 5, 5, 5, 5]
    assert heading_offset(points, cams, 0) == pytest.approx(-5, abs=0.5)


# ---------------------------------------------------------------- 目印を出す範囲

def visible(marker, step):
    return run_js(f"arMarkerVisible({json.dumps(marker)}, {step})")


def test_今のステップから5区間先までの経路を出す():
    # ステップ 1 にいるとき、区間は 1〜5、地点は 1〜6 を出す（遠くても出す）
    assert visible({"type": "edge", "idx": 1, "x": 0, "z": -500}, 1) is True
    assert visible({"type": "edge", "idx": 5}, 1) is True
    assert visible({"type": "edge", "idx": 6}, 1) is False
    assert visible({"type": "node", "idx": 6}, 1) is True
    assert visible({"type": "node", "idx": 7}, 1) is False


def test_通り過ぎた経路は出さない():
    assert visible({"type": "edge", "idx": 0}, 1) is False
    assert visible({"type": "node", "idx": 0}, 1) is False


def test_AR表示中に経路に沿って歩くとコンパスのずれを学んでいく():
    # 北へ100mの経路を、カメラを前に向けて歩く。コンパス（真北に直した後の alpha）は 20度ずれている
    # （方位で 20度東寄り＝alpha は 340度）。GPS の位置は経路から4m東にずれている
    path = [node(0, 0), node(100, 0), node(100, 50)]
    fixes = []
    for i in range(0, 40):
        lat, lng = offset(i * 1.5, 4)
        fixes.append({"coords": {"latitude": lat, "longitude": lng, "accuracy": 5}, "timestamp": i * 1000})
    out = run_js(f"""
      pathCoords = {json.dumps(path)};
      currentStep = 0;
      arRunning = true;
      arGOrient = {{ beta: 90 }};
      arHeadingSmoothed = 340;
      for (const f of {json.dumps(fixes)}) arOnGpsFix(f);
      ({{ offset: arHeadingOffset, lng: arUserLng }})
    """)
    assert out["offset"] == pytest.approx(-20, abs=1)
    # 表示に使う位置は経路の線の上（4m東ではなく）に寄っている
    assert out["lng"] == pytest.approx(LNG0, abs=1e-7)


def test_端末を立てて持っていないときはコンパスのずれを学ばない():
    path = [node(0, 0), node(100, 0)]
    fixes = []
    for i in range(0, 20):
        lat, lng = offset(i * 1.5, 0)
        fixes.append({"coords": {"latitude": lat, "longitude": lng, "accuracy": 5}, "timestamp": i * 1000})
    out = run_js(f"""
      pathCoords = {json.dumps(path)};
      currentStep = 0;
      arRunning = true;
      arGOrient = {{ beta: 10 }};   // 机に置くように寝かせている
      arHeadingSmoothed = 340;
      for (const f of {json.dumps(fixes)}) arOnGpsFix(f);
      arHeadingOffset
    """)
    assert out == 0


# ---------------------------------------------------------------- GPS が取れなくなったときの案内

def test_GPSが取れない時間が続いたら案内を出す():
    # ARを出してから使える位置が一度も来ないまま15秒を過ぎたら出す
    assert run_js("arGpsLost(14000, 0, 0, false)") is False
    assert run_js("arGpsLost(16000, 0, 0, false)") is True
    # 使える位置が届いていれば、そこから15秒は出さない
    assert run_js("arGpsLost(30000, 0, 20000, false)") is False
    assert run_js("arGpsLost(36000, 0, 20000, false)") is True


def test_ARを出し直したらしばらくは案内を出さない():
    # 屋内から屋外に戻ったときなど、前の位置が古くても、出し直してから15秒は待つ
    assert run_js("arGpsLost(100000, 95000, 1000, false)") is False


def test_位置情報が許可されていなければすぐ案内を出す():
    assert run_js("arGpsLost(1000, 0, 1000, true)") is True


# ---------------------------------------------------------------- 今歩いている区間の色

def test_今のステップの区間だけ黄緑で_通過済みはグレー_これからは青():
    out = run_js("""
        var CURRENT_EDGE_COLOR = "#84CC16";
        var arUpdateVisibility = () => {};
        const mat = () => ({ hex: null, opacity: null, color: { setHex(h) { this.owner.hex = h; } } });
        _arMeshes = [0, 1, 2].map(idx => { const m = mat(); m.color.owner = m; return { mat: m, type: "edge", idx }; });
        arUpdateRouteColors(1);
        _arMeshes.map(m => m.mat.hex)
    """)
    assert out == [0x9E9E9E, 0x84CC16, 0x3B82F6]


def test_ボタンで動かしたあと自動送りを止めるのは5秒():
    assert run_js("AR_MANUAL_PAUSE_MS") == 5000


# ---------------------------------------------------------------- 画角をカメラ映像に合わせる

def test_画面に映っている映像の範囲に画角を合わせる():
    import math
    # 縦長の映像（1080x1920）を、ほぼ正方形の場所（390x400）に切って出すと、縦は映像の一部しか映らない
    fov = run_js("arVerticalFov(1080, 1920, 390, 400)")
    half_visible = 400 / 2 / (390 / 1080)               # 映っている縦の半分（映像の px）
    expected = 2 * math.degrees(math.atan(half_visible * 0.66 / 960))
    assert fov == pytest.approx(expected)
    assert 38 < fov < 46                                 # 以前の固定値 65度よりずっと狭い
    # 映像の大きさがまだ分からないときも、縦長の映像とみなして求める
    assert 30 < run_js("arVerticalFov(0, 0, 390, 400)") < 60


# ---------------------------------------------------------------- ジャイロとコンパスの組み合わせ

def test_カメラが向いている方位を求める():
    # スマホを立てて（beta=90）持ち、alpha=0 なら北、alpha=270 なら東（alpha は反時計回り）
    out = run_js("[arCamHeading({alpha: 0, beta: 90, gamma: 0}), arCamHeading({alpha: 270, beta: 90, gamma: 0}),"
                 " arCamHeading({alpha: 90, beta: 0, gamma: 0})]")
    assert out[0] == pytest.approx(0, abs=1e-6)
    assert out[1] == pytest.approx(90, abs=1e-6)
    assert out[2] == pytest.approx(270, abs=1e-6)        # 寝かせているときは端末の上の辺の向き（西）


def test_ジャイロの向きをコンパスにゆっくり合わせ_狂った値は使わない():
    out = run_js("""
      arRelOrient = { alpha: 0, beta: 90, gamma: 0 };          // ジャイロでは北
      const compass = (h) => arFeedCompass({ alpha: 360 - h, beta: 90, gamma: 0 });
      for (let i = 0; i < 5; i++) compass(20);                 // コンパスでは 20度 → 差は 20度で始まる
      const start = arYawOffset;
      compass(80);                                             // 1回だけ大きく狂った値（鉄骨のそばなど）
      const afterOutlier = arYawOffset;
      for (let i = 0; i < 50; i++) compass(30);                // コンパスが少しずつ 30度を指す
      const after = arYawOffset;
      const fused = arFusedOrientation();
      [start, afterOutlier, after, arCamHeading(fused)]
    """)
    assert out[0] == pytest.approx(20)
    assert out[1] == pytest.approx(20)                   # 狂った値は無視
    assert 20 < out[2] < 30                              # 一気には動かず、少しずつ寄る
    # 描画に使う向き ＝ ジャイロ + 差 − 偏角（真北基準）
    assert out[3] == pytest.approx(out[2] - 7.6, abs=1e-6)


def test_コンパスとの差が大きいまま続いたら合わせ直す():
    out = run_js("""
      arRelOrient = { alpha: 0, beta: 90, gamma: 0 };
      const compass = (h) => arFeedCompass({ alpha: 360 - h, beta: 90, gamma: 0 });
      for (let i = 0; i < 5; i++) compass(20);
      for (let i = 0; i < AR_COMPASS_MAX_OUTLIERS; i++) compass(90);
      arYawOffset
    """)
    assert out == pytest.approx(90)


def test_画面を右になぞると目印が右に動くように向きを変える():
    out = run_js("arVFov = 45; arOnSwipe(100, 400); arHeadingOffset")
    assert out < 0                                       # カメラを左に回したのと同じ（方位が減る）


# ---------------------------------------------------------------- 高精度モードの地図との位置合わせ

def test_歩いた軌跡とGPSの軌跡を重ねて回転とずれを求める():
    import math
    psi, tx, tz = 35, 4, -7
    pairs = []
    for i in range(15):
        ax, az = i * 3.0, (1.5 if i % 2 else -1.5)      # GPS は道（東向き）から ±1.5m 揺れる
        c, s = math.cos(math.radians(psi)), math.sin(math.radians(psi))
        bx, bz = i * 3.0 * c + tx, i * 3.0 * s + tz       # XR は揺れない
        pairs.append({"ax": ax, "az": az, "bx": bx, "bz": bz, "w": 1})
    out = run_js(f"arFitAlignment({json.dumps(pairs)})")
    assert out["fitted"] == pytest.approx(psi, abs=1)
    assert out["spread"] > 20
    # 回転を決めて渡したときは、ずれ（平行移動）だけ求める
    fixed = run_js(f"arFitAlignment({json.dumps(pairs)}, {psi})")
    assert fixed["psi"] == psi
    assert fixed["tx"] == pytest.approx(tx, abs=1) and fixed["tz"] == pytest.approx(tz, abs=1)


def test_組が無ければ位置合わせしない():
    assert run_js("arFitAlignment([])") is None


# ---------------------------------------------------------------- 距離の札

def test_残りの距離は近ければ1m単位_遠ければ5m単位():
    assert run_js("[arDistanceText(0.3), arDistanceText(7.6), arDistanceText(33)]") == ["あと 1m", "あと 8m", "あと 35m"]
