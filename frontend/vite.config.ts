import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 允许读取仓库根下的 shared/ 类型定义
    fs: { allow: ['..'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  worker: { format: 'es' },
});
