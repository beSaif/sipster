import { defineConfig } from 'vite';

export default defineConfig({
  build: { target: 'es2022' },
  server: {
    host: true,
    // `npm run dev` serves the UI only. With `npm run worker:dev` running on :8787, the API answers
    // from there. The Host header is kept (localhost:5173) so the session cookie and the Google
    // sign-in callback belong to the dev server's origin.
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
