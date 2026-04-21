import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  /** `.env` 放在本目录（与仓库一起克隆时在项目根配置即可） */
  envDir: __dirname,
  server: {
    port: 5173,
    open: true,
  },
});
