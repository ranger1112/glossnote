import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    // Rust 构建产物会频繁写入，没必要让 Vite 因此整页刷新。
    watch: { ignored: ['**/src-tauri/**'] },
  },
});
