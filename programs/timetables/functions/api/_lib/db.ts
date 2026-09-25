// D1(SQLite)へのアクセスをまとめた入口。実体はドメインごとに db/ 配下へ分けてある。
// 利用側は従来どおり `from "./db"` / `from "../db"` で必要な関数を読み込める。

export * from "./db/admin";
export * from "./db/friends";
export * from "./db/sessions";
export * from "./db/timetable";
export * from "./db/token";
export * from "./db/users";
