import { allCatalogPosts, type Post } from './data'
export type ApiProfile = { wallet: string; handle: string; displayName: string; seekerVerified: boolean }
export type ApiPost = {
  id: string
  creatorWallet: string
  caption: string
  status?: 'processing' | 'ready' | 'failed'
  videoUrl: string | null
  thumbnailUrl: string | null
  tags: string[]
  market: { baseMint: string; dbcPool: string } | null
  demo: boolean
  creator?: ApiProfile
  likes?: { count: number; liked: boolean }
  commentCount?: number
  source?: {
    provider: 'x' | 'fomo'
    accountHandle: string
    postId: string
    url: string
    publishedAt?: string
  }
}
export function mapPost(post: ApiPost, index = 0): Post {
  // Licensed bundled content stays available when a verified devnet market is attached.
  const bundled = allCatalogPosts.find((sample) => sample.id === post.id)
  return {
    id: post.id,
    creatorWallet: post.creatorWallet,
    creator:
      bundled?.creator ??
      post.creator?.handle ??
      `${post.creatorWallet.slice(0, 4)}…${post.creatorWallet.slice(-4)}`,
    avatar: bundled?.avatar ?? post.creator?.displayName?.slice(0, 1) ?? 'S',
    caption: post.caption,
    tag: bundled?.tag ?? post.tags[0] ?? 'Community',
    color: bundled?.color ?? ['#C6FF3D', '#FF3D8B', '#3DB8FF'][index % 3],
    poster: bundled?.poster ?? post.thumbnailUrl ?? '',
    video: bundled?.video ?? post.videoUrl ?? '',
    videoFit: bundled?.videoFit,
    source:
      bundled?.source ??
      (post.source?.publishedAt
        ? {
            url: post.source.url,
            handle: post.source.accountHandle,
            publishedAt: post.source.publishedAt,
          }
        : undefined),
    likes: post.likes?.count ?? 0,
    comments: post.commentCount ?? 0,
    views: '',
    backers: 0,
    market: !!post.market,
    sample: post.demo,
    duration: bundled?.duration ?? '',
  }
}
export type Portfolio = {
  positions: {
    post: ApiPost
    amount: string
    baseDecimals: number
    sellQuote: {
      expectedAmountOut: string
      minimumAmountOut: string
      inputDecimals: number
      outputDecimals: number
    } | null
    boughtQuoteAmount: string
    soldQuoteAmount: string
    netInvestedQuoteAmount: string | null
    backingAvailable: boolean
    performanceAvailable: boolean
    profitLossQuoteAmount: string | null
    returnBps: string | null
    earlyBacker: boolean
  }[]
  events: {
    signature: string
    postId: string
    kind: 'buy' | 'sell'
    baseAmount: string
    quoteAmount: string
  }[]
  balance: { amount: string; decimals: number; symbol: string; mint: string } | null
  gasLamports?: string
  valuationAvailable: boolean
}
