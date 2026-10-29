// 管理画面の表示用の整形処理
import { describe, expect, it } from "vitest";

import {
  auditEventLabel, buildGuideUrl, formatDbTime, formatWaiting, waitingLevel, waitingMinutes,
} from "../src/admin-format";

describe("formatDbTime", () => {
  it("UTC の時刻を日本時間で表示する", () => {
    expect(formatDbTime("2026-09-25 03:00:00")).toBe("2026/09/25 12:00");
  });

  it("値が無ければダッシュ", () => {
    expect(formatDbTime(null)).toBe("—");
  });
});

describe("auditEventLabel", () => {
  it("記録の種類を日本語で表示する", () => {
    expect(auditEventLabel("admin_access")).toBe("閲覧");
    expect(auditEventLabel("admin_denied")).toBe("拒否");
  });

  it("想定外の値はそのまま出す", () => {
    expect(auditEventLabel("something_new")).toBe("something_new");
  });
});

describe("buildGuideUrl", () => {
  it("IKU NAVIを直接指すURLを組み立てる（Railsの/redirectは経由しない）", () => {
    expect(buildGuideUrl("https://iku-navi.net", "ABCD1234")).toBe("https://iku-navi.net/navi/?event=1&ref=ABCD1234");
  });

  it("ベースURLの末尾のスラッシュは取り除く", () => {
    expect(buildGuideUrl("https://iku-navi.net/", "ABCD1234")).toBe("https://iku-navi.net/navi/?event=1&ref=ABCD1234");
  });

  it("ref_codeはURLエンコードする", () => {
    expect(buildGuideUrl("https://iku-navi.net", "A B")).toBe("https://iku-navi.net/navi/?event=1&ref=A%20B");
  });
});

describe("返事の待ち時間", () => {
  it("D1 の時刻とサーバーの今の時刻（ISO）の差を、分で切り捨てて出す", () => {
    expect(waitingMinutes("2026-10-29 03:00:00", "2026-10-29T03:05:59.000Z")).toBe(5);
    expect(waitingMinutes("2026-10-29 03:00:00", "2026-10-29T03:00:30.000Z")).toBe(0);
  });

  it("待っていない・読めない時刻なら null、時計が逆転していたら 0", () => {
    expect(waitingMinutes(null, "2026-10-29T03:00:00Z")).toBeNull();
    expect(waitingMinutes("not a date", "2026-10-29T03:00:00Z")).toBeNull();
    expect(waitingMinutes("2026-10-29 03:01:00", "2026-10-29T03:00:00Z")).toBe(0);
  });

  it("表示と色分け", () => {
    expect(formatWaiting(0)).toBe("1分未満");
    expect(formatWaiting(5)).toBe("5分");
    expect(formatWaiting(60)).toBe("1時間");
    expect(formatWaiting(80)).toBe("1時間20分");
    expect([2, 3, 9, 10].map(waitingLevel)).toEqual(["ok", "warn", "warn", "alert"]);
  });
});
