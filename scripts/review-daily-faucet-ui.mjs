import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'

// UI fixtures only: the cached identity is not proof of wallet authentication.
// Every API call is intercepted; this runner never requests a real faucet claim.
const base = process.env.CLOUT_API_PREVIEW_URL ?? 'http://localhost:8082'
const output = 'artifacts/viewport-review'
const address = '11111111111111111111111111111111'
const signature = '1'.repeat(88)
const resetAt = new Date(Date.now() + 3_600_000).toISOString()
const cases = [
  { name: 'available', button: 'Mint 1000 mock SKR', available: true, claim: null },
  { name: 'claimed', button: 'Daily allocation claimed', state: 'finalized', badge: 'Received · finalized' },
  { name: 'pending', button: 'Claim pending', state: 'submitted', badge: 'Waiting for confirmation' },
  { name: 'needs-review', button: 'Claim needs review', state: 'expired', badge: 'Needs review' },
]
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []
try {
  for (const scenario of cases) {
    const context = await browser.newContext({
      viewport: { width: 400, height: 890 },
      deviceScaleFactor: 3,
      userAgent:
        'Mozilla/5.0 (Linux; Android 16; Seeker) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
    })
    await context.addInitScript(
      ({ address }) => {
        sessionStorage.setItem(
          'clout-seeker-wallet-v1',
          JSON.stringify({
            policy: 'clout-seeker-wallet-v1',
            authorization: {
              address,
              authToken: 'test-fixture-only',
              walletUriBase: 'https://connect.solanamobile.com',
            },
            session: {
              token: 'test-fixture-only',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              profile: { name: 'UI fixture', seeker: false },
            },
          }),
        )
      },
      { address },
    )
    const claim = scenario.state
      ? {
          id: `ui-fixture-${scenario.name}`,
          state: scenario.state,
          signature: scenario.state === 'finalized' ? signature : null,
          amount: '1000000000',
          createdAt: new Date().toISOString(),
          needsReview: scenario.name === 'needs-review',
        }
      : null
    const status = {
      available: !!scenario.available,
      symbol: 'SKR',
      label: 'Mock SKR',
      network: 'devnet',
      mint: address,
      amount: '1000000000',
      decimals: 6,
      cooldownSeconds: 0,
      nextClaimAt: scenario.available ? null : resetAt,
      period: 'utc-day',
      resetAt,
      dailyLimit: '1000000000',
      claimedAmount: scenario.available ? '0' : '1000000000',
      remainingAmount: scenario.available ? '1000000000' : '0',
      claim,
    }
    const requests = []
    await context.route('**/v1/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      requests.push({ path, method: request.method() })
      const body =
        path === '/v1/faucet'
          ? status
          : path === '/v1/feed'
            ? { posts: [], following: [] }
            : path === '/v1/config'
              ? {
                  name: 'Clout',
                  slogan: 'Seek the best content, win SKR',
                  mode: 'demo',
                  network: 'devnet',
                  rewardSymbol: 'SKR',
                  quoteTokenLabel: 'Mock SKR',
                  quoteMint: address,
                  quoteDecimals: 6,
                  features: {
                    trading: false,
                    uploads: false,
                    seekerVerification: false,
                    rewards: false,
                    linkedAccounts: false,
                    faucet: true,
                  },
                }
              : {}
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': new URL(base).origin, 'access-control-allow-headers': '*' },
        body: JSON.stringify(body),
      })
    })
    await context.route('https://explorer.solana.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: 'UI receipt destination fixture' }),
    )
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(base)
    await page.getByRole('button', { name: 'Open menu', exact: true }).click()
    await page.getByRole('button', { name: 'Go to Mint mock SKR', exact: true }).click()
    const button = page.getByRole('button', { name: scenario.button, exact: true })
    await button.waitFor()
    // Measure before clicking: Playwright must not scroll the primary action into view.
    const geometry = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      let clipped = false
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          const bounds = parent.getBoundingClientRect()
          if (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) clipped = true
        }
      }
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        clipped,
        hit: hit === element || element.contains(hit),
        pageOverflow: document.documentElement.scrollHeight > innerHeight + 1,
      }
    })
    assert.ok(
      geometry.y >= 0 && geometry.y + geometry.height <= 830 && !geometry.clipped,
      `${scenario.name}: primary action clipped`,
    )
    assert.ok(geometry.width >= 48 && geometry.height >= 48)
    assert.equal(geometry.pageOverflow, false)
    assert.equal(await button.isDisabled(), !scenario.available)
    if (scenario.available) assert.equal(geometry.hit, true)
    await page.screenshot({ path: `${output}/daily-faucet-${scenario.name}.png` })
    if (scenario.badge) await page.getByText(scenario.badge, { exact: true }).waitFor()
    let receiptUrl = null
    if (scenario.name === 'claimed') {
      const popup = page.waitForEvent('popup')
      await page.getByRole('button', { name: 'View devnet receipt', exact: true }).click()
      const receipt = await popup
      await receipt.waitForLoadState('domcontentloaded')
      receiptUrl = receipt.url()
      assert.equal(receiptUrl, `https://explorer.solana.com/tx/${signature}?cluster=devnet`)
    }
    assert.ok(requests.some((request) => request.path === '/v1/faucet'))
    assert.ok(
      requests.every((request) => ['GET', 'OPTIONS'].includes(request.method)),
      'fixture rendering must not submit a claim',
    )
    assert.deepEqual(errors, [])
    results.push({
      scenario: scenario.name,
      identity: 'explicit cached UI fixture; not authentication proof',
      geometry,
      receiptUrl,
      requests,
      errors,
    })
    await context.close()
  }
  await writeFile(`${output}/daily-faucet-ui-report.json`, `${JSON.stringify(results, null, 2)}\n`)
  console.log(
    'Daily faucet UI passed: 400×890 available/claimed/pending/review states, primary action fit, devnet receipt; fixtures only.',
  )
} finally {
  await browser.close()
}
