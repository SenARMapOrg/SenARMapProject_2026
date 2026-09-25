// IKU NAVI（programs/3D_Graph の経路探索API）の教室データ。
// 時間割の教室欄で、IKU NAVI と同じ教室名を選べるようにするために使う。
// 同じ名前で保存しておけば、「次の教室へのナビを開く」でIKU NAVIがそのまま教室を見つけられる。
//
// IKU NAVI のナビ画面（programs/html/navi）と同じ /api/all を読む。教室は追加され続けているので、
// 静的なコピーを持たず毎回APIから取る（取れなかった場合は一覧が空になるだけで、自由入力はできる）。

/** ビルド時に VITE_IKUNAVI_API_BASE を指定すると差し替えられる（ローカルで Flask を動かして試すとき用） */
export const IKUNAVI_API_BASE: string =
  (import.meta.env.VITE_IKUNAVI_API_BASE as string | undefined) ?? "https://api.iku-navi.net";

export interface IkuNaviRoom {
  room: string;          // IKU NAVI 内部の生の名前（例: "10101"）
  display: string;       // 表示名（例: "10101教室"）。時間割にはこちらを保存する
  building: number;      // 建物番号（0 = 屋外）
  buildingLabel: string; // 建物の表示名（例: "10号館"）
}

export interface IkuNaviBuilding {
  id: number;
  label: string;
  rooms: IkuNaviRoom[];
}

/** /api/all の応答のうち、ここで使う部分 */
export interface IkuNaviAllResponse {
  rooms: { room: string; display?: string; building: number }[];
  buildings: { id: number; display_name: string }[];
}

const collator = new Intl.Collator("ja", { numeric: true });

/**
 * 建物順・教室名順に並べる。建物は番号順で、屋外（0）だけ最後に置く。
 * 教室名は数字を数値として比べる（"102教室" が "1001教室" より前に来るように）。
 */
export function groupRooms(data: IkuNaviAllResponse): IkuNaviBuilding[] {
  const labels = new Map(data.buildings.map((b) => [b.id, b.display_name]));
  const byBuilding = new Map<number, IkuNaviRoom[]>();
  for (const r of data.rooms) {
    const building = Number(r.building);
    const label = labels.get(building) ?? (building === 0 ? "屋外" : `${building}号館`);
    const list = byBuilding.get(building) ?? [];
    list.push({ room: r.room, display: r.display || r.room, building, buildingLabel: label });
    byBuilding.set(building, list);
  }
  const order = (id: number) => (id === 0 ? Number.MAX_SAFE_INTEGER : id);
  return [...byBuilding.entries()]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([id, rooms]) => ({
      id,
      label: rooms[0].buildingLabel,
      rooms: rooms.sort((a, b) => collator.compare(a.display, b.display)),
    }));
}

/**
 * 入力中の文字列で教室を探す（予測変換用）。教室の表示名・生の名前に加え、
 * 「10号館」のように建物名で打ち始めたときにもその建物の教室が出るようにする。
 */
export function searchRooms(buildings: IkuNaviBuilding[], query: string, limit = 20): IkuNaviRoom[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: IkuNaviRoom[] = [];
  for (const b of buildings) {
    for (const r of b.rooms) {
      const text = `${r.buildingLabel} ${r.display} ${r.room}`.toLowerCase();
      if (text.includes(q)) {
        hits.push(r);
        if (hits.length >= limit) return hits;
      }
    }
  }
  return hits;
}

/**
 * 保存されている教室名から IKU NAVI の教室を特定する（表示名か生の名前の完全一致）。
 * 見つからない（オンラインなど）・複数の建物で当てはまる場合は null。
 */
export function findRoom(buildings: IkuNaviBuilding[], text: string | null | undefined): IkuNaviRoom | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const matches = buildings.flatMap((b) => b.rooms).filter((r) => r.display === t || r.room === t);
  return matches.length === 1 ? matches[0] : null;
}

let cache: Promise<IkuNaviBuilding[]> | null = null;

/** IKU NAVI の教室一覧を取得する。失敗しても例外にせず空配列を返す（次に呼ばれたときに取り直す） */
export function loadIkuNaviRooms(): Promise<IkuNaviBuilding[]> {
  if (!cache) {
    cache = fetch(`${IKUNAVI_API_BASE}/api/all`, { credentials: "omit" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<IkuNaviAllResponse>;
      })
      .then(groupRooms)
      .catch(() => {
        cache = null;
        return [];
      });
  }
  return cache;
}
