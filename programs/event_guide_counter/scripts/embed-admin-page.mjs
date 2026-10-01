// ビルド後処理: 管理画面のHTML（dist/admin.html）を静的ファイルとして置かず、
// Pages Function（functions/admin.ts）の中に埋め込む。理由はfunctions/admin.tsのコメント参照。
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const htmlPath = resolve(root, "dist/admin.html");
const outPath = resolve(root, "functions/api/_lib/admin-page.generated.ts");

const html = readFileSync(htmlPath, "utf8");
if (!html.includes('src="/assets/admin-')) {
  throw new Error("dist/admin.html に管理画面のスクリプトが見つかりません。vite build の出力を確認してください");
}

writeFileSync(outPath, [
  "// このファイルは scripts/embed-admin-page.mjs が npm run build のたびに生成する。編集しないこと。",
  "// （Git 管理外。型は admin-page.generated.d.ts）",
  `export const ADMIN_PAGE_HTML = ${JSON.stringify(html)};`,
  "",
].join("\n"));
unlinkSync(htmlPath);

console.log(`[embed-admin-page] dist/admin.html を ${outPath.replace(root + "/", "")} に埋め込み、静的ファイルから削除しました`);
