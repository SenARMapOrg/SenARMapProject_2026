"""屋外の経路で、カメラ・位置情報・向きの許可をお願いする流れ（navi/script/ar.js の arAskPermissions）。

ブラウザの許可ダイアログ（向き・カメラ・位置情報）は、自前の画面の「OK」を押してから出す。
屋内だけの経路では何も聞かない。ar.js を Node の vm で読み込み、ブラウザの API の代わりを置いて
「いつ・何を呼んだか」を記録して確かめる。Node が無い環境ではスキップする。
"""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

AR_JS = Path(__file__).resolve().parents[1] / "navi" / "script" / "ar.js"

# calls に、ブラウザの許可ダイアログを出す API が呼ばれた順に名前を残す。
# ios=true のときは iOS と同じく DeviceOrientationEvent.requestPermission がある。
# granted は Permissions API が返す状態（カメラ・位置情報とも同じ値にする）。
# camera_answers=false のときは、カメラの許可ダイアログに答えないまま（getUserMedia が終わらない）にする。
RUNNER = r"""
const vm = require("vm");
const fs = require("fs");
const opts = JSON.parse(process.argv[3]);
const calls = [];
const modal = { hidden: true };
const ctx = {
  console, Date, Math, Promise, setTimeout, calls, modal,
  setInterval: () => 1, clearInterval: () => {},
  document: { getElementById: (id) => (id === "ar-permission-modal" ? modal : null), head: { appendChild() {} } },
  window: { addEventListener: (name) => calls.push("listen:" + name) },
  navigator: {
    permissions: { query: ({ name }) => Promise.resolve({ state: opts.granted }) },
    geolocation: { watchPosition: () => { calls.push("geolocation"); return 1; }, clearWatch() {} },
    mediaDevices: { getUserMedia: () => {
      calls.push("camera");
      return opts.cameraAnswers ? Promise.resolve({ getTracks: () => [] }) : new Promise(() => {});
    } },
  },
};
if (opts.ios) {
  ctx.DeviceOrientationEvent = { requestPermission: () => { calls.push("orientation"); return Promise.resolve("granted"); } };
}
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.argv[1], "utf8"), ctx);
vm.runInContext(`
  var pathCoords = [];
  var currentStep = 0;
  var shownSteps = [];
  function updateRouteImage(step) { shownSteps.push(step); }
`, ctx);
Promise.resolve(vm.runInContext(process.argv[2], ctx)).then(out => process.stdout.write(JSON.stringify(out)));
"""

INDOOR = '[{"building":10,"lat":null},{"building":10,"lat":null},{"building":10,"lat":null}]'
OUTDOOR = '[{"building":10,"lat":null},{"building":0,"lat":35.61},{"building":0,"lat":35.62},{"building":1,"lat":null}]'


def run_js(script: str, ios=False, granted="prompt", camera_answers=True):
    """ar.js を読み込んだ環境で async 関数の本体を実行し、返した値を JSON で受け取る"""
    node = shutil.which("node")
    if not node:
        pytest.skip("Node が無い環境では実行しない")
    expr = f"(async () => {{ {script} }})()"
    result = subprocess.run(
        [node, "-e", RUNNER, str(AR_JS), expr, json.dumps({"ios": ios, "granted": granted, "cameraAnswers": camera_answers})],
        capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


STATE = "({ state: arPermissionState, modalHidden: modal.hidden, calls, shownSteps })"
TICK = "await new Promise(r => setTimeout(r, 0));"
PERMISSION_CALLS = ("orientation", "camera", "geolocation")


def test_屋内だけの経路では何も聞かない():
    out = run_js(f"pathCoords = {INDOOR}; arPrefetchCameraIfNeeded(); await null; return {STATE};", ios=True)
    assert out["state"] == "none"
    assert out["modalHidden"] is True
    assert out["calls"] == []


def test_屋外を通る経路では先にお願いの画面を出しブラウザの確認はまだ出さない():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        return {STATE};
    """, ios=True)
    assert out["state"] == "asking"
    assert out["modalHidden"] is False
    assert out["calls"] == []


def test_お願いの画面を出している間はARを出してもカメラとGPSに触らない():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        await arShowView();
        return {STATE};
    """, ios=True)
    assert out["calls"] == []


def test_OKを押すと向きをすぐ求める():
    # iOS の向きの許可はボタンを押した処理の中で同期的に呼ぶ必要がある
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        {TICK}
        arAcceptPermissions();
        const callsRightAfterOk = [...calls];
        return {{ callsRightAfterOk }};
    """, ios=True)
    assert out["callsRightAfterOk"] == ["orientation"]


def test_OKを押すと向き_カメラ_位置情報の順に1つずつ求める():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        currentStep = 1;
        arPrefetchCameraIfNeeded();
        {TICK}
        arAcceptPermissions();
        {TICK}
        return {STATE};
    """, ios=True)
    assert out["state"] == "done"
    assert out["modalHidden"] is True
    assert [c for c in out["calls"] if c in PERMISSION_CALLS] == ["orientation", "camera", "geolocation"]
    # 聞いている間に止めていた今のステップのARを出し直す
    assert out["shownSteps"] == [1]


def test_カメラの許可に答えるまで位置情報は求めない():
    # iOS の Safari は許可ダイアログを一度に1つしか出せず、重ねると位置情報のダイアログが出なかった
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        {TICK}
        arAcceptPermissions();
        {TICK}
        await arShowView();
        return {STATE};
    """, ios=True, camera_answers=False)
    assert out["state"] == "requesting"
    assert [c for c in out["calls"] if c in PERMISSION_CALLS] == ["orientation", "camera"]


def test_一度OKを押したら次の経路では聞き直さない():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        arAcceptPermissions();
        modal.hidden = true;
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        return {STATE};
    """, ios=True)
    assert out["modalHidden"] is True
    assert out["calls"].count("orientation") == 1


def test_すでに許可済みで向きの許可が要らない端末では画面を出さない():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        return {STATE};
    """, ios=False, granted="granted")
    assert out["state"] == "done"
    assert out["modalHidden"] is True
    assert "camera" in out["calls"] and "geolocation" in out["calls"]


def test_iOSでは許可済みでも向きのためにOKを押してもらう():
    out = run_js(f"""
        pathCoords = {OUTDOOR};
        arPrefetchCameraIfNeeded();
        await new Promise(r => setTimeout(r, 0));
        return {STATE};
    """, ios=True, granted="granted")
    assert out["modalHidden"] is False
    assert out["calls"] == []
