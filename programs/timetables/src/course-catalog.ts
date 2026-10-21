// 「科目名から追加」の候補（ほかの学生がこの時間割サービスに登録した授業）と、学部/学科一覧を読み込むモジュール。
// シラバスなどの外部の科目データは持たない。候補は GET /api/timetable/courses が登録済みの行から集めたもので、
// 2人以上が登録した授業だけが返る（functions/api/_lib/db/timetable.ts の listSharedCourses 参照）。

import { api, type SharedCourse, type Term } from "./api";

let coursesCache: Promise<SharedCourse[]> | null = null;

/**
 * ほかの学生が登録した授業の一覧を取得する。画面を開いている間は最初の1回だけ取り、以降はそれを使う
 * （入力のたびに問い合わせない。失敗したときは次に開いたときにもう一度取りに行く）。
 */
export function loadSharedCourses(): Promise<SharedCourse[]> {
  if (!coursesCache) {
    coursesCache = api.getSharedCourses().then((res) => res.courses);
    coursesCache.catch(() => { coursesCache = null; });
  }
  return coursesCache;
}

/**
 * 科目名で検索する（大文字・小文字は区別しない）。学期は開いている学期タブのものだけ、
 * slot を渡すとその曜日・時限のものだけに絞る。並びはサーバーが返した順（登録した人数の多い順）のまま。
 */
export function searchSharedCourses(
  courses: SharedCourse[], query: string, term: Term, slot: { day: number; period: number } | null,
): SharedCourse[] {
  const q = query.trim().toLowerCase();
  return courses.filter((c) => (
    c.term === term
    && (!q || c.course_name.toLowerCase().includes(q))
    && (!slot || (c.day_of_week === slot.day && c.period === slot.period))
  ));
}

/**
 * 同じ科目名・担当教員・曜日・時限の授業が、もう一方の学期にも登録されていれば返す
 * （通年の授業を前期に追加したあと、「後期にも追加しますか？」を出すため）。
 * 自動で両方の学期に入れると無関係な授業まで入ってしまうので、追加するかは必ず本人が押して決める。
 */
export function findOtherTermCourse(courses: SharedCourse[], course: SharedCourse): SharedCourse | undefined {
  const otherTerm: Term = course.term === "spring" ? "fall" : "spring";
  return courses.find((c) => (
    c.term === otherTerm && c.course_name === course.course_name && c.instructor === course.instructor
    && c.day_of_week === course.day_of_week && c.period === course.period
  ));
}

export interface DepartmentCatalog {
  faculties: { name: string; departments: { name: string }[] }[];
}

let departmentsCache: Promise<DepartmentCatalog> | null = null;

/**
 * 学部/学科一覧（public/departments.json）。プロフィール設定・「みんなの時間割を探す」の
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
