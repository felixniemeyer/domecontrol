import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

const peerTargetHost = process.env.PEER_PROXY_HOST ?? '127.0.0.1'
const peerTargetPort = process.env.PEER_PROXY_PORT ?? '8081'

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    https: true,
    proxy: {
      '/peerjs': {
        target: `http://${peerTargetHost}:${peerTargetPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
