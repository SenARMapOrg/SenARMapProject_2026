// シラバスデータの「開講」単位へのまとめ方。
// 前期にも後期にも開講されている科目が通年に統合されると、時間割に追加したときに
// 前期・後期の両方へ入ってしまう（過去に起きた不具合）ので、ここで固定しておく。
import { describe, expect, it } from "vitest";

import {
  filterOfferingsByTerm, groupOfferings, searchOfferings, type CourseCatalogEntry,
} from "../src/course-catalog";

function entry(over: Partial<CourseCatalogEntry> = {}): CourseCatalogEntry {
  return {
    course_name: "経済学",
    day_of_week: 0,
    period: 1,
    term: "spring",
    room: null,
    instructor: "先生A",
    departments: [{ faculty: "経済学部", department: "経済学科" }],
    ...over,
  };
}

describe("groupOfferings", () => {
  it("前期と後期に同じ枠で開講されている科目は2つの開講のままにする", () => {
    const got = groupOfferings([
      entry({ course_name: "バレーボール", term: "spring" }),
      entry({ course_name: "バレーボール", term: "fall" }),
    ]);
    expect(got).toHaveLength(2);
    expect(got.map((o) => o.term).sort()).toEqual(["fall", "spring"]);
  });

  it("通年科目は1つの開講として通年のまま扱う", () => {
    const got = groupOfferings([entry({ course_name: "卒業研究", term: "both" })]);
    expect(got).toHaveLength(1);
    expect(got[0].term).toBe("both");
  });

  it("曜日・時限が違えば同じ科目名でも別の開講にする", () => {
    const got = groupOfferings([
      entry({ day_of_week: 0, period: 3 }),
      entry({ day_of_week: 1, period: 2 }),
    ]);
    expect(got).toHaveLength(2);
  });

  it("担当教員が違えば別の開講にする", () => {
    const got = groupOfferings([entry({ instructor: "先生A" }), entry({ instructor: "先生B" })]);
    expect(got).toHaveLength(2);
  });

  it("学科違いで重複している同一の開講は1つにまとめる", () => {
    const got = groupOfferings([
      entry({ departments: [{ faculty: "経済学部", department: "経済学科" }] }),
      entry({ departments: [{ faculty: "文学部", department: "哲学科" }] }),
    ]);
    expect(got).toHaveLength(1);
  });

  it("開講には曜日・時限がそのまま入る", () => {
    const [o] = groupOfferings([entry({ day_of_week: 2, period: 4 })]);
    expect(o.slots).toEqual([{ day_of_week: 2, period: 4 }]);
  });
});

describe("searchOfferings", () => {
  const offerings = groupOfferings([
    entry({ course_name: "経済学", term: "spring" }),
    entry({ course_name: "経済史", term: "fall", period: 2 }),
    entry({
      course_name: "心理学", period: 3,
      departments: [{ faculty: "人間科学部", department: "心理学科" }],
    }),
  ]);

  it("科目名の部分一致で絞り込む", () => {
    expect(searchOfferings(offerings, "経済", "", "").map((o) => o.course_name).sort())
      .toEqual(["経済史", "経済学"]);
  });

  it("学期では絞り込まない（学期は filterOfferingsByTerm で別に絞る）", () => {
    expect(searchOfferings(offerings, "経済", "", "")).toHaveLength(2);
  });

  it("学部で絞り込む", () => {
    expect(searchOfferings(offerings, "", "人間科学部", "").map((o) => o.course_name))
      .toEqual(["心理学"]);
  });

  it("学科で絞り込む", () => {
    expect(searchOfferings(offerings, "", "", "経済学科")).toHaveLength(2);
  });

  it("条件が空なら全件返す", () => {
    expect(searchOfferings(offerings, "", "", "")).toHaveLength(3);
  });
});

describe("filterOfferingsByTerm（開いている学期タブで絞る）", () => {
  const offerings = groupOfferings([
    entry({ course_name: "前期だけの科目", term: "spring" }),
    entry({ course_name: "後期だけの科目", term: "fall" }),
    entry({ course_name: "通年の科目", term: "both" }),
    entry({ course_name: "前期にも後期にもある科目", term: "spring", period: 2 }),
    entry({ course_name: "前期にも後期にもある科目", term: "fall", period: 2 }),
  ]);
  const names = (term: "spring" | "fall") => filterOfferingsByTerm(offerings, term)
    .map((o) => `${o.course_name}(${o.term})`).sort();

  it("前期タブでは前期と通年だけ", () => {
    expect(names("spring")).toEqual([
      "前期だけの科目(spring)", "前期にも後期にもある科目(spring)", "通年の科目(both)",
    ]);
  });

  it("後期タブでは後期と通年だけ", () => {
    expect(names("fall")).toEqual([
      "前期にも後期にもある科目(fall)", "後期だけの科目(fall)", "通年の科目(both)",
    ]);
  });

  it("前期にも後期にもある科目は、開いているタブの側の開講だけが残る", () => {
    const spring = filterOfferingsByTerm(offerings, "spring").filter((o) => o.course_name === "前期にも後期にもある科目");
    expect(spring).toHaveLength(1);
    expect(spring[0].term).toBe("spring");
  });
});
