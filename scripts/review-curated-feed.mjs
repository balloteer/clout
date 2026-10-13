import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.CLOUT_PREVIEW_URL ?? 'http://localhost:8081'
const apiPreview = process.env.CLOUT_API_PREVIEW_URL ?? 'http://localhost:8082'
const catalog = JSON.parse(await readFile('apps/mobile/src/lib/curated-content.json', 'utf8'))
const output = 'artifacts/viewport-review'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const report = { firstPosts: [], filters: {}, errors: [] }

async function visibleControl(locator) {
  const result = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    let left = Math.max(0, box.left),
      right = Math.min(innerWidth, box.right)
    let top = Math.max(0, box.top),
      bottom = Math.min(innerHeight, box.bottom)
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor),
        rect = ancestor.getBoundingClientRect()
      if (/hidden|auto|scroll|clip/.test(style.overflowX)) {
        left = Math.max(left, rect.left)
        right = Math.min(right, rect.right)
      }
      if (/hidden|auto|scroll|clip/.test(style.overflowY)) {
        top = Math.max(top, rect.top)
        bottom = Math.min(bottom, rect.bottom)
      }
    }
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      bounds: box.toJSON(),
      visible: (Math.max(0, right - left) * Math.max(0, bottom - top)) / (box.width * box.height),
      hit: !!hit && element.contains(hit),
    }
  })
  assert.ok(result.visible > 0.99 && result.hit, JSON.stringify(result))
  return result
}

async function sourcePopup(context, page, locator, expected) {
  await context.route('https://x.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Source destination check</title>' }),
  )
  const next = page.waitForEvent('popup')
  await locator.click()
  const popup = await next
  await popup.waitForLoadState('domcontentloaded')
  assert.equal(popup.url(), expected)
  await popup.close()
}

try {
  const context = await browser.newContext({ viewport: { width: 400, height: 890 }, deviceScaleFactor: 3 })
  const page = await context.newPage()
  page.on('pageerror', (error) => report.errors.push(error.message))
  await page.goto(base)
  await page.getByRole('button', { name: 'Back this post', exact: true }).waitFor()
  // A user gesture allows audible playback on browser previews.
  await page.getByRole('button', { name: 'Mute video', exact: true }).click()
  await page.getByRole('button', { name: 'Unmute video', exact: true }).click()
  for (let index = 0; index < 3; index++) {
    const expected = catalog[index]
    await page
      .waitForFunction(
        (url) => {
          const video = document.querySelector('video')
          return (
            video?.getAttribute('src') === url &&
            video.readyState >= 3 &&
            video.currentTime > 0.15 &&
            !video.paused
          )
        },
        expected.video,
        { timeout: 8000 },
      )
      .catch((error) => {
        if (process.env.CLOUT_ALLOW_MEDIA_FAILURE !== '1') throw error
        report.errors.push(`Playback did not start: ${expected.id}`)
      })
    const metrics = await page.locator('video').evaluate((video) => ({
      time: video.currentTime,
      ready: video.readyState,
      paused: video.paused,
      fit: getComputedStyle(video).objectFit,
      width: video.videoWidth,
      height: video.videoHeight,
    }))
    assert.equal(metrics.fit, 'cover')
    assert.ok(metrics.width / metrics.height <= 0.65, 'Featured source must be portrait')
    assert.ok(metrics.height >= 720, 'Featured source must remain readable on Seeker')
    assert.equal(await page.locator('video').count(), 1)
    const source = page.getByRole('link', {
      name: `View original post by @${expected.source.handle}`,
      exact: true,
    })
    await visibleControl(source)
    assert.match(
      await source.innerText(),
      new RegExp(new Date(expected.source.publishedAt).getUTCFullYear().toString()),
    )
    report.firstPosts.push({
      id: expected.id,
      ...metrics,
      source: expected.source.url,
      sourceText: await source.innerText(),
    })
    await page.screenshot({ path: `${output}/curated-seeker-${index + 1}.png` })
    if (index < 2) {
      await page.mouse.move(160, 400)
      await page.mouse.wheel(0, 3000)
      await page.waitForFunction(
        (next) =>
          Math.abs(document.querySelector('[data-testid="vertical-video-feed"]').scrollTop - next * 890) < 1,
        index + 1,
      )
      await page.waitForTimeout(250)
    }
  }
  const third = catalog[2]
  await sourcePopup(
    context,
    page,
    page.getByRole('link', { name: `View original post by @${third.source.handle}`, exact: true }),
    third.source.url,
  )
  await page.getByRole('button', { name: 'Open comments', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await page.getByText('Original conversation', { exact: true }).isVisible(), true)
  await visibleControl(page.getByRole('button', { name: 'View conversation on X', exact: true }))
  await sourcePopup(
    context,
    page,
    page.getByRole('button', { name: 'View conversation on X', exact: true }),
    third.source.url,
  )
  await page.screenshot({ path: `${output}/curated-conversation.png` })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  report.originalConversation = true
  await page.getByRole('button', { name: 'Save post', exact: true }).click()
  await page.waitForTimeout(150)
  await page.reload()
  await page.getByRole('tab', { name: 'Collection', exact: true }).click()
  await page.getByRole('button', { name: `Open saved post by ${third.creator}`, exact: true }).waitFor()
  report.saveSurvivesReload = true
  await page.getByRole('tab', { name: 'Discover', exact: true }).click()
  for (const tag of ['Solana', 'SKR', 'AI']) {
    await page.getByRole('button', { name: tag, exact: true }).click()
    const count = catalog.filter((post) => post.tag === tag).length
    await page.getByText(`${count} ${count === 1 ? 'post' : 'posts'}`, { exact: true }).waitFor()
    report.filters[tag] = count
  }
  await page.getByRole('tab', { name: 'Feed', exact: true }).click()
  await page.setViewportSize({ width: 320, height: 568 })
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element)
      if (style.fontFamily.includes('Ionicons')) continue
      if (
        ![...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
      )
        continue
      element.style.fontSize = `${parseFloat(style.fontSize) * 1.5}px`
      if (style.lineHeight !== 'normal') element.style.lineHeight = `${parseFloat(style.lineHeight) * 1.5}px`
    }
  })
  report.mute320Text150 = await visibleControl(page.getByRole('button', { name: 'Mute video', exact: true }))
  await page.screenshot({ path: `${output}/curated-320-text150.png` })
  await context.close()

  const failing = await browser.newContext({ viewport: { width: 400, height: 890 }, deviceScaleFactor: 3 })
  await failing.route('https://video.twimg.com/**', (route) => route.abort('failed'))
  const errorPage = await failing.newPage()
  await errorPage.goto(base)
  await errorPage.getByRole('button', { name: 'Retry video', exact: true }).waitFor()
  const fallback = errorPage.getByRole('link', {
    name: `View original post by @${catalog[0].source.handle}`,
    exact: true,
  })
  await visibleControl(fallback)
  await sourcePopup(failing, errorPage, fallback, catalog[0].source.url)
  await errorPage.screenshot({ path: `${output}/curated-playback-fallback.png` })
  report.failedVideoKeepsSourceLink = true
  await failing.close()

  const liveContext = await browser.newContext({
    viewport: { width: 400, height: 890 },
    deviceScaleFactor: 3,
  })
  if (process.env.CLOUT_RELAY_LOCAL_FEED === '1') {
    // An optional UI-only check for a dev server whose origin is absent from the
    // local API allowlist. Uses the real public feed response, never credentials.
    await liveContext.route('**/v1/feed', async (route) => {
      const response = await liveContext.request.get(route.request().url())
      assert.equal(response.status(), 200)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': new URL(apiPreview).origin },
        body: await response.body(),
      })
    })
    report.apiRefreshMode = 'Real public API JSON relayed by test; local preview origin is not allowlisted'
  } else {
    report.apiRefreshMode = 'Direct browser request'
  }
  const live = await liveContext.newPage()
  const feedResponse = live.waitForResponse(
    (response) => response.url().endsWith('/v1/feed') && response.status() === 200,
    { timeout: 25000 },
  )
  await live.goto(apiPreview)
  const response = await feedResponse
  report.apiFeedPosts = (await response.json()).posts.length
  await live
    .getByRole('link', { name: `View original post by @${catalog[0].source.handle}`, exact: true })
    .waitFor()
  await live.getByRole('button', { name: 'Save post', exact: true }).click()
  await live.waitForTimeout(200)
  const nextFeedResponse = live.waitForResponse(
    (item) => item.url().endsWith('/v1/feed') && item.status() === 200,
  )
  await live.reload()
  await nextFeedResponse
  await live.getByRole('tab', { name: 'Collection', exact: true }).click()
  await live.getByRole('button', { name: `Open saved post by ${catalog[0].creator}`, exact: true }).waitFor()
  report.curatedSaveSurvivesApiRefresh = true
  await live.screenshot({ path: `${output}/curated-api-refresh-saved.png` })
  await liveContext.close()
  await writeFile(`${output}/curated-report.json`, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  assert.deepEqual(report.errors, [])
} finally {
  await browser.close()
}
