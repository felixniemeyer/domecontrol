#!/usr/bin/env node
// Zero-dependency static server for the built Vite app (dist/), with SPA
// fallback. Port via `--port <n>` or PORT env, else the default below.
//
// For exhibits: prints LAN IP URLs so phones on the same WiFi can reach it easily.
// Recommended controller URL: http://<ip>:<port>/?laptop=1&artwork-peer=xxx&session=yyy
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'
import os from 'node:os'

const DEFAULT_PORT = 4175
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

function resolvePort() {
  const i = process.argv.indexOf('--port')
  if (i >= 0 && process.argv[i + 1]) {
    const n = Number(process.argv[i + 1])
    if (Number.isFinite(n)) return n
  }
  const env = Number(process.env.PORT)
  return Number.isFinite(env) ? env : DEFAULT_PORT
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost')
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
    if (rel.includes('..')) { res.writeHead(403); res.end('forbidden'); return }
    let filePath = join(root, rel)
    let s = await stat(filePath).catch(() => null)
    if (s?.isDirectory()) { filePath = join(filePath, 'index.html'); s = await stat(filePath).catch(() => null) }
    if (!s) { filePath = join(root, 'index.html') } // SPA fallback
    const body = await readFile(filePath)
    res.writeHead(200, { 'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream' })
    res.end(body)
  } catch (err) {
    res.writeHead(500)
    res.end(String(err))
  }
})

const port = resolvePort()
server.listen(port, () => {
  console.log(`[dome-control-client] serving ${root} on http://localhost:${port}`)

  // Print LAN addresses for phones on the local WiFi / exhibit network.
  const nets = os.networkInterfaces()
  const addrs = []
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push(`http://${net.address}:${port}/?laptop=1`)
      }
    }
  }
  if (addrs.length) {
    console.log('[dome-control-client] LAN URLs for phones (use one in the QR codes):')
    for (const a of addrs) console.log('  ', a)
  }
  console.log('[dome-control-client] Tip for direct connect: add &artwork-peer=<id>&session=<id> to the URL')
})
