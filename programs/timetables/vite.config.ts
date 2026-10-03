import { resolve } from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // 管理画面(/admin)は利用者向けの画面とは別ページにする（利用者向けのJSに管理用コードを混ぜない）
      input: {
        main: resolve(__dirname, "index.html"),
        admin: resolve(__dirname, "admin.html"),
        // プライバシーポリシー（スクリプトの無い、文章だけのページ）。/privacy で開ける
        privacy: resolve(__dirname, "privacy.html"),
      },
    },
  },
});
