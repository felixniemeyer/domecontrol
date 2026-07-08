// Dome-control WebSocket player relay (LAN exhibit transport).
//
// A tiny hub that replaces the WebRTC data channel for player input. One artwork
// connects per session as the "host"; visitors connect as "controllers". The
// relay forwards controller -> host only (the protocol is one-directional).
//
//   controller  ──binary input frame──>  relay  ──[uint16 idx][frame]──>  host
//   controller  ──JSON alignment/bye──>  relay  ──(verbatim)──────────>  host
//   controller socket close            ->  relay  ──controller-leave───>  host
//
// Reliable disconnect is the whole point: a server-side socket close always
// fires, so the host reaps the player immediately (unlike a dropped WebRTC peer).
//
// This runs ALONGSIDE the existing peerjs broker (server.ts) — that stays the
// WebRTC path. Nothing here touches it.

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'

const port = Number.parseInt(process.env.WS_RELAY_PORT ?? '', 10) || 8083
const host = process.env.HOST ?? '0.0.0.0'
// Optional host (artwork) credential — keeps a random LAN client from
// impersonating the artwork. Controllers (visitors) are always open. Dedicated
// var (NOT EXHIBIT_PASSWORD) so the operator's controller password can't
// accidentally gate the artwork host.
const hostCredential = process.env.RELAY_HOST_PASSWORD || ''

function log(message: string, data?: unknown) {
  const ts = new Date().toISOString()
  if (data !== undefined) console.log(`[${ts}] [ws-relay] ${message}`, data)
  else console.log(`[${ts}] [ws-relay] ${message}`)
}

type Controller = { ws: WebSocket; idx: number; controllerId: string; color?: string }

type Session = {
  host: WebSocket | null
  controllers: Map<number, Controller>
  nextIdx: number
}

const sessions = new Map<string, Session>()

function getSession(name: string): Session {
  let session = sessions.get(name)
  if (!session) {
    session = { host: null, controllers: new Map(), nextIdx: 1 }
    sessions.set(name, session)
  }
  return session
}

function allocIdx(session: Session): number {
  // Small uint16 index; find the next free slot (a handful of controllers).
  for (let i = 0; i < 0xffff; i += 1) {
    const idx = ((session.nextIdx + i) & 0xffff) || 1
    if (!session.controllers.has(idx)) {
      session.nextIdx = (idx + 1) & 0xffff
      return idx
    }
  }
  return 1
}

function sendJson(ws: WebSocket | null, message: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

function query(req: IncomingMessage) {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

const certFile = process.env.CERT_FILE
const keyFile = process.env.KEY_FILE
let wss: WebSocketServer

if (certFile && keyFile) {
  const httpsServer = createHttpsServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) })
  httpsServer.listen(port, host)
  wss = new WebSocketServer({ server: httpsServer })
  log(`🔒 secure relay listening on wss://${host}:${port}` + (hostCredential ? '  (host auth required)' : ''))
} else {
  wss = new WebSocketServer({ host, port })
  log(`🚀 relay listening on ws://${host}:${port}` + (hostCredential ? '  (host auth required)' : ''))
}

wss.on('connection', (ws, req) => {
  const params = query(req)
  const role = params.get('role')
  const sessionName = params.get('session') || 'stardust'
  const session = getSession(sessionName)

  if (role === 'host') {
    if (hostCredential && (params.get('password') || params.get('pw')) !== hostCredential) {
      log('rejected host: invalid credential', { sessionName })
      ws.close(1008, 'invalid-credential')
      return
    }
    if (session.host && session.host !== ws) session.host.close(1000, 'replaced by new host')
    session.host = ws
    log('host connected', { sessionName, controllers: session.controllers.size })
    // Re-announce live controllers so a reconnecting host rebuilds its table.
    for (const c of session.controllers.values()) {
      sendJson(ws, { kind: 'controller-join', idx: c.idx, controllerId: c.controllerId, color: c.color })
    }
    ws.on('close', () => {
      if (session.host === ws) session.host = null
      log('host disconnected', { sessionName })
    })
    return
  }

  if (role === 'controller') {
    const controllerId = params.get('controllerId') || `controller-${Math.random().toString(36).slice(2, 10)}`
    const color = params.get('color') || undefined
    const idx = allocIdx(session)
    const controller: Controller = { ws, idx, controllerId, color }
    session.controllers.set(idx, controller)
    sendJson(session.host, { kind: 'controller-join', idx, controllerId, color })
    log('controller joined', { sessionName, controllerId, idx, total: session.controllers.size })

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (session.host?.readyState !== WebSocket.OPEN) return
      if (isBinary) {
        // prepend uint16 idx, forward the raw input frame to the host
        const framed = Buffer.allocUnsafe(2 + data.length)
        framed.writeUInt16LE(idx, 0)
        data.copy(framed, 2)
        session.host.send(framed)
      } else {
        // alignment / goodbye JSON — already carries controllerId; forward verbatim
        session.host.send(data.toString())
      }
    })

    ws.on('close', () => {
      session.controllers.delete(idx)
      sendJson(session.host, { kind: 'controller-leave', idx, controllerId })
      log('controller left', { sessionName, controllerId, idx, total: session.controllers.size })
    })
    return
  }

  log('rejected connection: unknown role', { role, sessionName })
  ws.close(1008, 'unknown-role')
})

function shutdown(signal: NodeJS.Signals) {
  log('shutting down', { signal })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.close(1001, 'relay shutting down')
  }
  wss.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
