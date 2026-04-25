import { PeerServer } from 'peer'

const port = Number(process.env.PORT ?? 8081)
const host = process.env.HOST ?? '127.0.0.1'
const path = process.env.PEER_PATH ?? '/peerjs'
const webrtcLogEnabled = process.env.WEBRTC_LOG === '1'

function logWebRtc(event: string, data?: Record<string, unknown>) {
  if (!webrtcLogEnabled) return
  console.info(`[dome-control/server] ${event}`, data ?? {})
}

const peerServer = PeerServer({
  host,
  port,
  path,
  allow_discovery: false,
  proxied: false,
})

peerServer.on('connection', (client) => {
  logWebRtc('peer-connected', {
    peerId: client.getId(),
  })
})

peerServer.on('disconnect', (client) => {
  logWebRtc('peer-disconnected', {
    peerId: client.getId(),
  })
})

peerServer.on('message', (_client, message) => {
  logWebRtc('peer-message', {
    type: message.type,
    src: message.src,
    dst: message.dst,
  })
})

peerServer.on('error', (error) => {
  console.error('[dome-control/server] error', error)
})

console.info(`[dome-control-server] listening on http://${host}:${port}${path}`)
