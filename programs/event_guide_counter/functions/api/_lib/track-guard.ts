// 公開の記録API（routes/track.ts）に来たリクエストを、記録してよいものか確かめる。
//
// 記録APIはログイン不要で、案内係コード（QRに印刷されていて誰でも読める）さえ分かれば送れてしまう。
// ここでのチェックで「ブラウザ以外から好きなように送る」こと自体は防げない（Origin ヘッダも
// 自作のプログラムなら偽れる）が、次のような手軽な水増し・嫌がらせは止められる:
//   - 別のWebサイトに仕込んだスクリプトで、そのサイトの閲覧者のブラウザから大量に送らせる（Origin で弾く）
//   - 巨大な本文を送りつけて処理やDBを圧迫する（大きさの上限で弾く）
//   - 端末IDに任意の文字列を入れる（形式で弾く）
// 大量に送られた場合の本格的な対策は、Cloudflare のレート制限ルール（README「セキュリティ」参照）で行う。

/** 記録APIが受け付ける本文の最大バイト数。正規の本文は数百バイト（出発地・目的地は各200文字まで） */
export const MAX_TRACK_BODY_BYTES = 4096;

/** "https://a.jp, https://b.jp ," → {"https://a.jp", "https://b.jp"} */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const origin = part.trim().replace(/\/+$/, "");
    if (origin) set.add(origin);
  }
  return set;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * 記録を送ってきたページのオリジンが許可されているか。
 * ブラウザは POST（sendBeacon を含む）に必ず Origin を付けるので、無いものは受け付けない。
 * ローカル開発（この集計システム自体を localhost で動かしているとき）だけは、localhost のページからも受け付ける。
 */
export function isAllowedTrackOrigin(
  origin: string | null | undefined, requestUrl: string, allowedRaw: string | undefined,
): boolean {
  if (!origin) return false;
  if (parseAllowedOrigins(allowedRaw).has(origin)) return true;
  return isLocalhostUrl(requestUrl) && isLocalhostUrl(origin);
}

/** 端末IDの形式（track.js が作る UUID か、32桁の16進数） */
const DEVICE_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

export function isValidDeviceId(value: string): boolean {
  return DEVICE_ID_PATTERN.test(value);
}

/** 案内係コードの形式（db/guides.ts の generateRefCode が作る8文字） */
const REF_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

export function isValidRefCode(value: string): boolean {
  return REF_CODE_PATTERN.test(value);
}
