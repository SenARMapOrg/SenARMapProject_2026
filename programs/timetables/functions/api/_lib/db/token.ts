// 共有リンクやセッションIDに使うランダムトークンと、セッショントークンのハッシュ。

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * セッショントークンを DB に保存する形（SHA-256 の16進文字列）にする。
 *
 * Cookie には生のトークンを入れ、DB（sessions.id）にはこのハッシュだけを保存する。
 * DB を読める人（D1 コンソール・プレビュー環境・バックアップ）がいても、
 * そこから Cookie に入れる値を作れないようにするため。
 * トークンは 256bit の乱数なので、パスワードのような遅いハッシュやソルトは要らない。
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
