import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // autoUpdate: a new deploy installs, takes over and reloads the page on its
      // own — no waiting-worker/banner step, which is what used to leave the
      // old version showing until an incognito window got around it.
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'AIO',
        short_name: 'AIO',
        description: 'Irrigation, fertilizer, chemical, and field work tracking for Jentzsch-Kearl Farms',
        theme_color: '#185FA5',
        background_color: '#f4f2ec',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      },
      workbox: {
        // Cache the app shell aggressively so it loads with zero signal.
        // Firestore's own SDK handles offline data caching separately.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin.includes('firestore.googleapis.com'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'firestore-fallback',
              networkTimeoutSeconds: 3
            }
          }
        ]
      }
    })
  ]
})
