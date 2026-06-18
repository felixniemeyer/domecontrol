// Transport abstraction shared by the WebSocket relay path and the (legacy,
// still-selectable) WebRTC path. The protocol is controller -> artwork ONLY, so
// the client never receives anything — this is deliberately the small subset of
// PeerJS `DataConnection` the client already used. Three concerns: discover,
// connect, send.

import type { ArtworkDescriptor } from './registry.js'
import type { DomeControlPacket } from './packets.js'

export type TransportKind = 'websocket' | 'webrtc'

/** Discovery. WebRTC wraps the registry; the WS relay yields a single fixed artwork. */
export interface ArtworkDirectory {
  onUpdate(cb: (artworks: ArtworkDescriptor[]) => void): void
  dispose(): void
}

/** Controller-side connection. Every send (input/alignment/goodbye) goes through send(). */
export interface DomeControlConnection {
  readonly open: boolean
  send(packet: DomeControlPacket): void
  close(): void
  on(event: 'open' | 'close' | 'error', cb: (...args: any[]) => void): void
}

export type ConnectOptions = {
  sessionId: string
  controllerId: string
  color?: string
  credential?: string
}

/** Per-transport client factory. */
export interface DomeControlClientTransport {
  openDirectory(): ArtworkDirectory
  connect(artworkId: string, opts: ConnectOptions): DomeControlConnection
}

/** Artwork/host side — the receive mirror consumed by the artwork adapters. */
export interface ArtworkHostConnection {
  onPacket(cb: (packet: DomeControlPacket) => void): void
  onControllerGone(cb: (controllerId: string) => void): void
  close(): void
}
