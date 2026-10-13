import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.CLOUT_PREVIEW_URL ?? 'http://localhost:8081'
const output = 'artifacts/viewport-review'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []

async function pageIndex(page, expected) {
  await page.waitForFunction((index) => {
    const feed = document.querySelector('[data-testid="vertical-video-feed"]')
    return feed && Math.abs(feed.scrollTop - index * feed.clientHeight) < 1
  }, expected)
  await page.waitForTimeout(180)
  const metrics = await page.getByTestId('vertical-video-feed').evaluate((feed) => ({
    top: feed.scrollTop,
    height: feed.clientHeight,
    videoCount: document.querySelectorAll('video').length,
    source: document.querySelector('video')?.getAttribute('src'),
    documentHeight: document.documentElement.scrollHeight,
    viewportHeight: innerHeight,
  }))
  assert.ok(Math.abs(metrics.top / metrics.height - expected) < 0.005, JSON.stringify(metrics))
  assert.equal(metrics.videoCount, 1, 'one active video after settling')
  assert.equal(metrics.documentHeight, metrics.viewportHeight, 'document remains bounded')
  return metrics
}

try {
  for (const viewport of [
    { width: 400, height: 890 },
    { width: 1440, height: 1000 },
    { width: 320, height: 568 },
  ]) {
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: viewport.width === 400 ? 3 : 1,
      hasTouch: true,
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByRole('button', { name: 'Back this post', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3)
    const first = await pageIndex(page, 0)
    const feed = page.getByTestId('vertical-video-feed')
    const frame = await feed.boundingBox()
    const snapRules = await feed.evaluate((element) => ({
      type: getComputedStyle(element).scrollSnapType,
      children: [...element.children].map((child) => ({
        align: getComputedStyle(child).scrollSnapAlign,
        stop: getComputedStyle(child).scrollSnapStop,
      })),
    }))
    assert.equal(snapRules.type, 'y mandatory')
    assert.ok(snapRules.children.length >= 50)
    assert.ok(snapRules.children.every((child) => child.align === 'start' && child.stop === 'always'))
    await page.mouse.move(frame.x + frame.width * 0.4, frame.y + frame.height * 0.4)
    await page.mouse.wheel(0, 12000)
    const second = await pageIndex(page, 1)
    assert.notEqual(first.source, second.source)

    // A trackpad sends many decreasing momentum events for a single gesture.
    for (const delta of [160, 145, 130, 112, 98, 80, 63, 48, 35, 24, 14, 8]) {
      await page.mouse.wheel(0, delta)
      await page.waitForTimeout(35)
    }
    await page.waitForTimeout(600)
    await pageIndex(page, 2)
    await page.mouse.wheel(0, -12000)
    await pageIndex(page, 1)

    await feed.focus()
    await page.keyboard.press('PageDown')
    await pageIndex(page, 2)
    await page.keyboard.press('PageUp')
    await pageIndex(page, 1)

    if (viewport.width === 400) {
      const cdp = await context.newCDPSession(page)
      const x = Math.round(frame.x + frame.width * 0.4)
      const from = Math.round(frame.y + frame.height * 0.8)
      const to = Math.round(frame.y + frame.height * 0.2)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: from }] })
      for (let step = 1; step <= 18; step++) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: from + ((to - from) * step) / 18 }],
        })
        await page.waitForTimeout(16)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await pageIndex(page, 2)
      await cdp.detach()
      const beforeResize = await page.locator('video').getAttribute('src')
      await page.setViewportSize({ width: 390, height: 844 })
      await page.waitForTimeout(300)
      await pageIndex(page, 2)
      assert.equal(
        await page.locator('video').getAttribute('src'),
        beforeResize,
        'resize preserves selected post',
      )
      await page.setViewportSize(viewport)
      await pageIndex(page, 2)
    }
    await page.screenshot({ path: `${output}/pager-${viewport.width}.png` })
    assert.deepEqual(errors, [])
    results.push({
      viewport,
      hugeWheelOnePage: true,
      trackpadBurstOnePage: true,
      reverseOnePage: true,
      keyboardOnePage: true,
      touchAndResize: viewport.width === 400,
      pageErrors: errors,
    })
    await context.close()
  }
  await writeFile(`${output}/pager-report.json`, `${JSON.stringify(results, null, 2)}\n`)
  console.log('Post pager passed: large wheel, momentum burst, reverse, keyboard, Seeker touch and resize.')
} finally {
  await browser.close()
}
