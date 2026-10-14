import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// A stamp unique to each build. It's baked into the app (as __BUILD_ID__) and
// also written to /version.json, which is never cached. The running app
// compares the two, so it knows a newer build exists even when the service
// worker's own update check is stuck, throttled, or suspended — which is
// what phones do to apps sitting in the background.
const BUILD_ID = String(Date.now())
const emitVersionFile = () => ({
  name: 'emit-version-json',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
  }
})

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [
    react(),
    emitVersionFile(),
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
