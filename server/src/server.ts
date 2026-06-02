import { PeerServer } from 'peer'

const port = Number(process.env.PORT ?? 8081)
const host = process.env.HOST ?? '127.0.0.1'
const path = process.env.PEER_PATH ?? '/peerjs'
const webrtcLogEnabled = process.env.WEBRTC_LOG === '1'

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

flushRepeatedLogs()
lastLogSignature = null
console.info(`[${timestamp()}] [dome-control-server] listening on http://${host}:${port}${path}`)
