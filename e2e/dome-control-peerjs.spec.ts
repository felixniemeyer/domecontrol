import { expect, test } from '@playwright/test'

async function waitForRuntime(artworkPage: import('@playwright/test').Page) {
  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return typeof window.domeControlRuntime?.getSessionState === 'function'
    })
  }).toBe(true)
}

async function waitForPlayers(artworkPage: import('@playwright/test').Page, count: number) {
  await expect.poll(async () => {
    return artworkPage.evaluate(() => {
      return window.domeControlRuntime?.getSessionState().players.length ?? 0
    })
  }).toBe(count)
}

async function moveJoystick(controllerPage: import('@playwright/test').Page) {
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
}

test('controller reconnects after controller reload without reloading artwork', async ({ browser }) => {
  const artworkPage = await browser.newPage()
  await artworkPage.goto('http://127.0.0.1:14173/')

  await waitForRuntime(artworkPage)

  const controllerId = 'reload-check-controller'
  const controllerPage = await browser.newPage()
  await controllerPage.goto(`https://127.0.0.1:15176/?laptop=1&controller=${controllerId}`)

  await waitForPlayers(artworkPage, 1)

  const beforeReload = await artworkPage.evaluate(() => {
    return window.domeControlRuntime?.getSessionState().players[0]?.direction
  })

  await moveJoystick(controllerPage)

  await expect.poll(async () => {
    return artworkPage.evaluate((previous) => {
      const next = window.domeControlRuntime?.getSessionState().players[0]?.direction
      if (!next || !previous) return 0
      return Math.hypot(
        next[0] - previous[0],
        next[1] - previous[1],
        next[2] - previous[2],
      )
    }, beforeReload)
  }).toBeGreaterThan(0.1)

  await controllerPage.reload()

  await waitForPlayers(artworkPage, 1)

  await expect.poll(async () => {
    return artworkPage.evaluate((expectedControllerId) => {
      return window.domeControlRuntime?.getSessionState().players[0]?.id === expectedControllerId
    }, controllerId)
  }).toBe(true)

  const afterReload = await artworkPage.evaluate(() => {
    return window.domeControlRuntime?.getSessionState().players[0]?.direction
  })

  await moveJoystick(controllerPage)

  await expect.poll(async () => {
    return artworkPage.evaluate((previous) => {
      const next = window.domeControlRuntime?.getSessionState().players[0]?.direction
      if (!next || !previous) return 0
      return Math.hypot(
        next[0] - previous[0],
        next[1] - previous[1],
        next[2] - previous[2],
      )
    }, afterReload)
  }).toBeGreaterThan(0.1)
})
