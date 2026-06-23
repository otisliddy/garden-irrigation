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
        // Firefox/Chrome on Android require raster PNGs (192 + 512) to create a
        // homescreen shortcut; an SVG-only icon set is silently rejected. The
        // maskable entry feeds Android's adaptive-icon mask without cropping the drop.
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        // Hashed assets are safe to precache; index.html is NOT — precaching it
        // serves a stale shell that points at old JS until the SW races a reload.
        globPatterns: ['**/*.{js,css,ico,png,svg,woff2}'],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallback: null,
        runtimeCaching: [
          {
            // Always fetch the freshest index.html when online; fall back to the
            // last-seen copy only when the network is unavailable.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-shell',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 1 },
            },
          },
        ],
      },
    }),
  ],
  build: { outDir: 'dist' },
});
