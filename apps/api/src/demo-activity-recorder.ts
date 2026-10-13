import type { Connection } from '@solana/web3.js'
import { isDeepStrictEqual } from 'node:util'
import type { BuiltTrade, MarketService } from '@clout/markets'
import { ApiError, newProfile, type Repository, type TransactionIntent } from './domain.js'
import { demoWalletLabel, isDemoTrade } from './demo-activity.js'
import { reconcileIntent } from './transactions.js'

/** Privileged operator-script helper. It never signs, sends, or invents indexed events. */
export class DemoActivityRecorder {
  constructor(
    private repository: Repository,
    private markets: MarketService,
    private chain: Connection,
  ) {}

  async savePrepared(built: BuiltTrade): Promise<string> {
    const intent: TransactionIntent = {
      id: built.quoteId,
      wallet: built.owner,
      kind: 'trade',
      postId: built.quote.market.postId,
      envelope: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
      signature: null,
      state: 'prepared',
      createdAt: new Date().toISOString(),
    }
    if (!isDemoTrade(intent) || built.quoteId !== built.quote.id)
      throw new ApiError(
        400,
        'INVALID_DEMO_TRADE',
        'Use a registered demo wallet and its exact devnet market trade.',
      )
    const post = await this.repository.getPost(intent.postId)
    if (
      !post?.demo ||
      post.status !== 'ready' ||
      post.market?.baseMint !== built.quote.market.baseMint ||
      post.market?.dbcPool !== built.quote.market.dbcPool
    )
      throw new ApiError(409, 'DEMO_MARKET_MISMATCH', 'The persisted demo post must match this exact market.')
    if (!(await this.repository.getProfile(intent.wallet))) {
      const label = demoWalletLabel(intent.wallet)!
      await this.repository.ensureProfile(intent.wallet)
      await this.repository.saveProfile({
        ...newProfile(intent.wallet),
        displayName: label,
        handle: label,
        bio: 'Clout operator demo wallet. Trades use valueless devnet test tokens.',
      })
    }
    await this.repository.putIntent(intent)
    const stored = await this.repository.getIntent(intent.id)
    if (
      !stored ||
      stored.wallet !== intent.wallet ||
      stored.kind !== 'trade' ||
      stored.postId !== intent.postId ||
      !isDeepStrictEqual(stored.envelope, intent.envelope)
    )
      throw new ApiError(
        409,
        'DEMO_INTENT_CONFLICT',
        'A different transaction already uses this demo intent ID.',
      )
    return stored.id
  }

  private async intent(id: string, signature: string) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,88}$/.test(signature))
      throw new ApiError(400, 'INVALID_SIGNATURE', 'Invalid transaction signature.')
    const intent = await this.repository.getIntent(id)
    if (!intent || !isDemoTrade(intent))
      throw new ApiError(404, 'DEMO_INTENT_NOT_FOUND', 'Prepared demo intent not found.')
    if (intent.signature && intent.signature !== signature)
      throw new ApiError(409, 'SIGNATURE_MISMATCH', 'This intent already tracks another signature.')
    return intent
  }

  async recordSignature(id: string, signature: string): Promise<void> {
    const intent = await this.intent(id, signature)
    if (['failed', 'expired'].includes(intent.state))
      throw new ApiError(409, 'DEMO_INTENT_TERMINAL', 'Inspect the terminal demo intent before proceeding.')
    if (intent.state === 'finalized' || intent.state === 'confirmed') return
    await this.repository.updateIntent(id, 'pending', signature)
    if ((await this.repository.getIntent(id))?.signature !== signature)
      throw new ApiError(503, 'DEMO_SIGNATURE_NOT_SAVED', 'Signature persistence failed; do not broadcast.')
  }

  async reconcile(id: string, signature: string) {
    const intent = await this.intent(id, signature)
    if (!intent.signature)
      throw new ApiError(409, 'DEMO_SIGNATURE_NOT_SAVED', 'Persist the signature before reconciliation.')
    if (!['finalized', 'failed', 'expired'].includes(intent.state))
      await reconcileIntent(this.repository, this.markets, intent, signature, this.chain)
    const result = await this.repository.getIntent(id)
    return { state: result!.state, signature: result!.signature, postId: intent.postId }
  }
}
