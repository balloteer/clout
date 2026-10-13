/** Browser autoplay checks with a local media fixture; never connects or signs a wallet. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const output = 'artifacts/investment-review'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 400, height: 890 } })
  // The bundled fixture can lack audio. Enforce audible autoplay rejection
  // until actual input arrives. Playwright's locator/evaluation polling can
  // activate Chromium's sticky userActivation flag before any scripted click,
  // so that flag cannot reliably model the blocked state in this test.
  await context.addInitScript(() => {
    let trustedInput = false
    const activate = (event) => {
      if (event.isTrusted) trustedInput = true
    }
    window.addEventListener('pointerdown', activate, { capture: true })
    window.addEventListener('keydown', activate, { capture: true })
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (!this.muted && !trustedInput)
        return Promise.reject(new DOMException('User activation required', 'NotAllowedError'))
      return play.call(this)
    }
  })
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    const body =
      path === '/v1/feed'
        ? { posts: [], following: [] }
        : path === '/v1/config'
          ? { network: 'devnet', quoteDecimals: 6, features: { trading: false } }
          : { error: { message: 'Market data is outside this audio fixture.' } }
    return route.fulfill({
      status: path === '/v1/feed' || path === '/v1/config' ? 200 : 503,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  await context.route('https://video.twimg.com/**', (route) =>
    route.fulfill({
      path: 'apps/mobile/assets/media/sample-001.mp4',
      contentType: 'video/mp4',
      headers: { 'Access-Control-Allow-Origin': '*' },
    }),
  )
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(process.env.CLOUT_PREVIEW_URL ?? 'http://localhost:8081', { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'Play video with sound', exact: true }).waitFor()
  assert.equal(await page.locator('video').evaluate((video) => video.muted), false)
  assert.equal(await page.getByText('Tap to retry', { exact: true }).count(), 0)
  await page.getByRole('button', { name: 'Play video with sound', exact: true }).click()
  await page.waitForFunction(() => {
    const video = document.querySelector('video')
    return video && !video.paused && !video.muted && video.currentTime > 0.1
  })
  await page.getByRole('button', { name: 'Mute video', exact: true }).click()
  assert.equal(await page.locator('video').evaluate((video) => video.muted), true)
  const firstSource = await page.locator('video').getAttribute('src')
  await page.mouse.move(170, 400)
  await page.mouse.wheel(0, 3000)
  await page.waitForFunction((previous) => {
    const video = document.querySelector('video')
    return video && video.getAttribute('src') !== previous && video.muted && !video.paused
  }, firstSource)
  assert.equal(await page.locator('video').count(), 1)
  await page.getByRole('button', { name: 'Unmute video', exact: true }).click()
  await page.waitForFunction(() => {
    const video = document.querySelector('video')
    return video && !video.muted && !video.paused
  })
  await page.getByRole('button', { name: 'Back this post', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('video')?.paused === true)
  assert.deepEqual(errors, [])
  await writeFile(
    `${output}/audio-browser.json`,
    JSON.stringify(
      {
        fixture:
          'Local media replacement; explicit NotAllowedError until trusted pointer/key input. API calls intercepted; no wallet or chain activity.',
        defaultUnmuted: true,
        browserGestureFallback: true,
        mutePersistsAcrossPaging: true,
        onePlayer: true,
        marketSheetPausesVideo: true,
        errors,
      },
      null,
      2,
    ) + '\n',
  )
  console.log('Audio default, browser gesture fallback, mute/paging, and modal pause passed.')
} finally {
  await browser.close()
}
