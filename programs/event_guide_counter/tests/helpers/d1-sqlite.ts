// テスト用: Node 標準の SQLite（node:sqlite）で D1Database の代わりをする。
// アプリの db/*.ts をそのまま、本物のマイグレーション（migrations/*.sql）を流し込んだDBに対して動かせる。
// 実装しているのは、このアプリが使う prepare / bind / first / all / run / batch / exec だけ。

type Row = Record<string, unknown>;

interface SqliteStatement {
  all(...params: unknown[]): Row[];
  get(...params: unknown[]): Row | undefined;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}
interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
}

const plain = (row: Row | undefined): Row | null => (row ? { ...row } : null);

class Statement {
  constructor(private readonly db: SqliteDatabase, readonly sql: string, readonly params: unknown[] = []) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.db, this.sql, params);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = plain(this.db.prepare(this.sql).get(...this.params));
    if (row && column) return row[column] as T;
    return row as T | null;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r })) as T[], success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }

  runSync(): Row[] {
    // RETURNING 付きの文も batch で正しく動くよう、all で実行する
    return this.db.prepare(this.sql).all(...this.params).map((r) => ({ ...r }));
  }
}

export interface TestD1 {
  db: D1Database;
  /** 生の SQL を実行する（マイグレーションの適用・テストデータの投入用） */
  exec(sql: string): void;
  /** SELECT の結果をそのまま返す（検証用） */
  query(sql: string, ...params: unknown[]): Row[];
}

export async function createTestD1(): Promise<TestD1> {
  // Vite（vitest）は node:sqlite を解決できないので、Node の組み込みモジュールとして直接読み込む。
  // @types/node を入れていない型チェック環境でも通るよう、型は自前で書いている
  const nodeProcess = (globalThis as unknown as {
    process: { getBuiltinModule(id: string): unknown };
  }).process;
  const { DatabaseSync } = nodeProcess.getBuiltinModule("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");

  const db = {
    prepare: (sql: string) => new Statement(raw, sql),
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        const results = statements.map((s) => ({ results: s.runSync(), success: true }));
        raw.exec("COMMIT");
        return results;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;

  return {
    db,
    exec: (sql) => raw.exec(sql),
    query: (sql, ...params) => raw.prepare(sql).all(...params).map((r) => ({ ...r })),
  };
}
