// ================================================================
// voice.js
// 音声案内（読み上げのON/OFFと、各ステップの読み上げ文の組み立て）。
// ================================================================

// ================================================================
// 音声案内
//
// Web Speech API (SpeechSynthesis) をそのまま使う。バックエンドの変更は不要。
// 読み上げ文は「グライスの協調の原理」の4公理に沿うよう、以下の方針で組み立てる：
//   量:   そのステップで実際に必要な情報（曲がる方向・距離・エレベータ等の行き先階）だけを言う。
//         距離がANNOUNCE_DISTANCE_THRESHOLD_M未満など無意味なほど短い直進は何も言わない（言っても情報にならない）。
//   質:   実際のデータ（計算済みの距離・曲がる方向・ノードのfloor）にない内容は言わない。
//         教室名も、値がある場合のみ言う（無ければ言わない。それらしい名前を作らない）。
//   関係: 今のステップの行動に関係ない情報は省く。入口（type 7・距離0）の連結エッジは無音。
//         エレベータ/階段/エスカレータが複数の区間に分かれていても、同じ移動の途中は繰り返さない。
//   様態: 曖昧さを避け（「右」「左」を明言）、簡潔で、毎回同じ語順（方向→距離）で話す。
// ================================================================
let voiceGuideEnabled = localStorage.getItem("navi_voice_guide") === "1";

const VERTICAL_LABELS = { "2": "階段", "3": "エスカレーター", "4": "エレベーター", "5": "エスカレーター", "6": "エスカレーター" };
const ANNOUNCE_DISTANCE_THRESHOLD_M = 10; // これ未満の直進距離は案内しない（曲がる場合は距離を省いて方向だけ言う）

function updateVoiceToggleUI() {
  const btn = document.getElementById("voice-toggle-btn");
  if (!btn) return;
  btn.textContent = voiceGuideEnabled ? "\u{1F50A}" : "\u{1F507}"; // 🔊 / 🔇
  btn.classList.toggle("active", voiceGuideEnabled);
  btn.setAttribute("aria-pressed", String(voiceGuideEnabled));
}
updateVoiceToggleUI();

function toggleVoiceGuide() {
  voiceGuideEnabled = !voiceGuideEnabled;
  localStorage.setItem("navi_voice_guide", voiceGuideEnabled ? "1" : "0");
  updateVoiceToggleUI();
  if (!voiceGuideEnabled && "speechSynthesis" in window) window.speechSynthesis.cancel();
}

function speak(text) {
  if (!voiceGuideEnabled || !text) return;
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel(); // 前の発話が残っていたら打ち切ってから話す（読み上げの重複防止）
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "ja-JP";
  window.speechSynthesis.speak(u);
}

/**
 * edge.right_display / edge.left_display（進行方向に対して右手・左手にある教室の読み上げ用表示名。
 * サーバー側で name.csv・トイレ種別に応じて解決済み、生のroom codeではない）から
 * 「右手に101教室、左手に102教室があります」のような一言を組み立てる。
 * どちらも無ければ空文字（呼び出し側は従来通りの案内文にフォールバックする）。
 */
function buildSidePhrase(edge) {
  // *_display はサーバー側でname.csv・トイレ表記に解決済みの表示名（"M_Toilet"ではなく"男子トイレ"等）。
  // 未提供の古いレスポンス形式向けに、生のright/leftの先頭要素へフォールバックする。
  const r = edge.right_display || (edge.right || "").split(";")[0].trim();
  const l = edge.left_display  || (edge.left  || "").split(";")[0].trim();
  if (r && l) return `右手に${r}、左手に${l}があります`;
  if (r) return `右手に${r}があります`;
  if (l) return `左手に${l}があります`;
  return "";
}

/**
 * 目的地バッジ・到着時の音声案内で共通して使う文言を決める。
 * まずAPIが返す destSide（サーバー側で、検索時に指定した実際の目的地名を最終区間の
 * right/left列と厳密照合して判定済み）を見る。"right"/"left" が取れていれば、
 * destDisplay（目的地自体の表示名）・destPosition/destCount（right/leftは手前から奥への
 * 物理的な並び順を持つ列なので、そのままそこでの目的地の順位が「手前から数えてN番目」になる）・
 * destNearestDisplay（一番手前の教室の表示名）を使って具体的な文を組み立てる。
 * ただし、目的地がその側で一番手前（＝destPosition===1）の場合や、その側に他に教室が無い
 * （destCount<=1）場合は「〜から数えて1番目です」という自明な言い回しを避け、単に
 * 「<目的地>は右手です」のように言う。
 * destSideが無い（"" ＝ ノード指定・イベント指定など目的教室名が無い、または
 * このエッジのright/leftどちらにも一致しなかった）場合のみ、最終区間のright_display/
 * left_displayを見て「片方だけ設定されていればその側とみなす」簡易フォールバックを使う
 * （このエッジに複数の部屋が面していてどちらが目的地か特定できない場合は汎用文言のまま）。
 */
function buildNearGoalText(edge) {
  const FALLBACK = "この通路沿いが目的地周辺です";
  if (destSide === "right" || destSide === "left") {
    const sideText = destSide === "right" ? "右手" : "左手";
    const name = destDisplay || "目的地";
    if (destCount > 1 && destPosition > 1) {
      return `${name}は${sideText}、${destNearestDisplay}から数えて${destPosition}番目です`;
    }
    return `${name}は${sideText}です`;
  }
  if (!edge) return FALLBACK;
  const r = edge.right_display || (edge.right || "").split(";")[0].trim();
  const l = edge.left_display  || (edge.left  || "").split(";")[0].trim();
  if (r && !l) return "右手に目的地です";
  if (l && !r) return "左手に目的地です";
  return FALLBACK;
}

/**
 * pathCoords[step] → pathCoords[step+1] の区間（pathEdges[step]）についての案内文を組み立てる。
 * 階段/エレベータ/エスカレータは複数の区間にまたがることがあるため、同種の区間が連続する
 * 最初のステップでのみ「○階まで」を案内し、続きのステップでは何も言わない。
 */
function buildStepAnnouncement(step) {
  const edge = pathEdges[step];
  if (!edge) return "";
  const type = String(edge.type ?? "1");
  if (type === "7") return ""; // 屋内外の連結エッジ（距離0）は案内する内容が無い

  if (VERTICAL_LABELS[type]) {
    const prevType = step > 0 ? String(pathEdges[step - 1]?.type ?? "") : null;
    if (prevType === type) return ""; // 同じ階段/EV/ESCの続き番目のステップ：繰り返さない

    let end = step;
    while (end + 1 < pathEdges.length && String(pathEdges[end + 1]?.type ?? "") === type) end += 1;
    const fromFloor = pathCoords[step]?.floor;
    const toFloor   = pathCoords[end + 1]?.floor;
    const label = VERTICAL_LABELS[type];
    if (fromFloor == null || toFloor == null || fromFloor === toFloor) return `${label}で移動します`;
    return toFloor > fromFloor
      ? `${label}で${toFloor}階まで上がってください`
      : `${label}で${toFloor}階まで下りてください`;
  }

  // 最終区間（目的地エッジ上を歩く「この辺です」区間）
  if (step === pathCoords.length - 2) {
    // dest_sideが判定できている場合は「<目的地>は右手、<手前>から数えてN番目です」を読み上げる。
    // 判定できない場合は従来通り「<name>の付近です」にフォールバックする。
    if (destSide === "right" || destSide === "left") {
      return `まもなく到着します。${buildNearGoalText(edge)}`;
    }
    const name = edge.name_display || (edge.name || "").split(";")[0].trim();
    return name ? `まもなく到着します。${name}の付近です` : "まもなく目的地に到着します";
  }

  const dir  = calcTurnDirection(step);
  const dist = Math.round(edge.length || 0);
  const side = buildSidePhrase(edge); // right/leftが無ければ""（従来の運用のまま）

  if (dir === "right" || dir === "left") {
    const dirText = dir === "right" ? "右に曲がって" : "左に曲がって";
    const base = dist >= ANNOUNCE_DISTANCE_THRESHOLD_M ? `${dirText}${dist}メートル先です` : `${dirText}ください`;
    return side ? `${base}。${side}` : base;
  }
  if (dist >= ANNOUNCE_DISTANCE_THRESHOLD_M) {
    return side ? `${dist}メートル直進です。${side}` : `${dist}メートル直進です`;
  }
  // 距離が短い直進は従来省略していたが、右左に目印があるなら短くてもそれだけ案内する
  return side;
}
