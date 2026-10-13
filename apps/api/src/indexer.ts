import type { IndexedEvent, Repository } from './domain.js'

export interface ChainTransaction {
  signature: string
  slot: number
  failed: boolean
  finalized: boolean
}
export interface ChainEventSource {
  fetch(signature: string): Promise<ChainTransaction | null>
  /** Decode known protocol instructions and token balance changes, never caller-supplied logs. */
  decode(transaction: ChainTransaction): Promise<Omit<IndexedEvent, 'signature' | 'slot' | 'finality'>[]>
  signaturesSince(checkpoint: string | null): AsyncIterable<string>
}
/** Webhooks only enqueue signatures. Chain data is the authority for the resulting records. */
export class TransactionIndexer {
  constructor(
    private repository: Repository,
    private source: ChainEventSource,
    private sourceId: string,
  ) {}
  async ingest(signature: string) {
    const transaction = await this.source.fetch(signature)
    if (!transaction) return false
    const decoded = transaction.failed ? [] : await this.source.decode(transaction)
    const events: IndexedEvent[] = decoded.map((event) => ({
      ...event,
      signature: transaction.signature,
      slot: transaction.slot,
      finality: transaction.finalized ? 'finalized' : 'confirmed',
    }))
    await this.repository.ingest(events, { source: this.sourceId, signature, slot: transaction.slot })
    return true
  }
  async backfill(checkpoint: string | null) {
    for await (const signature of this.source.signaturesSince(checkpoint)) await this.ingest(signature)
  }
  async reconcile(signature: string) {
    const transaction = await this.source.fetch(signature)
    if (transaction?.finalized)
      await this.repository.reconcile(signature, transaction.failed ? 'dropped' : 'finalized')
    // A temporarily missing RPC response is not proof of a dropped transaction.
  }
}
