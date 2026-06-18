// WebSocket relay transport. Replaces the WebRTC data channel for the exhibit:
// the artwork connects once as the session "host"; visitors connect as
// "controllers"; the relay forwards controller -> host only. See ws-relay.ts on
// the server for the matching hub.
//
// Hot-path input is binary (see codec.ts); the rare alignment/goodbye packets
// are JSON text frames. The controller send queue holds at most ONE pending
// input, overwritten with the latest, flushed only when the socket has drained
// (bufferedAmount === 0) — coalescing to avoid back-pressure under load.

import { DOME_CONTROL_PROTOCOL, type DomeControlPacket } from './packets.js'
import type { ControllerInputState } from './types.js'
import type {
  ArtworkDirectory,
  ArtworkHostConnection,
  ConnectOptions,
  DomeControlClientTransport,
  DomeControlConnection,
} from './transport.js'
import { CONTROLLER_INDEX_BYTES, decodeControllerInput, encodeControllerInput, readControllerIndex } from './codec.js'

// --- relay <-> host control messages (mirrored in server/src/ws-relay.ts) ----

type ControllerJoinMessage = { kind: 'controller-join'; idx: number; controllerId: string; color?: string }
type ControllerLeaveMessage = { kind: 'controller-leave'; idx: number; controllerId: string }
type HostControlMessage = ControllerJoinMessage | ControllerLeaveMessage

function buildControllerUrl(relayUrl: string, opts: ConnectOptions): string {
  const url = new URL(relayUrl)
  url.searchParams.set('role', 'controller')
  url.searchParams.set('session', opts.sessionId)
  url.searchParams.set('controllerId', opts.controllerId)
  if (opts.color) url.searchParams.set('color', opts.color)
  if (opts.credential) url.searchParams.set('password', opts.credential)
  return url.toString()
}

// --- controller side ---------------------------------------------------------

class WebSocketDomeConnection implements DomeControlConnection {
  private readonly ws: WebSocket
  private pendingInput: ControllerInputState | null = null
  private readonly listeners: Record<'open' | 'close' | 'error', Array<(...a: any[]) => void>> = {
    open: [], close: [], error: [],
  }

  constructor(relayUrl: string, opts: ConnectOptions) {
    this.ws = new WebSocket(buildControllerUrl(relayUrl, opts))
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('open', (e) => { this.tryFlush(); this.emit('open', e) })
    this.ws.addEventListener('close', (e) => this.emit('close', e))
    this.ws.addEventListener('error', (e) => this.emit('error', e))
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN
  }

  send(packet: DomeControlPacket): void {
    if (packet.type === 'controller-input') {
      this.pendingInput = packet.input
      this.tryFlush()
      return
    }
    // alignment / goodbye: rare, send immediately as JSON
    if (this.open) this.ws.send(JSON.stringify(packet))
  }

  private tryFlush(): void {
    if (!this.open || this.ws.bufferedAmount > 0 || !this.pendingInput) return
    this.ws.send(encodeControllerInput(this.pendingInput))
    this.pendingInput = null
  }

  on(event: 'open' | 'close' | 'error', cb: (...args: any[]) => void): void {
    this.listeners[event].push(cb)
  }

  private emit(event: 'open' | 'close' | 'error', ...args: any[]): void {
    for (const cb of this.listeners[event]) cb(...args)
  }

  close(): void {
    this.ws.close()
  }
}

export class WebSocketClientTransport implements DomeControlClientTransport {
  constructor(private readonly relayUrl: string, private readonly session: string) {}

  openDirectory(): ArtworkDirectory {
    // Fixed endpoint: a single, always-present artwork. The client auto-connects
    // when the directory yields exactly one entry.
    const session = this.session
    return {
      onUpdate(cb) { cb([{ id: session, name: session, sessionId: session }]) },
      dispose() {},
    }
  }

  connect(_artworkId: string, opts: ConnectOptions): DomeControlConnection {
    return new WebSocketDomeConnection(this.relayUrl, opts)
  }
}

// --- artwork / host side -----------------------------------------------------

export type WebSocketHostOptions = {
  relayUrl: string
  session: string
  credential?: string
  reconnectDelayMs?: number
}

export class WebSocketArtworkHost implements ArtworkHostConnection {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly idxTable = new Map<number, { controllerId: string; color?: string }>()
  private packetCb: ((packet: DomeControlPacket) => void) | null = null
  private goneCb: ((controllerId: string) => void) | null = null
  private readonly reconnectDelayMs: number

  constructor(private readonly opts: WebSocketHostOptions) {
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 1500
    this.connect()
  }

  onPacket(cb: (packet: DomeControlPacket) => void): void { this.packetCb = cb }
  onControllerGone(cb: (controllerId: string) => void): void { this.goneCb = cb }

  private connect(): void {
    if (this.disposed) return
    const url = new URL(this.opts.relayUrl)
    url.searchParams.set('role', 'host')
    url.searchParams.set('session', this.opts.session)
    if (this.opts.credential) url.searchParams.set('password', this.opts.credential)
    const ws = new WebSocket(url.toString())
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('message', (event) => this.handleMessage(event))
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = null
      this.idxTable.clear()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => ws.close())
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectDelayMs <= 0 || this.reconnectTimer != null) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelayMs)
  }

  private handleMessage(event: MessageEvent): void {
    const data = event.data
    if (typeof data === 'string') {
      this.handleText(data)
      return
    }
    // binary: [uint16 idx][input frame]
    const buffer = data as ArrayBuffer
    if (buffer.byteLength < CONTROLLER_INDEX_BYTES) return
    const { idx, payload } = readControllerIndex(buffer)
    const entry = this.idxTable.get(idx)
    if (!entry) return
    const input = decodeControllerInput(payload)
    if (entry.color) input.color = entry.color
    this.packetCb?.({
      protocol: DOME_CONTROL_PROTOCOL,
      type: 'controller-input',
      sessionId: this.opts.session,
      controllerId: entry.controllerId,
      input,
    })
  }

  private handleText(raw: string): void {
    let message: HostControlMessage | DomeControlPacket
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if ('kind' in message) {
      if (message.kind === 'controller-join') {
        this.idxTable.set(message.idx, { controllerId: message.controllerId, color: message.color })
      } else if (message.kind === 'controller-leave') {
        this.idxTable.delete(message.idx)
        this.goneCb?.(message.controllerId)
      }
      return
    }
    // forwarded controller packet (alignment / goodbye)
    if ('type' in message) this.packetCb?.(message)
  }

  close(): void {
    this.disposed = true
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
  }
}
