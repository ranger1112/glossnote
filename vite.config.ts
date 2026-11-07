import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // 这两个库按需加载；预先纳入预构建，避免首次打开 HTML / EPUB 时整页刷新。
  optimizeDeps: { include: ['@mozilla/readability', 'jszip'] },
  server: {
    port: 1420,
    strictPort: true,
    // Rust 构建产物会频繁写入，没必要让 Vite 因此整页刷新。
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
