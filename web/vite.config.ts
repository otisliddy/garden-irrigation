import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'Garden Irrigation',
        short_name: 'Irrigation',
        description: 'Solar-powered garden irrigation control — Glenealy, Ireland',
        theme_color: '#1b5e20',
        background_color: '#0d1f0e',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'] },
    }),
  ],
  build: { outDir: 'dist' },
});
