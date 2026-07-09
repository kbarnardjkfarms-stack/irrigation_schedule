import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Grindstone Irrigation Schedule',
        short_name: 'Irrigation',
        description: 'Field irrigation & crew schedule for Kurl Farms',
        theme_color: '#2f5233',
        background_color: '#f7f5f0',
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
