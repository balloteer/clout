/** Generates only public devnet metadata; no keys, environment files, or app source are deployed. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { sampleContent } from '../../shared/src/sample-content.js'
const output = resolve('artifacts/devnet-catalog')
const origin = process.env.CLOUT_SAMPLE_METADATA_ORIGIN ?? 'https://clout-devnet-catalog.vercel.app'
if (new URL(origin).protocol !== 'https:') throw new Error('Metadata origin must use HTTPS.')
await mkdir(`${output}/metadata`, { recursive: true })
await mkdir(`${output}/posts`, { recursive: true })
await writeFile(`${output}/icon.png`, await readFile('apps/mobile/assets/brand/icon.png'))
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
const layout = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{background:#15121c;color:#fff9ee;font:16px/1.6 system-ui;margin:0;padding:28px;max-width:780px}a{color:#c6ff3d}h1{line-height:1.2}li{margin:16px 0}small{color:#c1b9c9}</style><h1>${escapeHtml(title)}</h1>${body}</html>`
for (const post of sampleContent) {
  const number = String(post.ordinal).padStart(3, '0')
  const metadata = {
    name: `Clout sample ${number}`,
    symbol: `POST${number}`,
    description: `${post.caption} Licensed sample excerpt from ${post.title}. ${post.credit}. ${post.license}: ${post.licenseUrl} Edited to a ${post.durationSeconds}-second portrait excerpt. Early alpha, Solana devnet only. Post position token quoted in mock SKR; no monetary value.`,
    image: `${origin}/icon.png`,
    external_url: `${origin}/posts/${post.id}.html`,
    attributes: [
      { trait_type: 'Network', value: 'Solana devnet' },
      { trait_type: 'Quote token', value: 'Mock SKR' },
      { trait_type: 'Post ID', value: post.id },
      { trait_type: 'License', value: post.license },
    ],
    properties: {
      category: 'video',
      source: post.sourcePage,
      license: post.licenseUrl,
      attribution: post.credit,
      excerpt_start_seconds: post.sourceStartSeconds,
      duration_seconds: post.durationSeconds,
      transformations: `${post.durationSeconds}-second excerpt, portrait crop, resized to 480 × 1068, re-encoded H.264/AAC.`,
    },
  }
  await writeFile(`${output}/metadata/${post.id}.json`, JSON.stringify(metadata, null, 2) + '\n')
  await writeFile(
    `${output}/posts/${post.id}.html`,
    layout(
      post.caption,
      `<p>Clout sample ${number}. Early alpha. Solana devnet only.</p><p>Seek the best content, win SKR</p><p>This licensed ${post.durationSeconds}-second sample has no monetary value. Any Clout devnet market uses mock SKR.</p><p>${escapeHtml(post.credit)}</p><p><a href="${post.licenseUrl}">${post.license}</a> · <a href="${post.sourcePage}">Original film and source</a></p><p>Changes: ${post.durationSeconds}-second excerpt starting at ${post.sourceStartSeconds}s, portrait crop, resized and re-encoded.</p><p><a href="/metadata/${post.id}.json">Token metadata JSON</a> · <a href="/">Catalog</a></p>`,
    ),
  )
}
await writeFile(
  `${output}/index.html`,
  layout(
    'Clout devnet sample catalog',
    `<p>Seek the best content, win SKR</p><p><strong>Early alpha · Devnet only.</strong> Mock SKR and post position tokens have no monetary value. This catalog publishes metadata for licensed app samples.</p><ul>${sampleContent.map((p) => `<li><a href="/posts/${p.id}.html">${escapeHtml(p.caption)}</a><br><small>${escapeHtml(p.credit)} · ${p.license}</small></li>`).join('')}</ul>`,
  ),
)
await writeFile(
  `${output}/vercel.json`,
  JSON.stringify(
    {
      version: 2,
      headers: [
        {
          source: '/metadata/(.*)',
          headers: [
            { key: 'Access-Control-Allow-Origin', value: '*' },
            { key: 'Cache-Control', value: 'public, max-age=3600' },
          ],
        },
      ],
    },
    null,
    2,
  ) + '\n',
)
console.log(`Prepared ${sampleContent.length} licensed metadata records in ${output}.`)
