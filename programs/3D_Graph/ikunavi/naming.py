"""生の名前（CSVに書かれた識別子）→ 画面・音声で使う表示名 の解決。

edge.csv の name/right/left 列には "101A" や "M_Toilet" のような内部識別子が
入っている。利用者に見せる文字列はすべてここを通して組み立てる。
対応表は data/name.csv・data/building_name.csv、候補から隠す名前は data/ignore.csv。
"""
import os

import pandas as pd

from .config import data_path

# トイレは name.csv に表示名を持たず、種別ごとに固定のラベルを使う
TOILET_LABEL = {"M_Toilet": "男子トイレ", "F_Toilet": "女子トイレ", "C_Toilet": "多目的トイレ"}
TOILET_NAMES = set(TOILET_LABEL)
TOILET_TYPE_MAP = {
    "M":   ["M_Toilet"],
    "F":   ["F_Toilet"],
    "C":   ["C_Toilet"],
    "ALL": ["M_Toilet", "F_Toilet", "C_Toilet"],
}

_name_map          = None   # name.csv: {(building|None, name): display_name}
_building_name_map = None   # building_name.csv: {building: display_name}
_ignore_set        = None   # ignore.csv: {name, ...}


def _read_text_csv(path):
    """全列を文字列として読み、欠損を空文字に揃える（表示名CSV共通の読み方）"""
    df = pd.read_csv(path, dtype=str).fillna("")
    df.columns = df.columns.str.strip()
    return df


def get_name_map():
    """
    name.csv（列: building,name,display_name）を読み込み、
    {(building, name): display_name} の辞書を返す。
    building 列が空の行は全建物共通の表示名として (None, name) キーで保持する。
    """
    global _name_map
    if _name_map is None:
        name_map = {}
        path = data_path("name.csv")
        if os.path.exists(path):
            for _, row in _read_text_csv(path).iterrows():
                name    = str(row.get("name", "")).strip()
                display = str(row.get("display_name", "")).strip()
                bldg    = str(row.get("building", "")).strip()
                if not name or not display:
                    continue
                key = (int(float(bldg)), name) if bldg else (None, name)
                name_map[key] = display
        _name_map = name_map
    return _name_map


def get_building_name_map():
    """
    building_name.csv（列: building,display_name）を読み込み、
    {building: display_name} の辞書を返す。
    """
    global _building_name_map
    if _building_name_map is None:
        name_map = {}
        path = data_path("building_name.csv")
        if os.path.exists(path):
            for _, row in _read_text_csv(path).iterrows():
                bldg    = str(row.get("building", "")).strip()
                display = str(row.get("display_name", "")).strip()
                if not bldg or not display:
                    continue
                name_map[int(float(bldg))] = display
        _building_name_map = name_map
    return _building_name_map


def get_ignore_set():
    """
    ignore.csv（列: id）を読み込み、教室検索の候補一覧から隠す生の名前の集合を返す。
    building 列は無く、建物を問わずこの名前に一致するエッジが対象になる。
    ルート検索（from_room/to_room）・最寄りトイレ/食堂検索・event.csvのroom紐付けは
    索引（room_index）を直接参照するため、ここでの除外の影響を受けない。
    """
    global _ignore_set
    if _ignore_set is None:
        ignore_set = set()
        path = data_path("ignore.csv")
        if os.path.exists(path):
            for _, row in _read_text_csv(path).iterrows():
                name = str(row.get("id", "")).strip()
                if name:
                    ignore_set.add(name)
        _ignore_set = ignore_set
    return _ignore_set


def display_name(building, name):
    """name.csv の表示名を返す。建物指定 → 全建物共通 → 生の名前+「教室」 の順で解決"""
    name_map = get_name_map()
    return (
        name_map.get((int(building), name))
        or name_map.get((None, name))
        or f"{name}教室"
    )


def building_display_name(building):
    """building_name.csv の表示名を返す。未登録なら 屋外/{building}号館 にフォールバック"""
    building = int(building)
    display = get_building_name_map().get(building)
    if display:
        return display
    return "屋外" if building == 0 else f"{building}号館"


def first_display_label(building, raw_value):
    """
    ";"区切りの生の名前（name/right/left列の値）の先頭要素だけを、読み上げ用の表示名に変換する。
    トイレ（M_Toilet等）はname.csvに表示名が無く display_name のフォールバックだと不自然になる
    （例: "M_Toilet教室"）ため、TOILET_LABEL を先に見る。それ以外は name.csv に委ねる。
    """
    first = str(raw_value or "").split(";")[0].strip()
    if not first:
        return ""
    if first in TOILET_LABEL:
        return TOILET_LABEL[first]
    return display_name(building, first)


def clear_caches():
    global _name_map, _building_name_map, _ignore_set
    _name_map = None
    _building_name_map = None
    _ignore_set = None
