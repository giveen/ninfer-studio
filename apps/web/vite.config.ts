import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The version shown in the header badge is injected at build time from the
// Tauri app config — the same value that names the release artifacts — so the
// UI can never drift from the shipped version again (the badge used to be a
// hardcoded "0.1.1" while the app released 0.1.4 → 0.2.0).
const here = dirname(fileURLToPath(import.meta.url));
const appVersion = (() => {
  try {
    const conf = JSON.parse(readFileSync(resolve(here, '../../desktop/app/tauri.conf.json'), 'utf8'));
    return typeof conf.version === 'string' ? conf.version : 'unknown';
  } catch {
    return 'unknown';
  }
})();

// Dev: Vite serves the app on :5173 and proxies API + engine traffic to the
// zero-dependency sidecar on :8787. Production: the sidecar hosts dist/ and
// serves /api, /v1, /health from one process (single-origin, no proxy needed).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
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
          codemirror: [
            '@uiw/react-codemirror',
            'codemirror',
            '@codemirror/lang-javascript',
            '@codemirror/lang-json',
            '@codemirror/lang-python',
            '@codemirror/lang-markdown',
            '@codemirror/lang-html',
            '@codemirror/lang-css',
            '@codemirror/lang-rust',
            '@codemirror/lang-cpp',
            '@codemirror/lang-java',
            '@codemirror/lang-sql',
            '@codemirror/lang-php',
            '@codemirror/lang-go',
            '@codemirror/lang-xml',
            '@codemirror/lang-yaml',
            '@codemirror/language',
            '@codemirror/state',
            '@codemirror/view',
            '@lezer/highlight',
          ],
          markdown: ['react-markdown', 'remark-gfm', 'highlight.js'],
          icons: ['lucide-react'],
          radix: ['@radix-ui/react-dialog', '@radix-ui/react-popover', '@radix-ui/react-switch'],
        },
      },
    },
  },
});
