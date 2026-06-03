import { createRequire } from 'node:module'
import path from 'node:path'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const peerTargetHost = process.env.PEER_PROXY_HOST ?? '127.0.0.1'
const peerTargetPort = process.env.PEER_PROXY_PORT ?? '8081'
const registryTargetPort = process.env.REGISTRY_PROXY_PORT ?? '8082'

export default defineConfig({
  plugins: [basicSsl()],
  resolve: {
    alias: {
      // Dev against runtime source so registry changes are picked up live.
      '@dome-control/runtime': path.join(
        path.dirname(require.resolve('@dome-control/runtime/package.json')),
        'src/index.ts',
      ),
    },
  },
  server: {
    https: true,
    proxy: {
      '/peerjs': {
        target: `http://${peerTargetHost}:${peerTargetPort}`,
        changeOrigin: true,
        ws: true,
      },
      '/registry': {
        target: `ws://${peerTargetHost}:${registryTargetPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
