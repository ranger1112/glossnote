import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Readability 首次被发现时 Vite 会重新预构建并整页刷新，预先纳入避免打断 e2e。
  optimizeDeps: { include: ['@mozilla/readability'] },
  server: {
    port: 1420,
    strictPort: true,
    // Rust 构建产物会频繁写入，没必要让 Vite 因此整页刷新。
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
