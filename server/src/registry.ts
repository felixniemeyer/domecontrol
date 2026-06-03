import { WebSocketServer, type WebSocket } from 'ws'

// Artwork registry: artworks advertise { id, name, sessionId } (unique name);
// controllers subscribe to receive the live list and pick one. An artwork is
// dropped as soon as its socket closes — discovery only, the input path stays
// peer-to-peer. The wire shapes here mirror @dome-control/runtime's registry.

export type RegistryLogger = (event: string, data?: Record<string, unknown>) => void

export type ArtworkRegistryOptions = {
  host: string
  port: number
  path: string
  /** Announced to every peer on connect so they configure ICE accordingly. */
  mode: 'lan' | 'wan'
  iceServers: unknown[]
  log?: RegistryLogger
}

type RegisteredArtwork = { id: string; name: string; sessionId: string; socket: WebSocket }

export function createArtworkRegistry(options: ArtworkRegistryOptions): WebSocketServer {
  const { host, port, path, mode, iceServers } = options
  const log: RegistryLogger = options.log ?? (() => {})
  const artworksByName = new Map<string, RegisteredArtwork>()
  const directorySubscribers = new Set<WebSocket>()

  const directorySnapshot = () =>
    Array.from(artworksByName.values()).map(({ id, name, sessionId }) => ({ id, name, sessionId }))

  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
  }

  const broadcastDirectory = () => {
    const message = { kind: 'directory', artworks: directorySnapshot() }
    for (const socket of directorySubscribers) send(socket, message)
  }

  const server = new WebSocketServer({ host, port, path })

  server.on('connection', (socket) => {
    let registeredName: string | null = null

    // Tell every peer the ICE config up front (before it creates its peer).
    send(socket, { kind: 'server-config', mode, iceServers })

    socket.on('message', (raw) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!message || typeof message.kind !== 'string') return

      if (message.kind === 'artwork-register') {
        const { id, name, sessionId } = message
        if (typeof id !== 'string' || typeof name !== 'string' || typeof sessionId !== 'string') return
        const existing = artworksByName.get(name)
        if (existing && existing.socket !== socket) {
          send(socket, { kind: 'register-rejected', reason: 'name-taken' })
          log('artwork-rejected', { name, reason: 'name-taken' })
          return
        }
        registeredName = name
        artworksByName.set(name, { id, name, sessionId, socket })
        send(socket, { kind: 'register-ok' })
        log('artwork-registered', { name, id })
        broadcastDirectory()
        return
      }

      if (message.kind === 'directory-subscribe') {
        directorySubscribers.add(socket)
        send(socket, { kind: 'directory', artworks: directorySnapshot() })
      }
    })

    socket.on('close', () => {
      directorySubscribers.delete(socket)
      if (registeredName) {
        const current = artworksByName.get(registeredName)
        if (current && current.socket === socket) {
          artworksByName.delete(registeredName)
          log('artwork-dropped', { name: registeredName })
          broadcastDirectory()
        }
      }
    })

    socket.on('error', () => socket.close())
  })

  return server
}
