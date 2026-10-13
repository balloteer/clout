import { sampleContent, sampleFilms, sampleMediaPath } from '../../../packages/shared/src/sample-content.js'
import { sampleMarkets } from '../../../packages/shared/src/sample-markets.js'
import {
  allCuratedContent,
  curatedContent,
  originalCuratedContent,
} from '../../../packages/shared/src/curated-content.js'
import type { Post, Profile } from './domain.js'

// Editorial labels are not wallet identities or registered .skr domains.
export const demoProfiles: Profile[] = [
  {
    wallet: 'demo-clout-curation',
    handle: 'Clout curated samples',
    displayName: 'Clout curated samples',
    bio: 'Editorial source videos. Publishers retain attribution and have not endorsed Clout.',
    avatar: null,
    seekerVerified: false,
    reputation: 0,
  },
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
    bio: 'Clout demo-market operator. Devnet test tokens only. Original video publishers retain attribution; their appearance does not imply ownership or endorsement of these markets.',
    avatar: null,
    seekerVerified: false,
    reputation: 0,
  })),
]

const bundledPosts: Post[] = sampleContent.map((post, index) => ({
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

const curatedPosts: Post[] = allCuratedContent.map((post, index) => ({
  id: post.id,
  creatorWallet: sampleMarkets[post.id]?.creatorWallet ?? 'demo-clout-curation',
  caption: post.caption,
  tags: [post.tag.toLowerCase()],
  videoUrl: post.video,
  thumbnailUrl: post.poster,
  status: 'ready',
  streamUid: null,
  market: sampleMarkets[post.id]
    ? { baseMint: sampleMarkets[post.id].baseMint, dbcPool: sampleMarkets[post.id].dbcPool }
    : null,
  createdAt: originalCuratedContent.some((original) => original.id === post.id)
    ? new Date(
        Date.UTC(
          2026,
          9,
          12,
          12,
          1,
          originalCuratedContent.length -
            originalCuratedContent.findIndex((original) => original.id === post.id),
        ),
      ).toISOString()
    : new Date(Date.UTC(2026, 9, 13, 12, 1, curatedContent.length - index)).toISOString(),
  demo: true,
  ...(!curatedContent.some((active) => active.id === post.id) ? { feedHidden: true } : {}),
  source: {
    provider: 'x',
    accountHandle: post.source.handle,
    postId: post.id.replace(/^x-/, ''),
    url: post.source.url,
    publishedAt: post.source.publishedAt,
  },
}))

export const demoPosts: Post[] = [...curatedPosts, ...bundledPosts]
