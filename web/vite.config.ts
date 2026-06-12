import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// API base URL is injected at build time (the API Gateway URL from GardenApi, Phase 3).
// During local dev it falls back to a proxy or env var.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
