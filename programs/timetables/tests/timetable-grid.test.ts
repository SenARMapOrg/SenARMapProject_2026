// 時間割グリッドの計算まわり（時限表・今日/今の時限の判定・Map変換）
import { describe, expect, it } from "vitest";

import {
  buildSlotMap, entriesToMap, entryKey, getNowInfo, gradeLabel, guessCurrentTerm,
  isPeriodAvailable, PERIOD_COUNT, SATURDAY_DAY_INDEX, slotMapToEntries, type SlotMap,
} from "../src/timetable-grid";

// 2026-09-24 は木曜日（day_of_week=3）
const thursday = (h: number, m = 0) => new Date(2026, 8, 24, h, m);

describe("時限の有無", () => {
  it("平日は7限まである", () => {
    for (let p = 1; p <= PERIOD_COUNT; p += 1) expect(isPeriodAvailable(0, p)).toBe(true);
  });

  it("土曜は4限までしかない", () => {
    expect(isPeriodAvailable(SATURDAY_DAY_INDEX, 4)).toBe(true);
    expect(isPeriodAvailable(SATURDAY_DAY_INDEX, 5)).toBe(false);
  });
});

describe("getNowInfo", () => {
  it("日曜は授業日ではない", () => {
    const sunday = new Date(2026, 8, 27, 10, 0);
    expect(getNowInfo(sunday)).toEqual({ todayIndex: null, currentPeriod: null, nextPeriod: null });
  });

  it("曜日を月曜起点のインデックスで返す", () => {
    expect(getNowInfo(thursday(10)).todayIndex).toBe(3);
  });

  it("授業時間内なら今の時限を返す", () => {
    const info = getNowInfo(thursday(9, 30)); // 1限(09:00-10:30)の中
    expect(info.currentPeriod).toBe(1);
    expect(info.nextPeriod).toBe(2);
  });

  it("休み時間は今の時限なし・次の時限あり", () => {
    const info = getNowInfo(thursday(10, 35)); // 1限終了〜2限開始の間
    expect(info.currentPeriod).toBeNull();
    expect(info.nextPeriod).toBe(2);
  });

  it("時限の終了時刻ちょうどはまだその時限の中", () => {
    expect(getNowInfo(thursday(10, 30)).currentPeriod).toBe(1);
  });

  it("最終時限の後は次の時限がない", () => {
    const info = getNowInfo(thursday(22, 0));
    expect(info.currentPeriod).toBeNull();
    expect(info.nextPeriod).toBeNull();
  });

  it("土曜は5限以降を次の時限にしない", () => {
    const saturday = new Date(2026, 8, 26, 16, 25); // 4限終了後
    const info = getNowInfo(saturday);
    expect(info.todayIndex).toBe(SATURDAY_DAY_INDEX);
    expect(info.nextPeriod).toBeNull();
  });
});

describe("guessCurrentTerm", () => {
  it("4〜8月は前期", () => {
    expect(guessCurrentTerm(new Date(2026, 3, 1))).toBe("spring");
    expect(guessCurrentTerm(new Date(2026, 7, 31))).toBe("spring");
  });

  it("9〜3月は後期", () => {
    expect(guessCurrentTerm(new Date(2026, 8, 1))).toBe("fall");
    expect(guessCurrentTerm(new Date(2026, 2, 31))).toBe("fall");
  });
});

describe("SlotMap の変換", () => {
  const entries = [
    { day_of_week: 1, period: 2, course_name: "情報システム基礎", location: "10101", instructor: "生亀" },
    { day_of_week: 3, period: 1, course_name: "ネットワーク", location: null, instructor: null },
  ];

  it("キーは曜日と時限から作る", () => {
    expect(entryKey(1, 2)).toBe("1-2");
  });

  it("エントリ配列からMapを作れる", () => {
    const map = buildSlotMap(entries);
    expect(map.get("1-2")).toEqual({
      course_name: "情報システム基礎", location: "10101", instructor: "生亀",
    });
    expect(map.get("3-1")?.location).toBe("");   // 未設定は空文字にそろえる
  });

  it("Mapから戻すと元のエントリに揃う", () => {
    const restored = slotMapToEntries(buildSlotMap(entries));
    expect(restored).toHaveLength(2);
    expect(restored).toContainEqual(entries[0]);
    expect(restored).toContainEqual(entries[1]);   // 空の教室名はnullに戻る
  });

  it("同じコマが複数あれば後の行で上書きされる", () => {
    const map: SlotMap = buildSlotMap([
      { day_of_week: 0, period: 1, course_name: "旧", location: null, instructor: null },
      { day_of_week: 0, period: 1, course_name: "新", location: null, instructor: null },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("0-1")?.course_name).toBe("新");
  });

  it("entriesToMap は元のエントリをそのまま保持する", () => {
    const map = entriesToMap(entries);
    expect(map.get("1-2")).toBe(entries[0]);
  });
});

describe("表示ラベル", () => {
  it("学年", () => {
    expect(gradeLabel(1)).toBe("1年次");
    expect(gradeLabel(8)).toBe("8年次");
  });
});
