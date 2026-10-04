import { defineConfig } from 'vite';

// The service worker is a separate classic script so it has no module imports.
export default defineConfig({
  publicDir: false,
  build: {
    target: 'es2022',
    emptyOutDir: false,
    copyPublicDir: false,
    lib: {
      entry: 'src/sw.ts',
      formats: ['iife'],
      name: 'sipsterSw',
      fileName: () => 'sw.js',
    },
  },
});
