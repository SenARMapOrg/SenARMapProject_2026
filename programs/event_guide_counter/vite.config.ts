import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // 唯一のページ(admin.html)が入口。functions/admin.ts が認証後にだけ返す
      // （scripts/embed-admin-page.mjs 参照）ので、トップレベル(/)は無い。
      input: {
        admin: resolve(__dirname, "admin.html"),
      },
    },
  },
});
