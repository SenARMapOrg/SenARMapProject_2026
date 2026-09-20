#!/usr/bin/env python3
"""専修大学 Webシラバス（講義要項）スクレイパー

programs/timetables/ （時間割共有アプリ）向けに、科目名オートコンプリート／参考データセットの
種となる「開講科目一覧」を収集するツール。

## これは何のためのデータか（重要）
このスクリプトが集めるのは大学のシラバス検索サイトに載っている「開講科目情報」（科目名・曜日・時限・
学期・担当教員・学部/学科）であり、**特定の学生が実際にその授業を履修しているかどうかは一切分からない**。
シラバスサイトは開講予定の一覧を公開しているだけで、履修者名簿ではない。
生成される courses.json は「時間割入力時に科目名を選びやすくする／曜日・時限の参考にする」ための
リファレンスデータであり、誰かの個人の時間割（実際の履修内容）を推測・表示する目的で使ってはならない。

## サイトの構造（2026-09 時点の調査結果）
- 検索フォーム: GET
  https://syllabus.acc.senshu-u.ac.jp/syllsenshu/slbssrch.do?clearAccessData=true&contenam=slbssrch&kjnmnNo=12
  ログイン不要で誰でも閲覧できる（学生・教職員ログインは不要）。robots.txt は存在しない（404）。
- 検索は同じURLへの POST (JSESSIONID Cookie でセッション維持)。
- 一覧のページングは POST で pageCount / maxCount を切り替える方式（1ページ最大200件まで選べる）。
  ページ番号は「連番でアクセスする必要はなく」、任意のページ番号へ直接ジャンプできることを確認済み
  （中断からの再開がしやすい理由）。
- **注意（クロール時の罠）**: 検索結果の一覧ページング中に「詳細」ページ (slbssbdr.do) など
  一覧以外のページへ寄り道すると、次のページング要求がサーバ側の「セッションタイムアウト」エラー画面
  になってしまう（ユーザーが警告していた「戻るボタンで戻ると処理が終わらなくなる」现象と同根とみられる、
  サーバ側の画面遷移シーケンス管理が壊れやすいタイプのシステム）。
  そのため本スクリプトは **詳細ページには一切アクセスしない**
  （幸い、詳細ページにも教室情報は載っておらず、一覧の情報だけで用が足りることを確認済み）。
- 一覧テーブルの列: No / 科目名（リンク） / 開講期間・曜日・時限 / 担当教員 の4列のみ。
  学部・学科・教室は一覧テーブルには一切表示されない（教室は詳細ページにも記載なしを確認済み）。
  学部/学科だけは検索フィルタ value(crclm) を指定して絞り込み検索することで、
  「この検索結果はこの学科の科目である」と後付けで判定する以外に取得方法がない
  （--by-dept モードはこれを33学科分繰り返して実現している）。
  **学年（対象年次）は今回のスクレイパーでは未収集**。「配当」欄（例:
  「配当　ネット学科１」）に学部/学科＋学年相当の情報が載っている可能性がある、との
  ユーザー確認情報あり(2026-09-09)だが、それがどのページに出るかは未調査（README参照）。

## 学期(term)コードの対応
検索フォームの value(kkikancd) セレクトから取得した対応表:

| サイト上の表記 | kkikancd | 本ツールの term |
|---|---|---|
| 前期           | 1        | spring |
| 後期           | 2        | fall   |
| 通年           | 3        | both   |

一覧の各科目の「開講期間・曜日・時限」列はこの kkikancd とは別に、科目ごとに前期/後期/通年の
文字列がそのまま書かれている（例: "前期　火曜日　1時限"）ので、実際にはこちらの文字列から
判定している（kkikancd はあくまで検索フィルタ用）。

**重要**: term="both" は「同じ<tr>（同じ科目名・担当教員の1行）の中で、同じ曜日・時限に前期と
後期の両方が書かれている場合」にのみ付ける。これは通年科目が1行の中で「通年」と書かれている場合
と、前期・後期が別々の行として同じ行内に並記されている場合の両方をカバーする。一方、**別々の<tr>
（別の科目）が、たまたま同じ曜日・時限に前期だけ／後期だけで開講されているケースは "both" にしない**
（例: 同じ担当教員が同じ科目名で前期・後期にそれぞれ独立した科目を開講しているだけのケース）。
以前はこの区別をせず、科目名・担当教員・曜日・時限が完全一致する前期の行と後期の行があれば
無条件で通年とみなしていたため、無関係な2科目を誤って統合し、時間割に追加すると両方の学期に
入ってしまう不具合があった（2026-09 修正）。

「定時外」「集中」など曜日・時限が固定されない科目（オンデマンド科目・集中講義など）は
day_of_week / period を持たないため **スキップし、stderr にログ出力する**（--verbose で件数集計も表示）。
日曜日開講（該当があれば）や8時限以降（二部の夜間授業等）は、本アプリのスキーマ
(day_of_week: 0-5=月-土, period: 1-7) の範囲外なのでこちらもスキップしてログ出力する。

## 曜日番号の対応
programs/timetables/functions/api/_lib/validate.ts の MAX_DAY_OF_WEEK / MAX_PERIOD に合わせている。

| 曜日 | day_of_week |
|---|---|
| 月 | 0 |
| 火 | 1 |
| 水 | 2 |
| 木 | 3 |
| 金 | 4 |
| 土 | 5 |
| 日 | (非対応・スキップ) |

## 実行方法
    pip install -r requirements.txt
    python scrape.py                  # 2026年度・全キャンパス・全学部を収集（学部/学科情報なし）
    python scrape.py --year 2025      # 年度を指定
    python scrape.py --campus 112     # キャンパスコードで絞り込み（例: 112=一部生田）
    python scrape.py --dept 606100    # 学部・学科コード(crclm)で絞り込み（例: 606100=ネットワーク情報学科）
    python scrape.py --by-dept        # departments.json の全学科を1つずつ検索し、
                                       # 各科目に faculty/department を付与する（推奨。件数は同じ）

中断した場合は同じコマンドで再実行すれば output/.checkpoint.json を見て
未取得のページ（--by-dept の場合は未取得の学科）だけを取りに行く（同じ検索条件・年度である必要がある）。

## 礼儀正しさ（politeness）について
- User-Agent は "IKU-NAVI-timetables-scraper/1.0" として、素性がわかるようにプロジェクトの
  公式紹介ページのURLを付けて名乗っている（個人のメールアドレスなど生亀プロジェクト関係者の
  個人情報はUAに含めていない）。サーバー側からはこのUA文字列と接続元IPアドレス、通常のHTTP
  アクセスログ（メソッド・パス・タイムスタンプ）以外は一切分からない。
- 各リクエストの間に REQUEST_DELAY_SECONDS（既定1.0秒）のスリープを入れる。
- 1ページの取得件数を200件（サイトの選択肢の最大値）にして、必要なHTTPリクエスト数そのものを
  減らしている（全学部・全キャンパスで検索しても2026年度は約9,255件 = 約47ページで済むことを
  事前に確認済み。--by-dept で42学科に分けても、合計リクエスト数は同程度のオーダーに収まる）。
- 取得結果は検索1回（--by-dept の場合は学科1つ）完了ごとに即座に output/courses_raw.jsonl に
  追記し、output/.checkpoint.json に進捗を記録するので、クラッシュしても最初からやり直さずに
  再開できる。
- 詳細ページ (slbssbdr.do) には一切アクセスしない（上記「クロール時の罠」を参照。教室情報が
  そもそも載っていないため、アクセスする理由もない）。
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE = "https://syllabus.acc.senshu-u.ac.jp/syllsenshu"
SEARCH_URL = f"{BASE}/slbssrch.do"
INITIAL_URL = f"{SEARCH_URL}?clearAccessData=true&contenam=slbssrch&kjnmnNo=12"

USER_AGENT = (
    "Mozilla/5.0 (compatible; IKU-NAVI-timetables-scraper/1.0; "
    "+https://project.ne.senshu-u.ac.jp/2026/04/)"
)

REQUEST_DELAY_SECONDS = 1.0
PAGE_SIZE = 200  # サイトのプルダウンで選べる最大件数
REQUEST_TIMEOUT = 30

DAY_TO_INDEX = {"月": 0, "火": 1, "水": 2, "木": 3, "金": 4, "土": 5}
# 日曜日はアプリのスキーマ(0-5=月-土)が対応していないため意図的に含めない → スキップ扱い

TERM_LABEL_TO_VALUES = {
    "前期": ["spring"],
    "後期": ["fall"],
    "通年": ["spring", "fall"],
}

MAX_PERIOD = 7  # programs/timetables/functions/api/_lib/validate.ts の MAX_PERIOD と合わせる

SLOT_RE = re.compile(
    r"^(?P<term>前期|後期|通年)[　\s]+(?:(?P<day>[月火水木金土日])曜日[　\s]+(?P<period>\d+)時限)?"
)


class SkipReason:
    """day_of_week/period が確定できず出力から除外した科目のログ用カウンタ"""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def add(self, reason: str) -> None:
        self.counts[reason] = self.counts.get(reason, 0) + 1

    def report(self) -> None:
        if not self.counts:
            print("[skip] スキップされた枠はありませんでした", file=sys.stderr)
            return
        print("[skip] day_of_week/period が確定できず出力から除外した枠の内訳:", file=sys.stderr)
        for reason, count in sorted(self.counts.items(), key=lambda kv: -kv[1]):
            print(f"  - {reason}: {count}件", file=sys.stderr)


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "ja,en;q=0.8",
        }
    )
    return session


def do_initial_get(session: requests.Session) -> None:
    resp = session.get(INITIAL_URL, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)


def do_search(session: requests.Session, year: int, campus: str, dept: str) -> str:
    data = {
        "value(methodname)": "sylkougi_search",
        "buttonName": "searchKougi",
        "value(nendo)": str(year),
        "value(campuscd)": campus,
        "value(crclm)": dept,
        "value(kkikancd)": "",
        "value(kouginm)": "",
        "value(syokunm)": "",
        "value(keywords)": "",
        "value(searchKeywordFlg)": "1",
        "value(coursecd1)": "",
        "value(coursecd2)": "",
        "value(coursecd3)": "",
        "value(searchDetailConditionFlag)": "1",
    }
    resp = session.post(
        SEARCH_URL, data=data, headers={"Referer": INITIAL_URL}, timeout=REQUEST_TIMEOUT
    )
    resp.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    return resp.text


def do_page(session: requests.Session, page_count: str) -> str:
    data = {
        "value(pageCount)": page_count,
        "value(maxCount)": str(PAGE_SIZE),
        "navigateKougiList": "dummy",
    }
    resp = session.post(
        SEARCH_URL, data=data, headers={"Referer": SEARCH_URL}, timeout=REQUEST_TIMEOUT
    )
    resp.raise_for_status()
    time.sleep(REQUEST_DELAY_SECONDS)
    return resp.text


TOTAL_RE = re.compile(r"([\d,]+)-([\d,]+)件表示/([\d,]+)件中")


def extract_total(html: str) -> int | None:
    m = TOTAL_RE.search(html)
    if m:
        return int(m.group(3).replace(",", ""))
    # 該当0件のときは "X-Y件表示/Z件中" ではなく専用のメッセージになる（正常系。二部の休止学科などで実際に起こる）
    if "検索結果は0件です" in html:
        return 0
    return None


def looks_like_session_timeout(html: str) -> bool:
    return "セッションタイムアウト" in html and "件表示" not in html


def parse_rows(html: str, skip_reasons: SkipReason) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    for row in soup.select("tr.column_odd, tr.column_even"):
        tds = row.find_all("td")
        if len(tds) < 4:
            continue
        name_cell, schedule_cell, instructor_cell = tds[1], tds[2], tds[3]
        course_name = name_cell.get_text(strip=True)
        if not course_name:
            continue
        # 稀に複数担当教員が<br>区切りで入っている場合があるため、読める形に連結しておく
        instructor = instructor_cell.get_text(separator=" / ", strip=True) or None

        # まずこの行(=1つの<tr>=1つの開講)が持つ曜日・時限を全部集める。
        # 「同じ曜日・時限に前期と後期の両方がある」＝この行自身が通年科目である、という
        # 判定をこの行の中だけで完結させる（他の行の前期/後期とたまたま曜日・時限が一致しても
        # 混同しないようにするため。詳しくは regroup_terms.py のモジュールdocstring参照）。
        slots: list[tuple[str, int, int]] = []  # (term_label, day_index, period)
        for line in schedule_cell.get_text(separator="\n", strip=True).split("\n"):
            line = line.strip()
            if not line:
                continue
            m = SLOT_RE.match(line)
            if not m:
                skip_reasons.add(f"未知の形式: {line!r}")
                continue
            term_label = m.group("term")
            day_label = m.group("day")
            period_str = m.group("period")

            if not day_label or not period_str:
                # 「定時外」「集中」など曜日・時限が固定されない開講形式
                skip_reasons.add(f"曜日・時限が固定されていない ({term_label}・{line})")
                continue

            day_index = DAY_TO_INDEX.get(day_label)
            if day_index is None:
                skip_reasons.add(f"未対応の曜日: {day_label}曜日")
                continue

            period = int(period_str)
            if not (1 <= period <= MAX_PERIOD):
                skip_reasons.add(f"未対応の時限: {period}時限（8限以降など）")
                continue

            slots.append((term_label, day_index, period))

        # (曜日, 時限) ごとに、この行の中で前期・後期どちらが出現したかを集計する
        slot_terms: dict[tuple[int, int], set[str]] = {}
        for term_label, day_index, period in slots:
            slot_terms.setdefault((day_index, period), set()).update(TERM_LABEL_TO_VALUES[term_label])

        for (day_index, period), term_values in slot_terms.items():
            term_value = "both" if term_values == {"spring", "fall"} else next(iter(term_values))
            out.append(
                {
                    "course_name": course_name,
                    "day_of_week": day_index,
                    "period": period,
                    "term": term_value,
                    "room": None,
                    "instructor": instructor,
                }
            )
    return out


def load_checkpoint(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_checkpoint(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def load_departments(path: Path) -> list[dict]:
    """departments.json を読み、[{code, faculty, department}, ...] のフラットなリーフ学科一覧にして返す"""
    data = json.loads(path.read_text(encoding="utf-8"))
    leaves = []
    for fac in data["faculties"]:
        for dept in fac["departments"]:
            leaves.append({"code": dept["code"], "faculty": fac["name"], "department": dept["name"]})
    return leaves


def scrape_search(
    session: requests.Session, year: int, campus: str, dept: str, skip_reasons: SkipReason,
    label: str,
) -> list[dict]:
    """1回の検索条件(campus×dept)について、全ページ分の行を取得して返す"""
    html = do_search(session, year, campus, dept)
    total = extract_total(html)
    if total is None:
        # ここで空リストを返して呼び出し元に「完了」扱いさせると、実際には取得できていないのに
        # チェックポイント上は完了済みになってしまい、再実行しても再取得されなくなる。
        # 必ず例外にして呼び出し元で処理を止め、次回同じ学科から再開できるようにする。
        raise RuntimeError(
            f"[{label}] 検索結果件数が取得できませんでした。サイト構造が変わったか、セッションが壊れた可能性があります。"
        )
    if total == 0:
        return []

    num_pages = max(1, math.ceil(total / PAGE_SIZE))
    print(f"[info] [{label}] 総件数: {total}件 ({num_pages}ページ)", file=sys.stderr)

    rows: list[dict] = []
    for page_num in range(1, num_pages + 1):
        page_count_value = "" if page_num == 1 else str(page_num)
        page_html = do_page(session, page_count_value)
        if looks_like_session_timeout(page_html):
            raise RuntimeError(
                f"[{label}] セッションタイムアウトになりました。詳細ページ等への寄り道はしていないはずですが、"
                "サーバ側の都合でセッションが切れた可能性があります。もう一度スクリプトを実行すればこの続きから再開します。"
            )
        rows.extend(parse_rows(page_html, skip_reasons))
    return rows


def dedupe_and_write_with_departments(raw_path: Path, final_path: Path) -> int:
    """
    --by-dept 用の集約: courses_raw.jsonl には教養科目など複数学科で共有される科目が
    学科の数だけ重複して入っている（1学科ずつ検索しているため）。
    (course_name, day_of_week, period, term, instructor) が一致する行を1つにまとめ、
    それぞれが所属する学科を departments: [{faculty, department}, ...] 配列に集約する。
    """
    groups: dict[tuple, dict] = {}
    with raw_path.open(encoding="utf-8") as raw_f:
        for line in raw_f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            key = (obj["course_name"], obj["day_of_week"], obj["period"], obj["term"], obj["instructor"])
            dept_pair = (obj["faculty"], obj["department"])
            if key not in groups:
                groups[key] = {
                    "course_name": obj["course_name"],
                    "day_of_week": obj["day_of_week"],
                    "period": obj["period"],
                    "term": obj["term"],
                    "room": obj["room"],
                    "instructor": obj["instructor"],
                    "_dept_set": set(),
                }
            groups[key]["_dept_set"].add(dept_pair)

    entries = []
    for g in groups.values():
        dept_set = g.pop("_dept_set")
        g["departments"] = [
            {"faculty": f, "department": d} for f, d in sorted(dept_set)
        ]
        entries.append(g)

    final_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(entries)


def dedupe_and_write(raw_path: Path, final_path: Path, extra_keys: tuple[str, ...] = ()) -> int:
    """courses_raw.jsonl -> courses.json （完全一致の重複だけ除去して配列にまとめる）"""
    seen = set()
    entries = []
    with raw_path.open(encoding="utf-8") as raw_f:
        for line in raw_f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            key = (
                obj["course_name"], obj["day_of_week"], obj["period"], obj["term"], obj["instructor"],
                *(obj.get(k) for k in extra_keys),
            )
            if key in seen:
                continue
            seen.add(key)
            entries.append(obj)
    final_path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(entries)


def run_plain(args, out_dir: Path) -> int:
    raw_path = out_dir / "courses_raw.jsonl"
    checkpoint_path = out_dir / ".checkpoint.json"
    final_path = out_dir / "courses.json"

    search_key = {"mode": "plain", "year": args.year, "campus": args.campus, "dept": args.dept}
    checkpoint = load_checkpoint(checkpoint_path)
    resume = checkpoint.get("search_key") == search_key and checkpoint.get("total") is not None
    completed_pages: set[int] = set(checkpoint.get("completed_pages", [])) if resume else set()
    if resume:
        print(f"[resume] 前回の続きから再開します。完了済み: {len(completed_pages)}ページ", file=sys.stderr)
    else:
        if raw_path.exists():
            raw_path.unlink()
        completed_pages = set()

    session = make_session()
    print("[step] 初期ページ取得中...", file=sys.stderr)
    do_initial_get(session)

    print(f"[step] 検索実行中 (year={args.year}, campus={args.campus or '(全て)'}, dept={args.dept or '(全て)'})...", file=sys.stderr)
    html = do_search(session, args.year, args.campus, args.dept)
    total = extract_total(html)
    if total is None:
        print("[error] 検索結果件数が取得できませんでした。サイト構造が変わった可能性があります。", file=sys.stderr)
        return 1
    print(f"[info] 総件数: {total}件", file=sys.stderr)

    num_pages = max(1, math.ceil(total / PAGE_SIZE))
    print(f"[info] {PAGE_SIZE}件/ページ で {num_pages}ページ取得します", file=sys.stderr)

    checkpoint = {"search_key": search_key, "total": total, "completed_pages": sorted(completed_pages)}
    save_checkpoint(checkpoint_path, checkpoint)

    skip_reasons = SkipReason()
    row_count = 0

    with raw_path.open("a", encoding="utf-8") as raw_f:
        for page_num in range(1, num_pages + 1):
            if page_num in completed_pages:
                continue
            page_count_value = "" if page_num == 1 else str(page_num)
            print(f"[step] ページ {page_num}/{num_pages} 取得中...", file=sys.stderr)
            page_html = do_page(session, page_count_value)

            if looks_like_session_timeout(page_html):
                print(
                    "[error] セッションタイムアウトになりました。もう一度スクリプトを実行すればこのページから再開します。",
                    file=sys.stderr,
                )
                return 1

            rows = parse_rows(page_html, skip_reasons)
            for row in rows:
                raw_f.write(json.dumps(row, ensure_ascii=False) + "\n")
            raw_f.flush()
            row_count += len(rows)

            completed_pages.add(page_num)
            checkpoint["completed_pages"] = sorted(completed_pages)
            save_checkpoint(checkpoint_path, checkpoint)

    print(f"[info] 収集した枠(行)数: {row_count}件（1科目が複数曜日・時限を持つ場合は複数行になる）", file=sys.stderr)
    skip_reasons.report()

    n = dedupe_and_write(raw_path, final_path)
    print(f"[done] {final_path} に {n}件を出力しました", file=sys.stderr)
    return 0


def run_by_dept(args, out_dir: Path) -> int:
    departments_path = Path(__file__).parent / "departments.json"
    leaves = load_departments(departments_path)

    raw_path = out_dir / "courses_raw.jsonl"
    checkpoint_path = out_dir / ".checkpoint.json"
    final_path = out_dir / "courses.json"

    search_key = {"mode": "by_dept", "year": args.year}
    checkpoint = load_checkpoint(checkpoint_path)
    resume = checkpoint.get("search_key") == search_key
    completed_depts: set[str] = set(checkpoint.get("completed_depts", [])) if resume else set()
    if resume:
        print(f"[resume] 前回の続きから再開します。完了済み学科: {len(completed_depts)}/{len(leaves)}", file=sys.stderr)
    else:
        if raw_path.exists():
            raw_path.unlink()
        completed_depts = set()

    session = make_session()
    print("[step] 初期ページ取得中...", file=sys.stderr)
    do_initial_get(session)

    skip_reasons = SkipReason()
    checkpoint = {"search_key": search_key, "completed_depts": sorted(completed_depts)}
    save_checkpoint(checkpoint_path, checkpoint)

    with raw_path.open("a", encoding="utf-8") as raw_f:
        for i, leaf in enumerate(leaves, start=1):
            if leaf["code"] in completed_depts:
                continue
            label = f"{i}/{len(leaves)} {leaf['faculty']}/{leaf['department']}"
            print(f"[step] {label} を検索中...", file=sys.stderr)
            try:
                # 学科ごとに value(searchDetailConditionFlag) 等の検索状態が残ったままだと
                # 次のdo_search()が正しく結果を返さない(セッション側の画面遷移状態が壊れる)ことを確認したため、
                # 新しい検索を始める前に毎回 clearAccessData=true の初期ページを踏んでリセットする。
                do_initial_get(session)
                rows = scrape_search(session, args.year, "", leaf["code"], skip_reasons, label)
            except RuntimeError as e:
                print(f"[error] {e}", file=sys.stderr)
                return 1

            for row in rows:
                row["faculty"] = leaf["faculty"]
                row["department"] = leaf["department"]
                raw_f.write(json.dumps(row, ensure_ascii=False) + "\n")
            raw_f.flush()

            completed_depts.add(leaf["code"])
            checkpoint["completed_depts"] = sorted(completed_depts)
            save_checkpoint(checkpoint_path, checkpoint)

    skip_reasons.report()
    n = dedupe_and_write_with_departments(raw_path, final_path)
    print(f"[done] {final_path} に {n}件（学部/学科情報つき、重複科目は集約済み）を出力しました", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--year", type=int, default=2026, help="対象年度 (value(nendo))。既定: 2026")
    parser.add_argument("--campus", default="", help="キャンパスコード value(campuscd)。空文字で全キャンパス（--by-dept指定時は無視）")
    parser.add_argument("--dept", default="", help="学部・学科コード value(crclm)。空文字で全学部（--by-dept指定時は無視）")
    parser.add_argument(
        "--by-dept", action="store_true",
        help="departments.json の全学科を1つずつ検索し、各科目に faculty/department を付与する",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path(__file__).parent / "output"),
        help="出力先ディレクトリ",
    )
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.by_dept:
        return run_by_dept(args, out_dir)
    return run_plain(args, out_dir)


if __name__ == "__main__":
    raise SystemExit(main())
