// Artwork registry: a small WebSocket protocol that lets each running artwork
// advertise itself on the dome-control server so controllers can discover and
// pick one. The actual controller -> artwork input stays peer-to-peer over
// WebRTC; the registry is only used for discovery (and the server drops an
// artwork as soon as its registry socket closes).

export const REGISTRY_PATH = '/registry'

/** A running artwork ("game") as advertised to controllers. */
export type ArtworkDescriptor = {
  /** Unique connection id — the PeerJS peer id controllers dial. */
  id: string
  /** Human-facing display name, unique across the registry. */
  name: string
  /** Session id controllers adopt so the artwork accepts their packets. */
  sessionId: string
}

// --- wire messages -------------------------------------------------------

/** artwork -> server: claim a name and advertise connection details. */
export type ArtworkRegisterMessage = { kind: 'artwork-register' } & ArtworkDescriptor & { credential?: string }

/** server -> artwork: registration accepted. */
export type RegisterOkMessage = { kind: 'register-ok' }

/** server -> artwork: registration refused. */
export type RegisterRejectedMessage = { kind: 'register-rejected'; reason: 'name-taken' | 'invalid-credential' }

/** controller -> server: ask for (and keep receiving) the live directory. */
export type DirectorySubscribeMessage = { kind: 'directory-subscribe'; credential?: string }

/** server -> controller: the current set of registered artworks. */
export type DirectoryMessage = { kind: 'directory'; artworks: ArtworkDescriptor[] }

export type NetworkMode = 'lan' | 'wan'

/** ICE configuration the server dictates: LAN omits STUN/TURN, WAN includes them. */
export type ServerConfig = {
  mode: NetworkMode
  iceServers: RTCIceServer[]
}

/** server -> peer: sent immediately on every registry connection. */
export type ServerConfigMessage = { kind: 'server-config' } & ServerConfig

export type RegistryMessage =
  | ArtworkRegisterMessage
  | RegisterOkMessage
  | RegisterRejectedMessage
  | DirectorySubscribeMessage
  | DirectoryMessage
  | ServerConfigMessage

export function parseRegistryMessage(data: unknown): RegistryMessage | null {
  if (typeof data !== 'string') return null
  try {
    const parsed = JSON.parse(data) as RegistryMessage
    return parsed && typeof parsed.kind === 'string' ? parsed : null
  } catch {
    return null
  }
}

// --- artwork side --------------------------------------------------------

export type ArtworkRegistration = {
  /** Stop advertising and close the registry socket (server then drops us). */
  dispose: () => void
}

export type RegisterArtworkOptions = ArtworkDescriptor & {
  /** ws(s):// URL of the registry endpoint (server origin + REGISTRY_PATH). */
  url: string
  /** Shared secret for exhibit / protected broker. Passed as `?password=...` in client URLs. */
  credential?: string
  /** Called when the name is refused. Defaults to a console error. */
  onRejected?: (reason: RegisterRejectedMessage['reason']) => void
  /** Called once the server confirms the registration. */
  onRegistered?: () => void
  /** Auto-reconnect delay in ms (<= 0 disables). Defaults to 1500. */
  reconnectDelayMs?: number
}

export function registerArtwork(options: RegisterArtworkOptions): ArtworkRegistration {
  const { url, id, name, sessionId, credential } = options
  const reconnectDelayMs = options.reconnectDelayMs ?? 1500
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const scheduleReconnect = () => {
    if (disposed || reconnectDelayMs <= 0 || reconnectTimer != null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelayMs)
  }

  const connect = () => {
    if (disposed) return
    const ws = new WebSocket(url)
    socket = ws
    ws.addEventListener('open', () => {
      const message: ArtworkRegisterMessage = { kind: 'artwork-register', id, name, sessionId, ...(credential ? { credential } : {}) }
      ws.send(JSON.stringify(message))
    })
    ws.addEventListener('message', (event) => {
      const message = parseRegistryMessage(event.data)
      if (!message) return
      if (message.kind === 'register-ok') {
        options.onRegistered?.()
      } else if (message.kind === 'register-rejected') {
        if (options.onRejected) options.onRejected(message.reason)
        else console.error(`[dome-control/registry] registration rejected (${message.reason}) for name "${name}"`)
      }
    })
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null
      scheduleReconnect()
    })
    ws.addEventListener('error', () => ws.close())
  }

  connect()

  return {
    dispose: () => {
      disposed = true
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      socket?.close()
      socket = null
    },
  }
}

// --- shared: ICE config --------------------------------------------------

// The server decides LAN vs WAN; peers fetch this before creating their
// PeerJS peer so ICE gathering matches the deployment (LAN => no STUN/TURN).
// Falls back to a LAN-safe empty config if the registry is unreachable.
export function fetchServerConfig(url: string, timeoutMs = 2000): Promise<ServerConfig> {
  const fallback: ServerConfig = { mode: 'lan', iceServers: [] }
  return new Promise((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch {
      resolve(fallback)
      return
    }
    let settled = false
    const finish = (config: ServerConfig) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // ignore
      }
      resolve(config)
    }
    const timer = setTimeout(() => finish(fallback), timeoutMs)
    socket.addEventListener('message', (event) => {
      const message = parseRegistryMessage(event.data)
      if (message?.kind === 'server-config') finish({ mode: message.mode, iceServers: message.iceServers })
    })
    socket.addEventListener('error', () => finish(fallback))
    socket.addEventListener('close', () => finish(fallback))
  })
}

// --- controller side -----------------------------------------------------

export type ArtworkDirectorySubscription = {
  dispose: () => void
}

export type SubscribeArtworkDirectoryOptions = {
  /** ws(s):// URL of the registry endpoint (server origin + REGISTRY_PATH). */
  url: string
  /** Called with the full artwork list on every change (empty when offline). */
  onUpdate: (artworks: ArtworkDescriptor[]) => void
  /** Shared secret for exhibit / protected broker. */
  credential?: string
  /** Auto-reconnect delay in ms (<= 0 disables). Defaults to 1500. */
  reconnectDelayMs?: number
}

export function subscribeArtworkDirectory(
  options: SubscribeArtworkDirectoryOptions,
): ArtworkDirectorySubscription {
  const { url, onUpdate, credential } = options
  const reconnectDelayMs = options.reconnectDelayMs ?? 1500
  let socket: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const scheduleReconnect = () => {
    if (disposed || reconnectDelayMs <= 0 || reconnectTimer != null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, reconnectDelayMs)
  }

  const connect = () => {
    if (disposed) return
    const ws = new WebSocket(url)
    socket = ws
    ws.addEventListener('open', () => {
      const message: DirectorySubscribeMessage = { kind: 'directory-subscribe', ...(credential ? { credential } : {}) }
      ws.send(JSON.stringify(message))
    })
    ws.addEventListener('message', (event) => {
      const message = parseRegistryMessage(event.data)
      if (message?.kind === 'directory') onUpdate(message.artworks)
    })
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null
      // Lost the registry — surface "nothing available" until we reconnect.
      onUpdate([])
      scheduleReconnect()
    })
    ws.addEventListener('error', () => ws.close())
  }

  connect()

  return {
    dispose: () => {
      disposed = true
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      socket?.close()
      socket = null
    },
  }
}
