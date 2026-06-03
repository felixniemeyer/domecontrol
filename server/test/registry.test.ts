import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { WebSocket, type WebSocketServer } from 'ws'

import { createArtworkRegistry } from '../src/registry.ts'

type Json = Record<string, any>

class Client {
  private readonly inbox: Json[] = []
  private readonly waiters: Array<() => void> = []
  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (raw) => {
      this.inbox.push(JSON.parse(raw.toString()))
      this.waiters.splice(0).forEach((resolve) => resolve())
    })
  }

  static open(url: string): Promise<Client> {
    const ws = new WebSocket(url)
    const client = new Client(ws)
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(client))
      ws.on('error', reject)
    })
  }

  send(message: Json) {
    this.ws.send(JSON.stringify(message))
  }

  async waitFor(predicate: (message: Json) => boolean, timeoutMs = 1000): Promise<Json> {
    const start = Date.now()
    for (;;) {
      const hit = this.inbox.find(predicate)
      if (hit) return hit
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for message')
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }

  /** Resolves once the latest directory message satisfies the predicate. */
  async waitDirectory(predicate: (names: string[]) => boolean, timeoutMs = 1000) {
    const start = Date.now()
    for (;;) {
      const directories = this.inbox.filter((m) => m.kind === 'directory')
      const latest = directories[directories.length - 1]
      const names: string[] = latest ? latest.artworks.map((a: Json) => a.name).sort() : []
      if (latest && predicate(names)) return latest.artworks as Json[]
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for directory (last: ${names})`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 50)
      })
    }
  }

  close() {
    this.ws.close()
  }
}

async function withRegistry(run: (url: string) => Promise<void>) {
  const server: WebSocketServer = createArtworkRegistry({ host: '127.0.0.1', port: 0, path: '/registry' })
  await new Promise<void>((resolve) => server.on('listening', resolve))
  const { port } = server.address() as AddressInfo
  try {
    await run(`ws://127.0.0.1:${port}/registry`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

test('accepts a registration and rejects a duplicate name', async () => {
  await withRegistry(async (url) => {
    const alpha = await Client.open(url)
    alpha.send({ kind: 'artwork-register', id: 'a1', name: 'Alpha', sessionId: 's-alpha' })
    assert.equal((await alpha.waitFor((m) => m.kind === 'register-ok')).kind, 'register-ok')

    const dup = await Client.open(url)
    dup.send({ kind: 'artwork-register', id: 'a2', name: 'Alpha', sessionId: 's-dup' })
    const rejection = await dup.waitFor((m) => m.kind === 'register-rejected')
    assert.equal(rejection.reason, 'name-taken')

    alpha.close()
    dup.close()
  })
})

test('directory lists registered artworks with full descriptors', async () => {
  await withRegistry(async (url) => {
    const alpha = await Client.open(url)
    alpha.send({ kind: 'artwork-register', id: 'a1', name: 'Alpha', sessionId: 's-alpha' })
    await alpha.waitFor((m) => m.kind === 'register-ok')

    const beta = await Client.open(url)
    beta.send({ kind: 'artwork-register', id: 'b1', name: 'Beta', sessionId: 's-beta' })
    await beta.waitFor((m) => m.kind === 'register-ok')

    const sub = await Client.open(url)
    sub.send({ kind: 'directory-subscribe' })
    const artworks = await sub.waitDirectory((names) => names.join(',') === 'Alpha,Beta')
    const alphaDescriptor = artworks.find((a) => a.name === 'Alpha')
    assert.deepEqual(alphaDescriptor, { id: 'a1', name: 'Alpha', sessionId: 's-alpha' })

    alpha.close()
    beta.close()
    sub.close()
  })
})

test('drops an artwork when its socket closes and frees the name', async () => {
  await withRegistry(async (url) => {
    const alpha = await Client.open(url)
    alpha.send({ kind: 'artwork-register', id: 'a1', name: 'Alpha', sessionId: 's-alpha' })
    await alpha.waitFor((m) => m.kind === 'register-ok')

    const beta = await Client.open(url)
    beta.send({ kind: 'artwork-register', id: 'b1', name: 'Beta', sessionId: 's-beta' })
    await beta.waitFor((m) => m.kind === 'register-ok')

    const sub = await Client.open(url)
    sub.send({ kind: 'directory-subscribe' })
    await sub.waitDirectory((names) => names.join(',') === 'Alpha,Beta')

    alpha.close()
    await sub.waitDirectory((names) => names.join(',') === 'Beta')

    // Name is reusable once the previous holder is gone.
    const alpha2 = await Client.open(url)
    alpha2.send({ kind: 'artwork-register', id: 'a2', name: 'Alpha', sessionId: 's-alpha-2' })
    assert.equal((await alpha2.waitFor((m) => m.kind === 'register-ok')).kind, 'register-ok')
    await sub.waitDirectory((names) => names.join(',') === 'Alpha,Beta')

    beta.close()
    sub.close()
    alpha2.close()
  })
})
