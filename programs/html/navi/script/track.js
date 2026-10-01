// ================================================================
// track.js
// 鳳祭（イベントモード）の案内人数の記録。案内係ごとのQR（?event=1&ref=<案内係コード>）から
// 開かれたときだけ、集計システム（programs/event_guide_counter）へ記録を送る。
//
// なぜページ内のJSから送るのか: 以前はサーバー側で「リダイレクトのリクエストが来た回数」を
// 数えていたため、QRリーダー・LINEなどのリンクプレビューやブラウザの先読みでも数えられ、
// 1人を2回数えてしまうことがあった。ページが実際に表示されてから送れば、人が開いた分だけ数えられる。
// （docs/event_guide_counter_plan.md 参照）
//
// 送るのは「案内係コード(ref)・端末ID・検索した出発地と目的地」だけで、名前などの個人情報は含まない。
// 端末IDは初回に作るランダムな値で、個人情報とは結びつけない。
// ================================================================

// 集計システム（programs/event_guide_counter）のオリジン。navi とは別サイトなので常に絶対URL。
// ローカル開発では `npm run dev`（wrangler pages dev）の既定ポートを指す。
// ★実運用ドメインが決まったら書き換える
const TRACK_API_BASE = ["localhost", "127.0.0.1"].includes(location.hostname)
  ? "http://localhost:8788" : "https://event-guide-counter.iku-navi.net";

const TRACK_DEVICE_ID_KEY = "navi_device_id";   // localStorage: 端末ごとのランダムID（重複を除くため）
const TRACK_REF_KEY       = "navi_event_ref";   // sessionStorage: 同じタブでの検索にも ref を引き継ぐため

// randomUUID は安全なコンテキスト（https・localhost）でしか使えないため、無い場合は乱数から組む
function trackRandomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// 端末ID。初回にランダムに作って localStorage に保存する。
// localStorage が使えない環境（プライベートモード等）では毎回新しい値になるが、記録自体は送れる。
function trackDeviceId() {
  try {
    let id = localStorage.getItem(TRACK_DEVICE_ID_KEY);
    if (!id) {
      id = trackRandomId();
      localStorage.setItem(TRACK_DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return trackRandomId();
  }
}

// 案内係コード。URLに ?ref= があればそれを使い、同じタブでの検索にも使えるよう sessionStorage に残す。
// QRから開いたあとに画面内で検索した場合はURLから消えていることがあるため。
function trackRef() {
  const fromUrl = new URLSearchParams(location.search).get("ref");
  try {
    if (fromUrl) {
      sessionStorage.setItem(TRACK_REF_KEY, fromUrl);
      return fromUrl;
    }
    return sessionStorage.getItem(TRACK_REF_KEY);
  } catch {
    return fromUrl;
  }
}

// sendBeacon は「ページを離れても送信を続ける」仕組みで、レスポンスは読めない。
// Content-Type は text/plain にする（application/json だとCORSの事前確認が必要になり、
// 事前確認に応答しない集計APIでは送れないため）。
function trackSend(path, payload) {
  const ref = trackRef();
  if (!ref) return;  // 案内係のQR以外から開いた場合は何も送らない
  if (!navigator.sendBeacon) return;
  const body = new Blob([JSON.stringify({ ref, deviceId: trackDeviceId(), ...payload })], { type: "text/plain" });
  navigator.sendBeacon(`${TRACK_API_BASE}${path}`, body);
}

// 到着（ページを表示したとき）。ブラウザの先読み中（document.prerendering）は、まだ人が
// 見ていないので送らず、実際に表示された時点（prerenderingchange）で送る。
function trackArrival() {
  if (document.prerendering) {
    document.addEventListener("prerenderingchange", () => trackSend("/api/track/arrival", {}), { once: true });
    return;
  }
  trackSend("/api/track/arrival", {});
}

// ルート検索が成功したとき。出発地・目的地の表示名を付ける（教室名・イベント名）。
function trackSearch(fromLabel, toLabel) {
  trackSend("/api/track/search", { fromLabel: fromLabel || "", toLabel: toLabel || "" });
}

trackArrival();
