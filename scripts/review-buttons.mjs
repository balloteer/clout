import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const destination = 'artifacts/review-buttons'
await mkdir(destination, { recursive: true })
const browser = await chromium.launch({ headless: true })
const report = []
try {
  for (const viewport of [
    { width: 400, height: 890 },
    { width: 320, height: 712 },
  ]) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(process.env.CLOUT_PREVIEW_URL ?? 'http://127.0.0.1:8081')
    await page.waitForLoadState('networkidle')
    const tab = (name) => page.getByRole('tab', { name, exact: true }).click()
    const button = (name) => page.getByRole('button', { name, exact: true })
    const shot = (name) =>
      page.screenshot({ path: `${destination}/${name}-${viewport.width}.png`, fullPage: true })
    await tab('Collection')
    await button('Find something worth saving').click()
    await button('Back this post').waitFor()
    await tab('Discover')
    await page.getByRole('textbox', { name: 'Search posts or creators' }).waitFor()
    const initialPostCount = await page.getByRole('button', { name: /^View .* post$/ }).count()
    await page
      .getByRole('textbox', { name: 'Search posts or creators' })
      .fill('Every adventure starts somewhere')
    assert.equal(await page.getByRole('button', { name: /View .* post/ }).count(), 1)
    await button('Clear search').click()
    assert.equal(await page.getByRole('button', { name: /^View .* post$/ }).count(), initialPostCount)
    const animationCount = await page
      .getByRole('button', { name: /^View .* post$/ })
      .filter({ has: page.getByText('Animation', { exact: true }) })
      .count()
    assert.ok(animationCount > 0)
    await button('Animation').click()
    assert.equal(await page.getByRole('button', { name: /^View .* post$/ }).count(), animationCount)
    await button('All').click()
    await button('Follow Bunny · sample').click()
    await button('Unfollow Bunny · sample').waitFor()
    await shot('discover-follow')
    await button('View Sintel · sample post').first().click()
    for (const destination of ['Profile', 'Discover', 'Collection']) {
      await tab(destination)
      await tab('Feed')
      assert.match(await page.getByTestId('seeker-video-frame').innerText(), /Sintel · sample/)
    }
    await button('Share').click()
    await page.getByText('Sharing is unavailable in this browser.', { exact: true }).waitFor()
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (payload) => {
          window.__reviewShare = payload
        },
      }),
    )
    await button('Share').click()
    const share = await page.evaluate(() => window.__reviewShare)
    assert.match(share.text, /Every adventure starts somewhere/)
    await swipeVideo(page, 1)
    const browsedCreator = await page.getByTestId('post-creator').innerText()
    await tab('Profile')
    await tab('Feed')
    const returnedText = await page.getByTestId('seeker-video-frame').innerText()
    const browsePositionPreserved = returnedText.includes(browsedCreator)
    await writeFile(
      `${destination}/navigation-${viewport.width}.json`,
      JSON.stringify({ browsedCreator, returnedText, browsePositionPreserved }, null, 2),
    )
    assert.ok(browsePositionPreserved, 'Browsing to another post must survive leaving and returning to Feed')
    await tab('Discover')
    await button('View Bunny · sample post').first().click()
    const chosenCreator = await page.getByTestId('post-creator').innerText()
    assert.equal(chosenCreator, 'Bunny · sample', 'Discover must open the selected creator')
    await button('Save post').click()
    await tab('Collection')
    await writeFile(
      `${destination}/saved-${viewport.width}.json`,
      JSON.stringify(
        {
          chosenCreator,
          collection: await page.locator('body').innerText(),
          savedPreferences: await page.evaluate(() => localStorage.getItem('clout:preferences')),
        },
        null,
        2,
      ),
    )
    await shot('collection-saved')
    await button('Open saved post by Bunny · sample').click()
    await button('Open comments').click()
    await page.getByRole('dialog').waitFor()
    assert.equal(await button('Post comment').getAttribute('aria-disabled'), 'true')
    const closeBounds = await button('Close').boundingBox()
    assert.ok(closeBounds && closeBounds.width >= 48 && closeBounds.height >= 48)
    assert.ok(closeBounds.x >= 0 && closeBounds.x + closeBounds.width <= viewport.width)
    await shot('comments')
    await button('Close').click()
    await button('Back this post').click()
    assert.match(await page.getByRole('dialog').innerText(), /no market|Get quote/)
    await page.getByRole('tab', { name: 'Sell position', exact: true }).click()
    assert.equal(
      await page.getByRole('tab', { name: 'Sell position', exact: true }).getAttribute('aria-selected'),
      'true',
    )
    await button('Close').click()
    await tab('Collection')
    await page.getByRole('tab', { name: 'Positions', exact: true }).click()
    await button('Connect wallet').click()
    assert.equal(await button('Open on Seeker').isDisabled(), true)
    assert.match(await page.getByRole('dialog').innerText(), /Desktop browsing is read-only/)
    await button('Close').click()
    await tab('Create')
    const emptyConnectDisabled = await button('Connect wallet to publish').getAttribute('aria-disabled')
    assert.notEqual(emptyConnectDisabled, 'true')
    await button('Connect wallet to publish').click()
    await page.getByRole('dialog').waitFor()
    await button('Close').click()
    await shot('create-empty')
    const chooserPromise = page.waitForEvent('filechooser')
    await button('Choose a video').click()
    await (await chooserPromise).setFiles('apps/mobile/assets/media/sample-001.mp4')
    await button('Choose another video').waitFor()
    await page.getByRole('textbox', { name: 'Post caption' }).fill('Button review, local file only')
    assert.notEqual(await button('Connect wallet to publish').getAttribute('aria-disabled'), 'true')
    await button('Connect wallet to publish').click()
    await page.getByRole('dialog').waitFor()
    await button('Close').click()
    assert.equal(
      await page.getByRole('textbox', { name: 'Post caption' }).inputValue(),
      'Button review, local file only',
    )
    await tab('Profile')
    await button('Connect your wallet').click()
    await button('Close').click()
    await button('Connect wallet to link accounts').click()
    await page.getByRole('dialog').waitFor()
    await shot('profile-connect')
    await button('Close').click()
    await button('Mint mock SKR').last().click()
    await button('Connect Seeker wallet to mint').click()
    await page.getByRole('dialog').waitFor()
    await button('Close').click()
    await button('Open menu').click()
    await button('Go to Feed').click()
    await button('Pause video').waitFor()
    assert.deepEqual(errors, [])
    report.push({
      viewport,
      passed: [
        'collection explore',
        'search and clear',
        'category filters',
        'sample follow',
        'post navigation',
        'selected discovery survives repeated tabs',
        'browsed video survives leaving and returning to feed',
        'share unsupported feedback and successful payload',
        'empty create connects wallet',
        'bookmark and reopen',
        'comments preview gate',
        'market preview gate and tabs',
        'positions wallet gate',
        'file chooser',
        'caption preserved across sheet',
        'profile connect',
        'linked accounts wallet gate',
        'profile faucet shortcut and wallet gate',
        'mobile menu navigation',
      ],
      emptyConnectDisabled,
      browsePositionPreserved,
      closeBounds,
      errors,
    })
    await page.close()
  }
} finally {
  await browser.close()
  await writeFile(`${destination}/interaction-results.json`, JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report, null, 2))

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
