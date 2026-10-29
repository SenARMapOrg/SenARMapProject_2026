// 相談窓口の公開API（routes/support.ts）で使う、入力の確かめ方と上限。
// 利用者はログインしないので、相談ごとに発行したトークン（64桁の16進数）だけで本人の相談かを見分ける。

/** 1通のメッセージの最大文字数（programs/html/navi/script/help.js と同じ値） */
export const MAX_SUPPORT_MESSAGE_CHARS = 500;
/** つなぐ前の AI とのやりとり（オペレーターが読む）の最大文字数 */
export const MAX_SUPPORT_CONTEXT_CHARS = 4000;
/** 1つの相談で利用者が送れるメッセージの数 */
export const MAX_USER_MESSAGES_PER_CONVERSATION = 40;
/** 同時に続けられる相談の数。これを超えたら新しい相談は受け付けない */
export const MAX_ACTIVE_CONVERSATIONS = 50;
/** 公開APIが受け付ける本文の最大バイト数（日本語は1文字3バイト） */
export const MAX_SUPPORT_BODY_BYTES = 16 * 1024;

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isValidSupportToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

/** 送られてきたメッセージを整える。空・長すぎる・文字列でなければ null */
export function normalizeSupportMessage(value: unknown, maxChars = MAX_SUPPORT_MESSAGE_CHARS): string | null {
  if (typeof value !== "string") return null;
  // 制御文字（改行・タブ以外）は取り除く
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text || text.length > maxChars) return null;
  return text;
}

/** 0 以上の整数として読めればその値、読めなければ 0（「最初から」の意味） */
export function readAfterId(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
