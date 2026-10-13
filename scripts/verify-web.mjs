import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'

const base = process.env.CLOUT_PREVIEW_URL ?? 'http://localhost:8081'
await mkdir('artifacts/screenshots', { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 400, height: 890 },
    { width: 320, height: 568 },
  ]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const documentResponse = await page.goto(base)
    assert.match(
      await documentResponse.text(),
      /<meta\s+name="referrer"\s+content="no-referrer"\s*\/?\s*>/,
      'the initial HTML must omit referrers before third-party video requests',
    )
    await page.getByRole('button', { name: 'Back this post', exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 3)
    const playWithSound = page.getByRole('button', { name: 'Play video with sound', exact: true })
    if (await playWithSound.isVisible()) await playWithSound.click()
    await page.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2)
    assert.match(await page.title(), /Seek the best content, win SKR/)
    assert.equal(await page.locator('video').count(), 1, 'only one active player')
    const frame = await page.getByTestId('seeker-video-frame').boundingBox()
    assert.ok(
      frame && Math.abs(frame.width / frame.height - 1200 / 2670) < 0.001,
      'Seeker video aspect ratio',
    )
    const controls = []
    for (const name of ['Mute video', 'Like post', 'Open comments', 'Save post', 'Share', 'Back this post']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox()
      assert.ok(box && box.width >= 48 && box.height >= 48, `${name} has a 48px touch target`)
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1,
        `${name} fits the viewport`,
      )
      for (const previous of controls) {
        const overlapWidth =
          Math.min(box.x + box.width, previous.box.x + previous.box.width) - Math.max(box.x, previous.box.x)
        const overlapHeight =
          Math.min(box.y + box.height, previous.box.y + previous.box.height) - Math.max(box.y, previous.box.y)
        assert.ok(overlapWidth <= 0.5 || overlapHeight <= 0.5, `${name} does not overlap ${previous.name}`)
      }
      controls.push({ name, box })
    }
    await page
      .getByRole('button', { name: 'Pause video', exact: true })
      .click({ position: { x: frame.width / 2, y: frame.height * 0.3 } })
    await page.waitForFunction(() => document.querySelector('video')?.paused)
    await page
      .getByRole('button', { name: 'Play video', exact: true })
      .click({ position: { x: frame.width / 2, y: frame.height * 0.3 } })
    await page.waitForFunction(() => !document.querySelector('video')?.paused)
    await page.getByRole('button', { name: 'Mute video', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('video')?.muted === true)
    await page.getByRole('button', { name: 'Unmute video', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('video')?.muted === false)
    const firstSource = await page.locator('video').getAttribute('src')
    await swipeVideo(page, 1)
    assert.notEqual(await page.locator('video').getAttribute('src'), firstSource)
    await swipeVideo(page, -1)
    assert.equal(await page.locator('video').getAttribute('src'), firstSource)
    await page.screenshot({ path: `artifacts/screenshots/feed-${viewport.width}.png` })
    const savedCreator = await page.getByTestId('post-creator').innerText()
    const savedPostLabel = `Open saved post by ${savedCreator}`
    await page.getByRole('button', { name: 'Save post', exact: true }).click()
    await page.getByRole('tab', { name: 'Collection', exact: true }).click()
    await page.getByRole('button', { name: savedPostLabel, exact: true }).waitFor()
    await page.reload()
    await page.getByRole('tab', { name: 'Collection', exact: true }).click()
    await page.getByRole('button', { name: savedPostLabel, exact: true }).waitFor()
    await page.getByRole('button', { name: savedPostLabel, exact: true }).click()
    await page.getByRole('button', { name: 'Pause video', exact: true }).waitFor()
    await page.getByRole('tab', { name: 'Discover', exact: true }).click()
    const search = page.getByRole('textbox', { name: 'Search posts or creators' })
    await search.fill('Every adventure starts somewhere')
    assert.equal(await page.getByRole('button', { name: /View .* post/ }).count(), 1)
    await page.getByRole('button', { name: 'View Sintel · sample post', exact: true }).click()
    await page.getByRole('button', { name: 'Pause video', exact: true }).waitFor()
    assert.match(await page.locator('body').innerText(), /Every adventure starts somewhere/)
    await swipeVideo(page, 1)
    const browsedSource = await page.locator('video').getAttribute('src')
    await page.getByRole('tab', { name: 'Profile', exact: true }).click()
    await page.getByRole('tab', { name: 'Feed', exact: true }).click()
    await page.getByRole('button', { name: 'Pause video', exact: true }).waitFor()
    assert.equal(
      await page.locator('video').getAttribute('src'),
      browsedSource,
      'tab navigation preserves the current video',
    )
    await page.getByRole('tab', { name: 'Discover', exact: true }).click()
    await search.fill('')
    await page.getByRole('button', { name: 'Follow Bunny · sample', exact: true }).click()
    await page.screenshot({ path: `artifacts/screenshots/discover-${viewport.width}.png` })
    await page.getByRole('tab', { name: 'Feed', exact: true }).click()
    await page.getByRole('tab', { name: 'Following', exact: true }).click()
    assert.equal(
      await page.getByRole('tab', { name: 'Following', exact: true }).getAttribute('aria-selected'),
      'true',
    )
    await page.getByRole('tab', { name: 'Profile', exact: true }).click()
    await page.getByRole('tab', { name: 'Feed', exact: true }).click()
    await page.getByRole('button', { name: 'Open comments', exact: true }).waitFor()
    assert.equal(
      await page.getByRole('tab', { name: 'Following', exact: true }).getAttribute('aria-selected'),
      'true',
      'tab navigation preserves the feed filter',
    )
    await page.getByRole('button', { name: 'Open comments', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.waitForFunction(() => document.querySelector('video')?.paused)
    assert.match(await page.getByRole('dialog').innerText(), /Sample discussion/)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('video')?.paused)
    await page.getByRole('button', { name: 'Back this post', exact: true }).click()
    assert.match(await page.getByRole('dialog').innerText(), /no market|Get quote/)
    assert.equal(await page.getByRole('button', { name: 'Approve in wallet', exact: true }).count(), 0)
    await page.screenshot({ path: `artifacts/screenshots/market-${viewport.width}.png` })
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Create', exact: true }).click()
    await page.getByRole('textbox', { name: 'Post caption' }).fill('My first good find')
    assert.notEqual(
      await page.getByRole('button', { name: 'Connect wallet to publish' }).getAttribute('aria-disabled'),
      'true',
    )
    await page.getByRole('button', { name: 'Connect wallet to publish' }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await page.getByRole('tab', { name: 'Profile', exact: true }).click()
    await page.getByRole('button', { name: 'Connect your wallet', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: 'Open on Seeker', exact: true }).isDisabled(), true)
    assert.match(await page.getByRole('dialog').innerText(), /Desktop browsing is read-only/)
    assert.deepEqual(errors, [], 'no browser runtime or console errors')
    console.log(
      `PASS ${viewport.width}×${viewport.height}: playback, bookmarks, persistence, search, follows, comments, trade gating, create, wallet gating`,
    )
    await page.close()
  }
  const retryPage = await browser.newPage({ viewport: { width: 400, height: 890 } })
  await retryPage.route('**/*.mp4*', (route) => route.abort())
  await retryPage.goto(base)
  await retryPage.getByRole('button', { name: 'Retry video', exact: true }).waitFor()
  await retryPage.unroute('**/*.mp4*')
  await retryPage
    .getByRole('button', { name: 'Retry video', exact: true })
    .click({ position: { x: 200, y: 270 } })
  await retryPage.waitForFunction(() => document.querySelector('video')?.currentTime > 0.2)
  await retryPage.close()
  console.log('PASS video recovery: retry after a failed media request resumes playback')
} finally {
  await browser.close()
}

async function swipeVideo(page, direction) {
  const frame = await page.getByTestId('seeker-video-frame').boundingBox()
  assert.ok(frame)
  const first = await page.locator('video').getAttribute('src')
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height * 0.4)
  await page.mouse.wheel(0, frame.height * 0.8 * direction)
  await page.waitForFunction(
    (source) => document.querySelector('video')?.getAttribute('src') !== source,
    first,
  )
  await page.waitForTimeout(800)
  assert.equal(await page.locator('video').count(), 1, 'one active video after a vertical swipe')
}
