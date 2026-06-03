import net from 'node:net'

const targets = [
  { name: 'dome server', host: '127.0.0.1', port: 18081 },
  { name: 'artwork registry', host: '127.0.0.1', port: 18082 },
  { name: 'artwork stub', host: '127.0.0.1', port: 14173 },
  { name: 'controller', host: '127.0.0.1', port: 15176 },
]

const timeoutMs = 20_000
const retryDelayMs = 250

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function canConnect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })

    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })

    socket.once('error', (error) => {
      socket.destroy()
      if (error && typeof error === 'object' && 'code' in error) {
        if (error.code === 'ECONNREFUSED') {
          resolve(false)
          return
        }
        if (error.code === 'EACCES' || error.code === 'EPERM') {
          reject(new Error(`cannot probe ${host}:${port} due to permission error (${error.code})`))
          return
        }
      }
      reject(error)
    })
  })
}

async function waitForTarget(target) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(target.host, target.port)) {
      console.info(`[dome-control:test] ready: ${target.name} on ${target.host}:${target.port}`)
      return
    }
    await sleep(retryDelayMs)
  }

  throw new Error(`timed out waiting for ${target.name} on ${target.host}:${target.port}`)
}

for (const target of targets) {
  await waitForTarget(target)
}

console.info('[dome-control:test] test environment is ready')

