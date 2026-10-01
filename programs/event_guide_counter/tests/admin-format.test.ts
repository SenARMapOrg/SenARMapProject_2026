// 管理画面の表示用の整形処理
import { describe, expect, it } from "vitest";

import { auditEventLabel, buildGuideUrl, formatDbTime } from "../src/admin-format";

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
