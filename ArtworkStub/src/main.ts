import { DataConnection, Peer } from 'peerjs'
import {
  fetchServerConfig,
  registerArtwork,
  REGISTRY_PATH,
  type ArtworkRegistration,
  type ControllerAlignmentCross,
  type ControllerInputPacket,
  type ControllerInputState,
  type ControllerPlayerState,
  type ControllerSessionState,
  type ControllerTransport,
  type DomeControlPacket,
} from '@dome-control/runtime'

declare global {
  interface Window {
    domeControlRuntime?: {
      getSessionState: () => ControllerSessionState
      getGameSnapshot: () => {
        alignmentCross: ControllerAlignmentCross | null
        players: ControllerPlayerState[]
      }
    }
  }
}

type StubPlayer = ControllerPlayerState

const query = new URLSearchParams(window.location.search)
const sessionId = query.get('session') ?? 'fabric-artwork-local'
const artworkName = query.get('name') ?? 'Artwork Stub'
const artworkPeerId = query.get('artwork-peer') ?? `artwork-${Math.random().toString(36).slice(2, 10)}`
const exhibitPassword = query.get('password') || query.get('pw') || undefined
const peerHost = window.location.hostname || '127.0.0.1'
const peerSecure = window.location.protocol === 'https:'
const peerPort = Number(import.meta.env.VITE_PEER_PORT ?? (peerSecure ? window.location.port || 443 : 8081))
const registryPort = Number(import.meta.env.VITE_REGISTRY_PORT ?? 8082)
const peerPath = '/peerjs'

const statusElement = document.getElementById('status') as HTMLParagraphElement
const stateElement = document.getElementById('state') as HTMLPreElement

const players = new Map<string, StubPlayer>()
const controllerPeers = new Map<string, string>()
const peerControllers = new Map<string, string>()

let peer: Peer | null = null
let transport: ControllerTransport = 'debug-local'
let alignmentCross: ControllerAlignmentCross | null = null
let peerReconnectTimer: number | null = null
let registration: ArtworkRegistration | null = null
let iceServers: RTCIceServer[] | null = null

function nowSeconds() {
  return performance.now() * 0.001
}

function renderState() {
  statusElement.textContent = `${transport} · ${artworkPeerId}`
  stateElement.textContent = JSON.stringify(
    {
      sessionId,
      artworkPeerId,
      transport,
      alignmentCross,
      players: Array.from(players.values()),
    },
    null,
    2,
  )
}

function upsertPlayer(controllerId: string, input: ControllerInputState) {
  const existing = players.get(controllerId)
  const sentAt = input.sentAt ?? nowSeconds()
  const next: StubPlayer = {
    id: controllerId,
    direction: [input.direction[0], input.direction[1], input.direction[2]],
    buttons: { accelerate: input.accelerate },
    color: input.color ?? existing?.color ?? '#8bd3ff',
    colorRgb: existing?.colorRgb ?? [0.545, 0.827, 1],
    cursorAlpha: existing?.cursorAlpha ?? 0,
    pressAlpha: input.accelerate ? 1 : 0,
    inactivityAlpha: 1,
    lastHeartbeatAt: sentAt,
    lastInputAt: sentAt,
  }
  players.set(controllerId, next)
  renderState()
}

function removePlayer(controllerId: string) {
  players.delete(controllerId)
  renderState()
}

function releaseControllerPeer(controllerId: string, remotePeerId: string, remove = true) {
  const currentPeerId = controllerPeers.get(controllerId)
  if (currentPeerId === remotePeerId) {
    controllerPeers.delete(controllerId)
    if (remove) {
      removePlayer(controllerId)
    }
  }
  if (peerControllers.get(remotePeerId) === controllerId) {
    peerControllers.delete(remotePeerId)
  }
}

function adoptControllerPeer(controllerId: string, remotePeerId: string) {
  const existingPeerId = controllerPeers.get(controllerId)
  if (existingPeerId && existingPeerId !== remotePeerId) {
    peerControllers.delete(existingPeerId)
  }
  controllerPeers.set(controllerId, remotePeerId)
  peerControllers.set(remotePeerId, controllerId)
}

function attachConnection(connection: DataConnection) {
  const remotePeerId = connection.peer
  const metadataSessionId = connection.metadata?.sessionId
  const metadataPassword = connection.metadata?.password || connection.metadata?.pw
  if (metadataSessionId && metadataSessionId !== sessionId) {
    connection.close()
    return
  }
  if (exhibitPassword && metadataPassword !== exhibitPassword) {
    connection.close()
    return
  }

  connection.on('open', () => {
    transport = 'webrtc'
    renderState()
  })

  connection.on('data', (data) => {
    if (!data || typeof data !== 'object') return
    const packet = data as Partial<DomeControlPacket>
    if (packet.sessionId !== sessionId || typeof packet.type !== 'string') return
    if (typeof packet.controllerId !== 'string') return

    const controllerId = packet.controllerId
    adoptControllerPeer(controllerId, remotePeerId)

    if (packet.type === 'controller-input') {
      const controllerInput = data as ControllerInputPacket
      transport = 'webrtc'
      upsertPlayer(controllerId, controllerInput.input)
      return
    }

    if (packet.type === 'controller-goodbye') {
      releaseControllerPeer(controllerId, remotePeerId, true)
      return
    }

    if (packet.type === 'controller-alignment') {
      transport = 'webrtc'
      alignmentCross = packet.cross ?? null
      renderState()
    }
  })

  connection.on('close', () => {
    const controllerId = peerControllers.get(remotePeerId)
    if (controllerId) {
      releaseControllerPeer(controllerId, remotePeerId, true)
    }
    if (peerControllers.size === 0) {
      transport = 'debug-local'
      renderState()
    }
  })
}

function clearReconnectTimer() {
  if (peerReconnectTimer != null) {
    window.clearTimeout(peerReconnectTimer)
    peerReconnectTimer = null
  }
}

function scheduleReconnect(delayMs = 1500) {
  if (peerReconnectTimer != null) return
  peerReconnectTimer = window.setTimeout(() => {
    peerReconnectTimer = null
    connectPeer()
  }, delayMs)
}

function destroyPeer() {
  clearReconnectTimer()
  peer?.destroy()
  peer = null
}

function registryUrl() {
  return peerSecure
    ? `wss://${window.location.host}${REGISTRY_PATH}`
    : `ws://${peerHost}:${registryPort}${REGISTRY_PATH}`
}

function ensureRegistered() {
  if (registration) return
  registration = registerArtwork({
    url: registryUrl(),
    id: artworkPeerId,
    name: artworkName,
    sessionId,
    credential: exhibitPassword,
  })
}

async function connectPeer() {
  destroyPeer()

  if (iceServers === null) {
    iceServers = (await fetchServerConfig(registryUrl())).iceServers
  }

  const nextPeer = new Peer(artworkPeerId, {
    host: peerHost,
    port: peerPort,
    path: peerPath,
    secure: peerSecure,
    config: { iceServers: iceServers ?? [] },
  })
  peer = nextPeer

  nextPeer.on('open', () => {
    ensureRegistered()
    renderState()
  })

  nextPeer.on('connection', (connection) => {
    if (peer !== nextPeer) {
      connection.close()
      return
    }
    attachConnection(connection)
  })

  nextPeer.on('disconnected', () => {
    if (peer !== nextPeer) return
    scheduleReconnect()
  })

  nextPeer.on('close', () => {
    if (peer !== nextPeer) return
    scheduleReconnect()
  })

  nextPeer.on('error', () => {
    if (peer !== nextPeer) return
    scheduleReconnect()
  })
}

window.domeControlRuntime = {
  getSessionState: () => ({
    sessionId,
    transport,
    players: Array.from(players.values()),
    updatedAt: nowSeconds(),
  }),
  getGameSnapshot: () => ({
    alignmentCross,
    players: Array.from(players.values()),
  }),
}

window.addEventListener('beforeunload', () => {
  registration?.dispose()
  destroyPeer()
})

renderState()
connectPeer()
