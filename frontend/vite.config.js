import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:8090';

export default defineConfig({
  server: {
    host: true,
    proxy: { '/api': api, '/media': api },
    fs: { allow: ['..'] },
  },
  build: {
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, 'index.html'),
        booth: resolve(import.meta.dirname, 'booth/index.html'),
        result: resolve(import.meta.dirname, 's/index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
        notfound: resolve(import.meta.dirname, '404.html'),
      },
    },
  },
});
