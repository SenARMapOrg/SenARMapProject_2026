// 教室の入力欄。次の3通りのどれでも入力できる:
//   1. プルダウン: IKU NAVI の教室を建物順・教室名順に並べたものから選ぶ
//   2. 入力欄＋予測変換: 打ち始めると IKU NAVI の教室が候補に出る（IKU NAVI のナビ画面と同じ操作感）
//   3. 自由入力: 「オンライン」や IKU NAVI に未登録の教室など、何でもそのまま書ける
//
// どの方法でも最終的な値は入力欄（input）の文字列で、プルダウンと予測変換は入力欄に書き込む補助。
// IKU NAVI の教室を選ぶと表示名（例: "10101教室"）が入り、「次の教室へのナビ」でそのまま使える。
// 教室データを取れなかった場合（APIの障害など）は、プルダウンを隠して自由入力だけにする。

import { findRoom, loadIkuNaviRooms, searchRooms, type IkuNaviBuilding, type IkuNaviRoom } from "./ikunavi-rooms";

const SUGGESTION_LIMIT = 20;
let fieldSeq = 0;

export interface LocationField {
  root: HTMLElement;
  input: HTMLInputElement;
  /** プログラムから値を入れる（プルダウンの選択状態も合わせる） */
  setValue(value: string): void;
}

function roomKey(r: IkuNaviRoom): string {
  return `${r.building}:${r.room}`;
}

export function createLocationField(opts: { placeholder?: string; inputClass?: string } = {}): LocationField {
  const id = ++fieldSeq;
  const root = document.createElement("div");
  root.className = "location-field";

  const select = document.createElement("select");
  select.className = "location-select";
  select.setAttribute("aria-label", "IKU NAVI の教室から選ぶ");
  const placeholderOpt = document.createElement("option");
  placeholderOpt.value = "";
  placeholderOpt.textContent = "教室一覧を読み込み中...";
  select.appendChild(placeholderOpt);
  select.disabled = true;

  const inputWrap = document.createElement("div");
  inputWrap.className = "location-input-wrap";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 100;
  input.autocomplete = "off";
  input.placeholder = opts.placeholder ?? "教室（例: 10101教室・オンライン）";
  input.className = opts.inputClass ?? "location-input";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  const listId = `location-sugg-${id}`;
  input.setAttribute("aria-controls", listId);

  const sugg = document.createElement("ul");
  sugg.className = "location-sugg";
  sugg.id = listId;
  sugg.setAttribute("role", "listbox");
  sugg.hidden = true;

  inputWrap.append(input, sugg);
  root.append(select, inputWrap);

  let buildings: IkuNaviBuilding[] = [];
  const roomsByKey = new Map<string, IkuNaviRoom>();
  let shown: IkuNaviRoom[] = [];
  let activeIndex = -1;

  /** 入力欄の値が IKU NAVI の教室と一致していれば、プルダウンもその教室にそろえる */
  function syncSelect(): void {
    const room = findRoom(buildings, input.value);
    select.value = room ? roomKey(room) : "";
  }

  // 候補一覧は画面に対して固定位置で出す。「科目名から追加」の一覧のようにスクロールする枠の中に
  // 置かれても、枠で切れないようにするため。スクロール・リサイズされたら位置がずれるので閉じる。
  function placeSuggestions(): void {
    const rect = input.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    sugg.style.left = `${rect.left}px`;
    sugg.style.width = `${rect.width}px`;
    if (below < 200 && rect.top > below) {
      sugg.style.top = "";
      sugg.style.bottom = `${window.innerHeight - rect.top + 3}px`;
    } else {
      sugg.style.bottom = "";
      sugg.style.top = `${rect.bottom + 3}px`;
    }
  }

  function onViewportChange(e: Event): void {
    if (e.target instanceof Node && sugg.contains(e.target)) return; // 候補一覧自体のスクロールは閉じない
    hideSuggestions();
  }

  function hideSuggestions(): void {
    sugg.hidden = true;
    sugg.replaceChildren();
    shown = [];
    activeIndex = -1;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    document.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
  }

  function choose(room: IkuNaviRoom): void {
    input.value = room.display;
    select.value = roomKey(room);
    hideSuggestions();
  }

  function highlight(index: number): void {
    activeIndex = index;
    Array.from(sugg.children).forEach((li, i) => li.classList.toggle("is-active", i === index));
    if (index >= 0) input.setAttribute("aria-activedescendant", `${listId}-${index}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function renderSuggestions(): void {
    shown = searchRooms(buildings, input.value, SUGGESTION_LIMIT);
    // 入力が候補の1件とぴったり同じなら、もう選び終わっているので候補は出さない
    if (shown.length === 0 || (shown.length === 1 && shown[0].display === input.value.trim())) {
      hideSuggestions();
      return;
    }
    sugg.replaceChildren(...shown.map((r, i) => {
      const li = document.createElement("li");
      li.id = `${listId}-${i}`;
      li.setAttribute("role", "option");
      li.className = "location-sugg-item";
      const bldg = document.createElement("span");
      bldg.className = "location-sugg-building";
      bldg.textContent = r.buildingLabel;
      const name = document.createElement("span");
      name.textContent = r.display;
      li.append(bldg, name);
      // click だと先に blur が起きて候補が消えるので、mousedown で選ぶ（IKU NAVI のナビ画面と同じ）
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        choose(r);
      });
      return li;
    }));
    activeIndex = -1;
    placeSuggestions();
    sugg.hidden = false;
    input.setAttribute("aria-expanded", "true");
    document.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
  }

  input.addEventListener("input", () => {
    syncSelect();
    if (input.value.trim()) renderSuggestions();
    else hideSuggestions();
  });
  input.addEventListener("focus", () => {
    if (input.value.trim()) renderSuggestions();
  });
  input.addEventListener("blur", hideSuggestions);
  input.addEventListener("keydown", (e) => {
    if (sugg.hidden || shown.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight((activeIndex + 1) % shown.length);
      sugg.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(activeIndex <= 0 ? shown.length - 1 : activeIndex - 1);
      sugg.children[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault(); // フォームの送信ではなく候補の確定にする
      choose(shown[activeIndex]);
    } else if (e.key === "Escape") {
      hideSuggestions();
    }
  });

  select.addEventListener("change", () => {
    const room = roomsByKey.get(select.value);
    if (room) input.value = room.display;
    hideSuggestions();
  });

  void loadIkuNaviRooms().then((loaded) => {
    buildings = loaded;
    if (loaded.length === 0) {
      // 教室データを取れなかった: プルダウンは出さず、自由入力だけにする
      select.hidden = true;
      return;
    }
    placeholderOpt.textContent = "IKU NAVI の教室から選ぶ";
    for (const b of loaded) {
      const group = document.createElement("optgroup");
      group.label = b.label;
      for (const r of b.rooms) {
        roomsByKey.set(roomKey(r), r);
        const opt = document.createElement("option");
        opt.value = roomKey(r);
        opt.textContent = r.display;
        group.appendChild(opt);
      }
      select.appendChild(group);
    }
    select.disabled = false;
    syncSelect();
  });

  return {
    root,
    input,
    setValue(value: string) {
      input.value = value;
      syncSelect();
      hideSuggestions();
    },
  };
}
