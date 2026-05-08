import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/peerjs': {
        target: 'http://127.0.0.1:8081',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})

