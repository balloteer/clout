import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import curatedContent from './curated-content.json'
import archivedContent from '../../../../packages/shared/src/archived-curated-content.json'
import { mergePreviewFeed } from './catalog'
import type { ApiPost } from './contracts'
import type { Post } from './data'

function mapper(preview: Post[]) {
  const path = [resolve('src/lib/contracts.ts'), resolve('apps/mobile/src/lib/contracts.ts')].find(existsSync)
  assert.ok(path)
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exported: Record<string, unknown> = {}
  runInNewContext(source, {
    exports: exported,
    module: { exports: exported },
    require: (name: string) => {
      if (name === './data') return { allCatalogPosts: preview }
      if (name === './profile-name')
        return {
          profileName: (handle?: string) =>
            handle?.toLowerCase().endsWith('.skr') ? handle.slice(0, -4) : handle,
        }
      throw new Error(`Unexpected dependency: ${name}`)
    },
  })
  return exported.mapPost as (post: ApiPost) => Post
}

for (const [original, fit] of [
  [curatedContent[0], 'cover'],
  [archivedContent[0], 'contain'],
] as const)
  test(`API hydration retains ${fit} media, publisher attribution and market ownership for ${original.id}`, () => {
    const preview: Post = {
      ...original,
      avatar: 'S',
      color: '#C6FF3D',
      videoFit: fit,
      duration: '0:53',
      market: false,
      sample: true,
      likes: 0,
      comments: 0,
      views: '',
      backers: 0,
    }
    const hydrated = mapper([preview])({
      id: original.id,
      creatorWallet: 'clout-demo-operator',
      caption: original.caption,
      videoUrl: original.video,
      thumbnailUrl: original.poster,
      tags: ['solana'],
      demo: true,
      market: { baseMint: 'verified-post-mint', dbcPool: 'verified-post-pool' },
      creator: {
        wallet: 'clout-demo-operator',
        handle: 'Clout devnet samples',
        displayName: 'Clout demo',
        seekerVerified: false,
      },
      source: {
        provider: 'x',
        accountHandle: original.source.handle,
        postId: original.id.slice(2),
        url: original.source.url,
        publishedAt: original.source.publishedAt,
      },
    })
    const [post] = mergePreviewFeed([preview], [hydrated])
    assert.equal(post.market, true)
    assert.equal(post.creatorWallet, 'clout-demo-operator')
    assert.equal(
      post.creator,
      original.creator,
      'publisher label is retained without assigning the publisher wallet ownership',
    )
    assert.deepEqual(post.source, original.source)
    assert.equal(post.videoFit, fit)
    assert.equal(post.video, original.video)
  })

test('API source attribution remains available for owned imported videos outside the bundled catalog', () => {
  const post = mapper([])({
    id: 'owned-import',
    creatorWallet: 'owner',
    caption: 'Original video',
    videoUrl: 'https://media.example/video.mp4',
    thumbnailUrl: 'https://media.example/poster.jpg',
    tags: ['community'],
    market: null,
    demo: false,
    source: {
      provider: 'x',
      accountHandle: 'owned-account',
      postId: '123',
      url: 'https://x.com/owned-account/status/123',
      publishedAt: '2026-10-13T00:00:00Z',
    },
  })
  assert.equal(post.source?.url, 'https://x.com/owned-account/status/123')
  assert.equal(post.source?.handle, 'owned-account')
  assert.equal(post.source?.publishedAt, '2026-10-13T00:00:00Z')
  assert.equal(post.market, false)
  assert.equal(post.sample, false)
})
