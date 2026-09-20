// シラバスから収集した開講科目データ(programs/syllabus_courses)を検索するためのモジュール。
// データ本体は public/courses/{年度}.json（Viteがdistにそのままコピーする静的アセット。
// 2020〜2026年度分を収集済み）。更新するには programs/timetables/scripts/sync-courses.sh を参照。
//
// 注意: このデータは「開講予定の一覧」であって、特定の学生の履修状況を示すものではない。
// 科目名オートコンプリート・曜日/時限の自動入力の参考データとしてのみ使うこと。

import type { Term } from "./api";

/** シラバスデータが揃っている年度（public/courses/{year}.json が存在する年度）。降順で表示に使う */
export const AVAILABLE_COURSE_YEARS = [2026, 2025, 2024, 2023, 2022, 2021, 2020];
export const DEFAULT_COURSE_YEAR = AVAILABLE_COURSE_YEARS[0];

export interface CourseCatalogEntry {
  course_name: string;
  day_of_week: number;
  period: number;
  term: Term;
  room: string | null;
  instructor: string | null;
  departments: { faculty: string; department: string }[];
}

/** "both" = 通年科目（前期・後期の両方に同じ曜日・時限で開講。scrape.py側で2行に展開されているものをここで統合する） */
export type OfferingTerm = Term | "both";

/** 1つの「開講」= 同じ科目名・担当教員・学期・曜日・時限の科目1コマ分 */
export interface CourseOffering {
  course_name: string;
  instructor: string | null;
  term: OfferingTerm;
  departments: { faculty: string; department: string }[];
  slots: { day_of_week: number; period: number }[];
}

const catalogCache = new Map<number, Promise<CourseCatalogEntry[]>>();

/** 指定年度の /courses/{year}.json を取得する。年度ごとに初回だけ取得し、以降はメモリキャッシュを返す */
export function loadCatalog(year: number = DEFAULT_COURSE_YEAR): Promise<CourseCatalogEntry[]> {
  let cached = catalogCache.get(year);
  if (!cached) {
    cached = fetch(`/courses/${year}.json`).then((res) => {
      if (!res.ok) throw new Error(`${year}年度の科目データを取得できませんでした`);
      return res.json() as Promise<CourseCatalogEntry[]>;
    });
    catalogCache.set(year, cached);
  }
  return cached;
}

export interface DepartmentCatalog {
  faculties: { name: string; departments: { name: string }[] }[];
}

let departmentsCache: Promise<DepartmentCatalog> | null = null;

/**
 * 学部/学科一覧（年度に依存しない共通データ）。プロフィール設定・「みんなの時間割を探す」の
 * 絞り込みセレクトのデータソース。
 */
export function loadDepartmentCatalog(): Promise<DepartmentCatalog> {
  if (!departmentsCache) {
    departmentsCache = fetch("/departments.json").then((res) => {
      if (!res.ok) throw new Error("学部/学科データを取得できませんでした");
      return res.json() as Promise<DepartmentCatalog>;
    });
  }
  return departmentsCache;
}

export function listFaculties(catalog: CourseCatalogEntry[]): string[] {
  const set = new Set<string>();
  for (const c of catalog) {
    for (const d of c.departments) set.add(d.faculty);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

export function listDepartments(catalog: CourseCatalogEntry[], faculty: string): string[] {
  const set = new Set<string>();
  for (const c of catalog) {
    for (const d of c.departments) {
      if (d.faculty === faculty) set.add(d.department);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

function makeKey(parts: (string | number)[]): string {
  return parts.join("");
}

/**
 * 科目を「開講」単位に変換する。
 *
 * 重要: 同じ科目名・担当教員・学期であっても、曜日・時限が異なる行は**まとめない**。
 * 同じ先生が同じ科目名を月曜3限クラスと火曜2限クラスのように別々の学生に教えている
 * （並行開講の別クラス）場合と、1つの授業が2コマ連続で1回の授業になっている場合を
 * シラバスの一覧表記だけからは区別できないため、安全側に倒して常に曜日・時限ごとに
 * 別々の「開講」として扱う（1つの授業が複数コマなら、それぞれを個別に追加すればよい）。
 *
 * 学期でフィルタしない＝前期・後期どちらの科目も常に全件対象にする
 * （前期タブを見ながら後期の予定も組みたい、という使い方に対応するため）。
 * 前期・後期の両方に全く同じ曜日・時限で存在する科目は「通年(both)」として1件にまとめる。
 */
export function groupOfferings(catalog: CourseCatalogEntry[]): CourseOffering[] {
  const map = new Map<string, CourseOffering>();
  for (const e of catalog) {
    const key = makeKey([e.course_name, e.instructor ?? "", e.term, e.day_of_week, e.period]);
    let offering = map.get(key);
    if (!offering) {
      offering = {
        course_name: e.course_name,
        instructor: e.instructor,
        term: e.term,
        departments: e.departments,
        slots: [{ day_of_week: e.day_of_week, period: e.period }],
      };
      map.set(key, offering);
    }
  }

  const offerings = [...map.values()];
  const bySpringKey = new Map<string, CourseOffering>();
  for (const o of offerings) {
    if (o.term === "spring") {
      const slot = o.slots[0];
      bySpringKey.set(makeKey([o.course_name, o.instructor ?? "", slot.day_of_week, slot.period]), o);
    }
  }

  const merged: CourseOffering[] = [];
  const consumedSpring = new Set<CourseOffering>();
  for (const o of offerings) {
    if (o.term !== "fall") continue;
    const slot = o.slots[0];
    const spring = bySpringKey.get(makeKey([o.course_name, o.instructor ?? "", slot.day_of_week, slot.period]));
    if (spring) {
      merged.push({ ...o, term: "both" });
      consumedSpring.add(spring);
    }
  }
  const consumedFallKeys = new Set(
    merged.map((o) => makeKey([o.course_name, o.instructor ?? "", o.slots[0].day_of_week, o.slots[0].period])),
  );
  for (const o of offerings) {
    if (consumedSpring.has(o)) continue;
    if (o.term === "fall") {
      const slot = o.slots[0];
      if (consumedFallKeys.has(makeKey([o.course_name, o.instructor ?? "", slot.day_of_week, slot.period]))) continue;
    }
    merged.push(o);
  }
  return merged;
}

export function searchOfferings(
  offerings: CourseOffering[], query: string, faculty: string, department: string,
): CourseOffering[] {
  const q = query.trim().toLowerCase();
  return offerings.filter((o) => {
    if (q && !o.course_name.toLowerCase().includes(q)) return false;
    if (faculty || department) {
      const hit = o.departments.some(
        (d) => (!faculty || d.faculty === faculty) && (!department || d.department === department),
      );
      if (!hit) return false;
    }
    return true;
  });
}
