import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const base = process.env.CLOUT_PREVIEW_URL ?? 'http://localhost:8081'
const output = 'artifacts/viewport-review'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const android of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 400, height: 890 },
      deviceScaleFactor: 3,
      ...(android
        ? {
            userAgent:
              'Mozilla/5.0 (Linux; Android 16; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
          }
        : {}),
    })
    if (!android)
      await context.addInitScript(() => {
        sessionStorage.setItem(
          'clout-seeker-wallet-v1',
          JSON.stringify({
            policy: 'clout-seeker-wallet-v1',
            authorization: {
              address: '11111111111111111111111111111111',
              authToken: 'forged-local-cache',
              walletUriBase: 'https://connect.solanamobile.com',
            },
          }),
        )
      })
    const page = await context.newPage()
    const errors = []
    const launches = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (request.url().startsWith('https://connect.solanamobile.com')) launches.push(request.url())
    })
    await page.goto(base)
    await page.getByRole('tab', { name: 'Profile', exact: true }).click()
    await page.getByRole('button', { name: 'Connect your wallet', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    assert.equal(
      await page
        .getByText('Sign in with your Seeker’s built-in wallet. Other wallets are not supported.', {
          exact: true,
        })
        .isVisible(),
      true,
    )
    if (android) {
      assert.equal(
        await page.getByRole('button', { name: 'Connect Seeker wallet', exact: true }).isEnabled(),
        true,
      )
    } else {
      assert.equal(await page.getByRole('button', { name: 'Open on Seeker', exact: true }).isDisabled(), true)
      assert.equal(
        await page
          .getByText('Open Clout in the browser on your Seeker. Desktop browsing is read-only.', {
            exact: true,
          })
          .isVisible(),
        true,
      )
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(launches, [], 'viewing connection UI never launches a wallet')
    await page.screenshot({ path: `${output}/seeker-wallet-${android ? 'android-browser' : 'desktop'}.png` })
    results.push({
      androidPresentation: android,
      desktopCacheIgnored: !android,
      expectedButtonState: true,
      walletLaunches: launches.length,
      pageErrors: errors,
    })
    await context.close()
  }
  await writeFile(`${output}/seeker-wallet-report.json`, `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    'Seeker wallet UI passed: desktop read-only/cache ignored, Android connect available; no wallet requests made.',
  )
} finally {
  await browser.close()
}
