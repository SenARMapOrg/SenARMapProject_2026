// Cookie の名前（本番の https では __Host- を付ける）
import { describe, expect, it } from "vitest";

import { cookieName, isHttpsUrl, SESSION } from "../functions/api/_lib/cookie-names";
import { hashSessionToken } from "../functions/api/_lib/db/token";

describe("cookieName", () => {
  it("https では __Host- を付ける", () => {
    expect(cookieName(SESSION, true)).toBe("__Host-session");
  });

  it("ローカルの http では付けない（Secure な Cookie を保存できないため）", () => {
    expect(cookieName(SESSION, false)).toBe("session");
  });

  it("URL から https かどうかを判定する", () => {
    expect(isHttpsUrl("https://timetables.iku-navi.net/api/me")).toBe(true);
    expect(isHttpsUrl("http://127.0.0.1:8788/api/me")).toBe(false);
  });
});

describe("hashSessionToken", () => {
  it("同じトークンからは同じハッシュ、違うトークンからは違うハッシュ", async () => {
    expect(await hashSessionToken("abc")).toBe(await hashSessionToken("abc"));
    expect(await hashSessionToken("abc")).not.toBe(await hashSessionToken("abd"));
  });

  it("SHA-256 の既知の値と一致する", async () => {
    expect(await hashSessionToken("abc"))
      .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
