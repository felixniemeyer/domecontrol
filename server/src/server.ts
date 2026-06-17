import { PeerServer } from 'peer'
import { createArtworkRegistry } from './registry.ts'
import os from 'node:os'

const port = Number(process.env.PORT ?? 8081)
// Default to 0.0.0.0 so phones on the same WiFi/LAN can reach the PeerJS broker and registry.
// Override with HOST=127.0.0.1 for purely local dev if desired.
const host = process.env.HOST ?? '0.0.0.0'
const path = process.env.PEER_PATH ?? '/peerjs'
const webrtcLogEnabled = process.env.WEBRTC_LOG === '1'

// Registry runs on its own port to avoid contending with PeerJS for the
// shared HTTP server's 'upgrade' event. Controllers behind an https dev server
// reach it through a ws-proxy; http artworks connect directly.
const registryPort = Number(process.env.REGISTRY_PORT ?? 8082)
// Keep in sync with REGISTRY_PATH in @dome-control/runtime.
const registryPath = process.env.REGISTRY_PATH ?? '/registry'

// LAN (default) tells peers to skip STUN/TURN — host/mDNS candidates connect
// directly on a local network and need no internet. WAN supplies STUN (or a
// custom set via ICE_SERVERS as a JSON array) for NAT traversal.
const networkMode: 'lan' | 'wan' = (process.env.NETWORK_MODE ?? 'lan').toLowerCase() === 'wan' ? 'wan' : 'lan'
const wanIceServers: unknown[] = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: 'stun:stun.l.google.com:19302' }]
const iceServers: unknown[] = networkMode === 'wan' ? wanIceServers : []

let lastLogSignature: string | null = null
let repeatedLogCount = 0

function timestamp() {
  return new Date().toISOString()
}

function flushRepeatedLogs() {
  if (repeatedLogCount === 0) return
  console.info(`[${timestamp()}] [dome-control/server] multiple identical log messages suppressed`, {
    count: repeatedLogCount,
  })
  repeatedLogCount = 0
}

function logMessage(event: string, data?: Record<string, unknown>, always = false) {
  const payload = data ?? {}
  const signature = JSON.stringify({ event, payload })

  if (!always && signature === lastLogSignature) {
    repeatedLogCount += 1
    return
  }

  flushRepeatedLogs()
  lastLogSignature = signature
  console.info(`[${timestamp()}] [dome-control/server] ${event}`, payload)
}

function logWebRtc(event: string, data?: Record<string, unknown>) {
  if (!webrtcLogEnabled) return
  logMessage(event, data)
}

function logConnection(event: string, data?: Record<string, unknown>) {
  logMessage(event, data)
}

const peerServer = PeerServer({
  host,
  port,
  path,
  allow_discovery: false,
  proxied: false,
})

peerServer.on('connection', (client) => {
  logConnection('peer-connected', {
    peerId: client.getId(),
  })
})

peerServer.on('disconnect', (client) => {
  logConnection('peer-disconnected', {
    peerId: client.getId(),
  })
})

peerServer.on('message', (_client, message) => {
  if (message.type === 'HEARTBEAT') {
    return
  }
  logWebRtc('peer-message', {
    type: message.type,
    src: message.src,
    dst: message.dst,
  })
})

peerServer.on('error', (error) => {
  flushRepeatedLogs()
  lastLogSignature = null
  console.error(`[${timestamp()}] [dome-control/server] error`, error)
})

// Artwork registry (discovery only; controller input stays peer-to-peer).
createArtworkRegistry({ host, port: registryPort, path: registryPath, mode: networkMode, iceServers, log: logConnection })

flushRepeatedLogs()
lastLogSignature = null
console.info(`[${timestamp()}] [dome-control-server] listening on http://${host}:${port}${path}`)
console.info(`[${timestamp()}] [dome-control-server] registry listening on ws://${host}:${registryPort}${registryPath} (mode: ${networkMode})`)
if (networkMode === 'lan') {
  console.info(`[${timestamp()}] [dome-control-server] LAN mode: no ICE servers. Controllers and artworks must be on the same local network.`)
}

// Print reachable addresses (helps exhibit setup on local WiFi).
const nets = os.networkInterfaces()
const addrs: string[] = []
for (const name of Object.keys(nets)) {
  for (const net of nets[name] || []) {
    if (net.family === 'IPv4' && !net.internal) {
      addrs.push(`http://${net.address}:${port}${path}`)
      addrs.push(`ws://${net.address}:${registryPort}${registryPath}`)
    }
  }
}
if (addrs.length > 0) {
  console.info(`[${timestamp()}] [dome-control-server] reachable addresses (point QRs and clients here):`)
  for (const a of addrs) console.info(' ', a)
}
