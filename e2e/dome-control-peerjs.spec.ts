import { expect, test } from '@playwright/test'

test('controller connects to artwork over PeerJS and updates player state', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto('http://127.0.0.1:5173/?ws-broker-url=off')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return typeof window.domeControlRuntime?.getSessionState === 'function'
    })
  }).toBe(true)

  const controllerPage = await browser.newPage()
  await controllerPage.goto('http://127.0.0.1:5176/?laptop=1')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.domeControlRuntime?.getSessionState().players.length ?? 0
    })
  }).toBe(1)

  const joystick = controllerPage.locator('#aim-pad')
  await joystick.evaluate((element) => {
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 1,
    }))
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? false
    })
  }).toBe(true)

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const snapshot = window.domeControlRuntime?.getGameSnapshot() as { cameraOffset?: [number, number, number] } | undefined
      const offset = snapshot?.cameraOffset
      return offset ? Math.hypot(...offset) : 0
    })
  }).toBeGreaterThan(0.02)

  await joystick.evaluate((element) => {
    element.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
    }))
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? true
    })
  }).toBe(false)
})

test('laptop pointer movement aims without acceleration', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto('http://127.0.0.1:5173/?ws-broker-url=off')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return typeof window.domeControlRuntime?.getSessionState === 'function'
    })
  }).toBe(true)

  const controllerPage = await browser.newPage()
  await controllerPage.goto('http://127.0.0.1:5176/?laptop=1')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.domeControlRuntime?.getSessionState().players.length ?? 0
    })
  }).toBe(1)

  const before = await artworkPage.evaluate(() => {
    return window.domeControlRuntime?.getSessionState().players[0]?.direction
  })

  await controllerPage.locator('#aim-pad').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
      clientX: rect.right - 8,
      clientY: rect.top + rect.height / 2,
    }))
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? true
    })
  }).toBe(false)

  await expect.poll(async () => {
    return artworkPage.evaluate((previous) => {
      const next = window.domeControlRuntime?.getSessionState().players[0]?.direction
      if (!next || !previous) return 0
      return Math.hypot(
        next[0] - previous[0],
        next[1] - previous[1],
        next[2] - previous[2],
      )
    }, before)
  }).toBeGreaterThan(0.1)
})

test('local laptop popup keeps button state independent of pointer motion', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto('http://127.0.0.1:5173/?ws-broker-url=off')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return typeof window.domeControlRuntime?.getSessionState === 'function'
    })
  }).toBe(true)

  const popupPromise = artworkPage.waitForEvent('popup')
  await artworkPage.evaluate(() => {
    window.open('http://127.0.0.1:5176/?laptop=1', '_blank', 'noopener=false')
  })
  const controllerPage = await popupPromise

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.domeControlRuntime?.getSessionState().players.length ?? 0
    })
  }).toBe(1)

  const joystick = controllerPage.locator('#aim-pad')
  await joystick.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 1,
      clientX: rect.right - 10,
      clientY: rect.top + rect.height / 2,
    }))
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? false
    })
  }).toBe(true)

  await controllerPage.waitForTimeout(700)

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? false
    })
  }).toBe(true)

  await joystick.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0,
      clientX: rect.right - 10,
      clientY: rect.top + rect.height / 2,
    }))
  })

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      const state = window.domeControlRuntime?.getSessionState()
      return state?.players[0]?.buttons.accelerate ?? true
    })
  }).toBe(false)
})

test('new controller replaces previous controller', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto('http://127.0.0.1:5173/?ws-broker-url=off')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return typeof window.domeControlRuntime?.getSessionState === 'function'
    })
  }).toBe(true)

  const firstControllerPage = await browser.newPage()
  await firstControllerPage.goto('http://127.0.0.1:5176/?laptop=1')

  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.domeControlRuntime?.getSessionState().players.length ?? 0
    })
  }).toBe(1)

  const firstControllerId = await artworkPage.evaluate(() => {
    return window.domeControlRuntime?.getSessionState().players[0]?.id
  })

  const secondControllerPage = await browser.newPage()
  await secondControllerPage.goto('http://127.0.0.1:5176/?laptop=1')

  await expect.poll(async () => {
    return artworkPage.evaluate((previousId) => {
      const players = window.domeControlRuntime?.getSessionState().players ?? []
      return players.length === 1 && players[0]?.id !== previousId
    }, firstControllerId)
  }).toBe(true)

  await expect.poll(async () => {
    return firstControllerPage.locator('#transport-status').textContent()
  }).toContain('superseded')
})
