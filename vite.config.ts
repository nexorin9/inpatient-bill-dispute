import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 渲染进程（收费员工作台）构建配置：本地相对路径，打包成桌面应用后直接以 file:// 加载
export default defineConfig({
  base: './',
  root: resolve(process.cwd(), 'src/renderer'),
  build: {
    outDir: resolve(process.cwd(), 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome128',
    assetsDir: 'assets',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
