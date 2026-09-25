// IKU NAVI の教室データの並べ替え・予測変換・教室の特定
import { describe, expect, it } from "vitest";

import { findRoom, groupRooms, searchRooms, type IkuNaviAllResponse } from "../src/ikunavi-rooms";

const data: IkuNaviAllResponse = {
  buildings: [
    { id: 0, display_name: "屋外" },
    { id: 1, display_name: "1号館" },
    { id: 10, display_name: "10号館" },
    { id: 2, display_name: "2号館" },
  ],
  rooms: [
    { room: "10301", display: "10301教室", building: 10 },
    { room: "10101", display: "10101教室", building: 10 },
    { room: "SUBWAY", display: "サブウェイ", building: 10 },
    { room: "VIEW", display: "レストランVIEW", building: 0 },
    { room: "1001", display: "1001教室", building: 1 },
    { room: "102", display: "102教室", building: 1 },
    { room: "201", display: "201教室", building: 2 },
    { room: "NoDisplay", building: 2 },
  ],
};

describe("groupRooms（建物順・教室名順）", () => {
  const grouped = groupRooms(data);

  it("建物は番号順で、屋外は最後", () => {
    expect(grouped.map((b) => b.label)).toEqual(["1号館", "2号館", "10号館", "屋外"]);
  });

  it("教室名は数字を数値として並べる（102 が 1001 より前）", () => {
    expect(grouped[0].rooms.map((r) => r.display)).toEqual(["102教室", "1001教室"]);
    expect(grouped[2].rooms.map((r) => r.display)).toEqual(["10101教室", "10301教室", "サブウェイ"]);
  });

  it("表示名が無い教室は生の名前を表示名にする", () => {
    expect(grouped[1].rooms.find((r) => r.room === "NoDisplay")?.display).toBe("NoDisplay");
  });

  it("建物一覧に無い建物番号でも「N号館」として扱う", () => {
    const g = groupRooms({ buildings: [], rooms: [{ room: "501", display: "501教室", building: 5 }] });
    expect(g[0].label).toBe("5号館");
  });
});

describe("searchRooms（予測変換）", () => {
  const grouped = groupRooms(data);
  const names = (q: string) => searchRooms(grouped, q).map((r) => r.display);

  it("表示名の一部で見つかる", () => {
    expect(names("103")).toEqual(["10301教室"]);
  });

  it("生の名前でも見つかる", () => {
    expect(names("subway")).toEqual(["サブウェイ"]);
  });

  it("建物名で打つとその建物の教室が出る", () => {
    expect(names("2号館")).toEqual(["201教室", "NoDisplay"]);
  });

  it("候補も建物順・教室名順", () => {
    expect(names("教室")).toEqual(["102教室", "1001教室", "201教室", "10101教室", "10301教室"]);
  });

  it("件数の上限を守る", () => {
    expect(searchRooms(grouped, "教室", 2)).toHaveLength(2);
  });

  it("空の入力では何も出さない", () => {
    expect(names("  ")).toEqual([]);
  });
});

describe("findRoom（保存された教室名から IKU NAVI の教室を特定）", () => {
  const grouped = groupRooms(data);

  it("表示名の完全一致で見つかる", () => {
    expect(findRoom(grouped, "10101教室")?.building).toBe(10);
  });

  it("生の名前の完全一致でも見つかる（以前に手入力された「10101」など）", () => {
    expect(findRoom(grouped, "10101")?.display).toBe("10101教室");
  });

  it("前後の空白は無視する", () => {
    expect(findRoom(grouped, " 201教室 ")?.building).toBe(2);
  });

  it("IKU NAVI に無い教室（オンラインなど）は null", () => {
    expect(findRoom(grouped, "オンライン")).toBeNull();
    expect(findRoom(grouped, "")).toBeNull();
    expect(findRoom(grouped, null)).toBeNull();
  });

  it("複数の建物で当てはまるときは決めつけずに null", () => {
    const dup = groupRooms({
      buildings: [],
      rooms: [{ room: "101", display: "101教室", building: 1 }, { room: "101", display: "101教室", building: 2 }],
    });
    expect(findRoom(dup, "101教室")).toBeNull();
  });
});
