import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev: Vite serves the app on :5173 and proxies API + engine traffic to the
// zero-dependency sidecar on :8787. Production: the sidecar hosts dist/ and
// serves /api, /v1, /health from one process (single-origin, no proxy needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/health': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    // Split heavy vendor libraries into their own chunks so no single file trips
    // Vite's 500 kB warning and so browsers can cache them independently.
    rollupOptions: {
      output: {
        manualChunks: {
          markdown: ['react-markdown', 'remark-gfm', 'highlight.js'],
          icons: ['lucide-react'],
          radix: ['@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-switch'],
        },
      },
    },
  },
});
