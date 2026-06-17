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

function resolveHost() {
  const i = process.argv.indexOf('--host')
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1]
  }
  const env = process.env.HOST
  return env || undefined
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
const host = resolveHost()
server.on('error', (err) => {
  if (err.code === 'EACCES') {
    console.error(`[dome-control-client] Permission denied (EACCES) binding to port ${port}.`);
    console.error('  Run with sudo, or grant permanent permission with:');
    console.error(`    sudo setcap 'cap_net_bind_service=+ep' $(which node)`);
    console.error('  Or set a higher port with UI_PORT=8080 .');
  } else {
    console.error(err);
  }
  process.exit(1);
});
server.listen(port, host, () => {
  const portStr = (port == 80) ? '' : `:${port}`;
  const pw = process.env.EXHIBIT_PASSWORD || process.env.PASSWORD
  const pwSuffix = pw ? `?password=${encodeURIComponent(pw)}` : ''

  if (host && host !== '0.0.0.0') {
    console.log(`[dome-control-client] serving ${root} on http://${host}${portStr}/`)
  } else {
    // Print LAN addresses for phones on the local WiFi / exhibit network.
    const nets = os.networkInterfaces()
    const addrs = []
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          addrs.push(`http://${net.address}${portStr}/`)   // laptop mode is default; add ?osensor for orientation sensors
        }
      }
    }
    if (addrs.length) {
      console.log('[dome-control-client] LAN URLs for phones (use one in the QR codes):')
      for (const a of addrs) console.log('  ', a + pwSuffix)
    }
  }
  console.log('[dome-control-client] Laptop/joystick mode is default (no param needed). Use ?osensor for phone orientation sensors.')
  console.log('[dome-control-client] Tip for direct connect: add &artwork-peer=<id>&session=<id> (and &password=... if protected)')
})
