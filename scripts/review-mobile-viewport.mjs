import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// Start the local web preview first. This runner selects only bundled media and never uploads it.
const origin = process.env.CLOUT_PREVIEW_URL ?? 'http://127.0.0.1:8081'
const destination = 'artifacts/viewport-review'
await mkdir(destination, { recursive: true })
const browser = await chromium.launch({ headless: true })
const reports = []

async function measure(page, label, screen) {
  const data = await page.evaluate(() => {
    const size = (element) =>
      element
        ? {
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
            bounds: element.getBoundingClientRect().toJSON(),
          }
        : null
    const visible = (element) => {
      const bounds = element.getBoundingClientRect()
      let left = Math.max(0, bounds.left)
      let right = Math.min(innerWidth, bounds.right)
      let top = Math.max(0, bounds.top)
      let bottom = Math.min(innerHeight, bounds.bottom)
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const box = parent.getBoundingClientRect()
        if (/hidden|auto|scroll|clip/.test(style.overflowX)) {
          left = Math.max(left, box.left)
          right = Math.min(right, box.right)
        }
        if (/hidden|auto|scroll|clip/.test(style.overflowY)) {
          top = Math.max(top, box.top)
          bottom = Math.min(bottom, box.bottom)
        }
      }
      const hit = document.elementFromPoint(
        Math.max(0, Math.min(innerWidth - 1, bounds.x + bounds.width / 2)),
        Math.max(0, Math.min(innerHeight - 1, bounds.y + bounds.height / 2)),
      )
      return {
        bounds: bounds.toJSON(),
        visibleFraction:
          bounds.width * bounds.height
            ? (Math.max(0, right - left) * Math.max(0, bottom - top)) / (bounds.width * bounds.height)
            : 0,
        centerHit: !!hit && (element.contains(hit) || hit.contains(element)),
      }
    }
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { x: scrollX, y: scrollY },
      document: size(document.documentElement),
      body: size(document.body),
      root: size(document.getElementById('root')),
      fields: size(document.querySelector('[data-testid="create-fields"]')),
      footer: size(document.querySelector('[data-testid="create-publish-footer"]')),
      controls: [...document.querySelectorAll('[role=button],[role=tab],input,textarea')]
        .map((element) => ({
          role: element.getAttribute('role') || element.tagName,
          name:
            element.getAttribute('aria-label') ||
            element.textContent?.trim() ||
            element.getAttribute('placeholder'),
          ...visible(element),
        }))
        .filter((control) => control.bounds.width && control.bounds.height),
    }
  })
  await page.screenshot({ path: `${destination}/${label}.png` })
  await writeFile(`${destination}/${label}.json`, `${JSON.stringify(data, null, 2)}\n`)
  assert.ok(data.document.scrollWidth <= data.viewport.width + 1, `${label}: document horizontal overflow`)
  assert.ok(data.document.scrollHeight <= data.viewport.height + 1, `${label}: document vertical overflow`)
  assert.ok(data.body.bounds.height <= data.viewport.height + 1, `${label}: body exceeds viewport`)
  assert.ok(data.root.bounds.height <= data.viewport.height + 1, `${label}: root exceeds viewport`)
  assert.deepEqual(data.scroll, { x: 0, y: 0 }, `${label}: document scrolled`)
  const names = {
    Feed: ['Back this post', 'Like post'],
    Create: ['Post caption', 'Connect wallet to publish'],
    Discover: ['Search posts or creators'],
  }[screen]
  const chosen = Object.fromEntries(
    names.map((name) => {
      const control = data.controls.find(
        (item) => item.name === name && item.visibleFraction > 0.99 && item.centerHit,
      )
      assert.ok(control, `${label}: missing, clipped or inert ${name}`)
      return [name, control]
    }),
  )
  if (screen === 'Feed') {
    const eye = chosen['Back this post'].bounds
    const like = chosen['Like post'].bounds
    assert.ok(eye.bottom <= like.top + 0.5, `${label}: eye is not above Like`)
    assert.ok(eye.width >= 48 && eye.height >= 48, `${label}: eye touch target below 48`)
    assert.ok(eye.width <= 64 && eye.height <= 64, `${label}: eye is not compact`)
    const frame = await page.getByTestId('seeker-video-frame').boundingBox()
    assert.ok(Math.abs(frame.width / frame.height - 40 / 89) < 0.001, `${label}: video is not 40:89`)
  }
  if (screen === 'Create') {
    const choose = data.controls.find((item) => /Choose (a|another) video/.test(item.name))
    assert.ok(choose?.visibleFraction > 0.99 && choose.centerHit, `${label}: video chooser clipped`)
    assert.ok(choose.bounds.height >= 48, `${label}: video chooser below 48`)
    assert.ok(choose.bounds.bottom <= data.fields.bounds.bottom + 1, `${label}: preview exceeds composer`)
    assert.ok(
      chosen['Post caption'].bounds.bottom <= data.fields.bounds.bottom + 1,
      `${label}: caption exceeds composer`,
    )
    assert.ok(data.fields.bounds.bottom <= data.footer.bounds.top, `${label}: composer overlaps footer`)
    assert.ok(chosen['Connect wallet to publish'].bounds.height >= 48, `${label}: publish below 48`)
  }
  reports.push({ label, screen, viewport: data.viewport, passed: true })
  return data
}

async function open(context) {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(origin)
  await page.waitForLoadState('networkidle')
  await page.getByRole('tab', { name: 'Create', exact: true }).waitFor()
  return { page, errors }
}

const tab = (page, name) => page.getByRole('tab', { name, exact: true }).click()
const button = (page, name) => page.getByRole('button', { name, exact: true })
async function selectVideo(page) {
  const chooser = page.waitForEvent('filechooser')
  await button(page, 'Choose a video').click()
  await (await chooser).setFiles('apps/mobile/assets/media/sample-001.mp4')
  await button(page, 'Choose another video').waitFor()
  await page.locator('[data-testid="create-composer"] video').waitFor()
}
async function scrollers(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('*')]
      .filter(
        (element) =>
          element.clientHeight > 0 &&
          element.scrollHeight > element.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(element).overflowY),
      )
      .map((element) => ({ tag: element.tagName, testId: element.getAttribute('data-testid') })),
  )
}

try {
  for (const [width, height, deviceScaleFactor] of [
    [400, 890, 3],
    [390, 844, 1],
    [360, 640, 1],
    [320, 568, 1],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    })
    const { page, errors } = await open(context)
    for (const screen of ['Feed', 'Create', 'Discover']) {
      if (screen !== 'Feed') await tab(page, screen)
      await page.waitForTimeout(250)
      await measure(page, `final-${width}x${height}-${screen.toLowerCase()}`, screen)
      if (screen === 'Create') {
        await selectVideo(page)
        await page
          .getByRole('textbox', { name: 'Post caption' })
          .fill('Viewport review. '.repeat(20).slice(0, 280))
        await measure(page, `final-${width}x${height}-create-selected`, screen)
        await button(page, 'Connect wallet to publish').click()
        await page.getByRole('dialog').waitFor()
        await button(page, 'Close').click()
      }
      if (screen === 'Discover') {
        await page.getByRole('textbox', { name: 'Search posts or creators' }).fill('Sintel')
        await measure(page, `final-${width}x${height}-search-results`, screen)
      }
    }
    assert.deepEqual(errors, [])
    await context.close()
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 3 })
  const { page, errors } = await open(context)
  for (const screen of ['Feed', 'Create', 'Discover']) {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await tab(page, screen)
    await page.setViewportSize({ width: 400, height: 890 })
    await page.waitForTimeout(350)
    await measure(page, `final-desktop-resize-${screen.toLowerCase()}`, screen)
  }
  await tab(page, 'Feed')
  const eye = button(page, 'Back this post')
  await eye.waitFor()
  const eyeBefore = await eye.boundingBox()
  await page.evaluate(() => {
    window.eyeTrace = []
    document.querySelector('[data-testid="vertical-video-feed"]').addEventListener('scroll', (event) => {
      const element = document.querySelector('[aria-label="Back this post"]')
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      window.eyeTrace.push({
        offset: event.target.scrollTop,
        x: box.x,
        y: box.y,
        hit: !!hit && element.contains(hit),
      })
    })
  })
  await page.mouse.move(190, 400)
  await page.mouse.wheel(0, 890)
  await page.waitForFunction(
    () => document.querySelector('[data-testid="vertical-video-feed"]').scrollTop >= 889,
  )
  await page.waitForTimeout(300)
  const interactions = { feedWheelTrace: await page.evaluate(() => window.eyeTrace) }
  assert.ok(interactions.feedWheelTrace.length, 'wheel did not scroll the actual pager')
  for (const point of interactions.feedWheelTrace) {
    assert.ok(Math.abs(point.x - eyeBefore.x) < 0.1 && Math.abs(point.y - eyeBefore.y) < 0.1 && point.hit)
  }
  await measure(page, 'final-seeker-after-wheel', 'Feed')
  await eye.click()
  await page.getByRole('dialog').waitFor()
  await page.screenshot({ path: `${destination}/final-seeker-eye-market.png` })
  await button(page, 'Close').click()
  interactions.eyeOpenedMarket = true
  await tab(page, 'Discover')
  const search = page.getByRole('textbox', { name: 'Search posts or creators' })
  const searchBefore = await search.boundingBox()
  const tabBefore = await page.getByRole('tab', { name: 'Discover', exact: true }).boundingBox()
  interactions.discoverScrollers = await scrollers(page)
  assert.deepEqual(interactions.discoverScrollers, [{ tag: 'DIV', testId: 'discover-results' }])
  await page.mouse.move(190, 500)
  await page.mouse.wheel(0, 700)
  await page.waitForFunction(() => document.querySelector('[data-testid="discover-results"]').scrollTop > 650)
  assert.deepEqual(await search.boundingBox(), searchBefore)
  assert.deepEqual(await page.getByRole('tab', { name: 'Discover', exact: true }).boundingBox(), tabBefore)
  await measure(page, 'final-seeker-discover-scrolled', 'Discover')
  await tab(page, 'Create')
  assert.deepEqual(await scrollers(page), [], 'empty Create must not scroll')
  await selectVideo(page)
  const caption = page.getByRole('textbox', { name: 'Post caption' })
  const draft = 'Typed before resizing. This draft must survive the Seeker preview. '.repeat(5).slice(0, 280)
  await caption.fill(draft)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.setViewportSize({ width: 400, height: 890 })
  await page.waitForTimeout(350)
  assert.equal(await caption.inputValue(), draft)
  assert.equal(await button(page, 'Choose another video').isVisible(), true)
  assert.equal(await page.locator('[data-testid="create-composer"] video').isVisible(), true)
  await measure(page, 'final-seeker-create-preserved-on-resize', 'Create')
  interactions.createDraftPreservedOnResize = true
  for (const viewport of [
    { width: 400, height: 890 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport)
    await page.evaluate(() => {
      for (const element of document.querySelector('[data-testid="create-composer"]').querySelectorAll('*')) {
        const style = getComputedStyle(element)
        if (style.fontFamily.includes('Ionicons')) continue
        if (
          element.tagName === 'TEXTAREA' ||
          [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
        ) {
          if (!element.dataset.originalFontSize) {
            element.dataset.originalFontSize = style.fontSize
            element.dataset.originalLineHeight = style.lineHeight
          }
          element.style.fontSize = `${parseFloat(element.dataset.originalFontSize) * 1.5}px`
          if (element.dataset.originalLineHeight !== 'normal')
            element.style.lineHeight = `${parseFloat(element.dataset.originalLineHeight) * 1.5}px`
        }
      }
    })
    await caption.focus()
    await page.waitForTimeout(250)
    await measure(page, `final-${viewport.width}x${viewport.height}-create-text150`, 'Create')
    await button(page, 'Connect wallet to publish').click()
    await page.getByRole('dialog').waitFor()
    await button(page, 'Close').click()
    assert.equal(await caption.inputValue(), draft)
  }
  assert.deepEqual(errors, [])
  interactions.pageErrors = errors
  await writeFile(`${destination}/interaction-report.json`, `${JSON.stringify(interactions, null, 2)}\n`)
  await writeFile(`${destination}/final-report.json`, `${JSON.stringify(reports, null, 2)}\n`)
  console.log(
    `PASS ${reports.length} viewport checks and wheel, fixed controls, modal, scrolling, draft and enlarged-text interactions.`,
  )
} finally {
  await browser.close()
}
