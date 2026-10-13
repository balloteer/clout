import { sampleContent, sampleFilms, sampleMediaPath } from '../../../packages/shared/src/sample-content.js'
import { sampleMarkets } from '../../../packages/shared/src/sample-markets.js'
import type { Post, Profile } from './domain.js'

// Editorial labels are not wallet identities or registered .skr domains.
export const demoProfiles: Profile[] = [
  ...Object.values(sampleFilms).map((film) => ({
    wallet: film.creatorWallet,
    handle: film.creator,
    displayName: film.creator,
    bio: `${film.title} licensed sample excerpts. ${film.credit}; ${film.license}.`,
    avatar: null,
    seekerVerified: false,
    reputation: 0,
  })),
  ...[...new Set(Object.values(sampleMarkets).map((market) => market.creatorWallet))].map((wallet) => ({
    wallet,
    handle: 'Clout devnet samples',
    displayName: 'Clout devnet samples',
    bio: 'Clout test-market operator for licensed Blender film excerpts. Devnet test tokens only; film attribution remains with each post.',
    avatar: null,
    seekerVerified: false,
    reputation: 0,
  })),
]

export const demoPosts: Post[] = sampleContent.map((post, index) => ({
  id: post.id,
  creatorWallet: sampleMarkets[post.id]?.creatorWallet ?? post.creatorWallet,
  caption: post.caption,
  tags: [post.tag.toLowerCase()],
  videoUrl: sampleMediaPath(post.videoFile),
  thumbnailUrl: sampleMediaPath(post.posterFile),
  status: 'ready',
  streamUid: null,
  market: sampleMarkets[post.id]
    ? { baseMint: sampleMarkets[post.id].baseMint, dbcPool: sampleMarkets[post.id].dbcPool }
    : null,
  // Descending timestamps keep the editorial catalog order in repository feeds.
  createdAt: new Date(Date.UTC(2026, 9, 12, 12, 0, 50 - index)).toISOString(),
  demo: true,
}))
