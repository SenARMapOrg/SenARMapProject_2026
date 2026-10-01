// シラバスから収集した開講科目データ(programs/syllabus_courses)を検索するためのモジュール。
// データ本体は src/data/courses/{年度}.json（2020〜2026年度分）。元のデータを scripts/compact-courses.mjs で
// 小さな形式に変換したもので、更新するには programs/timetables/scripts/sync-courses.sh を参照。
// ビルドすると内容のハッシュ付きのファイル名（/assets/2026-xxxx.json）で出力されるので、
// ブラウザに長期間キャッシュさせられる（中身が変わればファイル名も変わる）。
//
// 注意: このデータは「開講予定の一覧」であって、特定の学生の履修状況を示すものではない。
// 科目名オートコンプリート・曜日/時限の自動入力の参考データとしてのみ使うこと。

import type { Term } from "./api";

/** 年度 → ビルド後のデータのURL。src/data/courses/ にファイルを置けば、その年度が選べるようになる */
const COURSE_DATA_URLS: Record<number, string> = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("./data/courses/*.json", { query: "?url", import: "default", eager: true }),
  ).map(([path, url]) => [Number(path.match(/(\d{4})\.json$/)![1]), url]),
);

/** シラバスデータが揃っている年度。降順で表示に使う */
export const AVAILABLE_COURSE_YEARS = Object.keys(COURSE_DATA_URLS).map(Number).sort((a, b) => b - a);
export const DEFAULT_COURSE_YEAR = AVAILABLE_COURSE_YEARS[0];

/** "both" = 通年科目。シラバスの「開講期間」欄に**「通年」と書かれている場合だけ**に付く値で、
 * 判定は programs/syllabus_courses/scrape.py が収集時に確定させている。
 * 前期にも後期にも開講されている科目（体育実技や語学など）は通年ではないので、
 * spring の開講と fall の開講として別々のエントリになる。 */
export type OfferingTerm = Term | "both";

export interface CourseCatalogEntry {
  course_name: string;
  day_of_week: number;
  period: number;
  term: OfferingTerm;
  instructor: string | null;
  departments: { faculty: string; department: string }[];
}

/** 1つの「開講」= 同じ科目名・担当教員・学期・曜日・時限の科目1コマ分 */
export interface CourseOffering {
  course_name: string;
  instructor: string | null;
  term: OfferingTerm;
  departments: { faculty: string; department: string }[];
  slots: { day_of_week: number; period: number }[];
}

/** src/data/courses/{年度}.json の形式（scripts/compact-courses.mjs が作る） */
export interface CompactCatalog {
  format: 2;
  departments: [faculty: string, department: string][];
  departmentSets: number[][];
  courses: [
    courseName: string, instructor: string | null, term: OfferingTerm, dayOfWeek: number, period: number,
    departmentSet: number,
  ][];
}

/**
 * 小さな形式から元の形（1コマ1件）に戻す。学部・学科の配列は同じ組み合わせのコマ同士で共有する
 * （画面側では読むだけで書き換えないので、共有しても問題ない。メモリも少なくて済む）。
 */
export function decodeCatalog(data: CompactCatalog): CourseCatalogEntry[] {
  const departments = data.departments.map(([faculty, department]) => ({ faculty, department }));
  const sets = data.departmentSets.map((ids) => ids.map((id) => departments[id]));
  return data.courses.map(([course_name, instructor, term, day_of_week, period, set]) => ({
    course_name, instructor, term, day_of_week, period, departments: sets[set],
  }));
}

const catalogCache = new Map<number, Promise<CourseCatalogEntry[]>>();

/** 指定年度の科目データを取得する。年度ごとに初回だけ取得し、以降はメモリキャッシュを返す */
export function loadCatalog(year: number = DEFAULT_COURSE_YEAR): Promise<CourseCatalogEntry[]> {
  let cached = catalogCache.get(year);
  if (!cached) {
    const url = COURSE_DATA_URLS[year];
    cached = (url ? fetch(url) : Promise.reject(new Error("no data"))).then(async (res) => {
      if (!res.ok) throw new Error(`${year}年度の科目データを取得できませんでした`);
      return decodeCatalog(await res.json() as CompactCatalog);
    });
    // 失敗したときは次に開いたときにもう一度取りに行けるよう、キャッシュに残さない
    cached.catch(() => catalogCache.delete(year));
    catalogCache.set(year, cached);
  }
  return cached;
}

/**
 * 画面を開いた直後、通信が落ち着いたころに今年度の科目データを先に取っておく。
 * 「科目を追加・削除する」を押したときには読み込みが終わっているようにするため。
 */
export function prefetchCatalog(year: number = DEFAULT_COURSE_YEAR): void {
  const start = () => { void loadCatalog(year).catch(() => { /* 開いたときに改めて取得・エラー表示する */ }); };
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 2000 });
  else setTimeout(start, 500);
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
 * ここでは学期で絞り込まない。画面に出すときに filterOfferingsByTerm() で、開いている学期タブに
 * 合う開講（前期タブなら前期と通年、後期タブなら後期と通年）だけに絞る。
 *
 * 通年かどうかをここで推測することは絶対にしない。term はシラバスに書かれている値を
 * scrape.py がそのまま持ってきたものなので、信頼してキーに含めるだけでよい。
 * 以前は「前期の行と後期の行が同じ曜日・時限にあれば通年」と推測しており、
 * 前期にも後期にも開講されているだけの科目が通年に統合され、時間割に追加すると
 * 両方の学期に入ってしまう不具合になっていた。
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
  return [...map.values()];
}

/**
 * 開いている学期タブに合う開講だけを残す。前期タブなら前期と通年、後期タブなら後期と通年。
 * 前期にも後期にも開講されている科目は前期・後期それぞれの開講として別に入っているので、
 * 開いているタブの側だけが残る。
 */
export function filterOfferingsByTerm(offerings: CourseOffering[], term: Term): CourseOffering[] {
  return offerings.filter((o) => o.term === term || o.term === "both");
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
