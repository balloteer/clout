import assert from 'node:assert/strict'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { PostgresRepository } from '../src/postgres.js'
import { MemoryRepository } from '../src/memory.js'
import { positionPerformance } from '../src/portfolio.js'
import type { IndexedEvent } from '../src/domain.js'

function repositoryFor(db: PGlite) {
  const sql = Object.assign(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
      return (await db.query(query, values)).rows
    },
    { json: (value: unknown) => JSON.stringify(value) },
  )
  const repository = Object.create(PostgresRepository.prototype) as PostgresRepository
  Object.defineProperty(repository, 'sql', { value: sql })
  return repository
}

test('full SQL position totals retain old closed trades beyond the recent-event limit', async () => {
  const db = new PGlite()
  const repository = repositoryFor(db)
  const memory = new MemoryRepository(false)
  try {
    await db.exec(`create schema private;
      create table private.indexed_events(signature text, instruction_path text, slot bigint, wallet text, post_id text, finality text, data jsonb);`)
    const event = (
      signature: string,
      slot: number,
      kind: 'buy' | 'sell',
      baseAmount: string,
      quoteAmount: string,
    ): IndexedEvent => ({
      signature,
      slot,
      kind,
      baseAmount,
      quoteAmount,
      instructionPath: 'verified-intent',
      wallet: 'owner',
      postId: 'post',
      finality: 'finalized',
    })
    const trades = [
      event('old-buy', 1, 'buy', '9007199254740993', '100'),
      event('old-sell', 2, 'sell', '9007199254740993', '120'),
      event('recent-buy', 1003, 'buy', '10', '10'),
    ]
    for (const trade of trades)
      await db.query('insert into private.indexed_events values($1,$2,$3,$4,$5,$6,$7)', [
        trade.signature,
        trade.instructionPath,
        trade.slot,
        trade.wallet,
        trade.postId,
        trade.finality,
        trade,
      ])
    await db.exec(`insert into private.indexed_events
      select 'filler-'||n,'verified-intent',n,'owner','other-post','finalized',
      jsonb_build_object('kind','buy','baseAmount','1','quoteAmount','1','postId','other-post')
      from generate_series(3,1002) n;
      insert into private.indexed_events values('unrelated','verified-intent',1004,'another-owner','post','finalized',
      '{"kind":"buy","baseAmount":"99999","quoteAmount":"99999"}');`)
    const recent = await repository.getEvents('owner')
    assert.equal(recent.length, 1000)
    assert.equal(recent.filter((item) => item.postId === 'post').length, 1)
    const total = (await repository.getPositionHistory('owner')).find((item) => item.postId === 'post')!
    assert.deepEqual(total, {
      postId: 'post',
      boughtBaseAmount: '9007199254741003',
      soldBaseAmount: '9007199254740993',
      boughtQuoteAmount: '110',
      soldQuoteAmount: '120',
    })
    assert.equal(positionPerformance('10', '20', total).profitLossQuoteAmount, '30')
    await memory.ingest(trades, { source: 'test', signature: 'recent-buy', slot: 1003 })
    assert.deepEqual(await memory.getPositionHistory('owner'), [total])
    assert.deepEqual(await repository.getPositionHistory('no-events'), [])
  } finally {
    await db.close()
  }
})

test('SQL intent signature CAS has one winner and never changes a finalized signature', async () => {
  const db = new PGlite()
  const repository = repositoryFor(db)
  try {
    await db.exec(`create schema private;
      create table private.transaction_intents(id text primary key, state text not null, signature text unique, data jsonb not null);
      insert into private.transaction_intents values('intent','prepared',null,'{"id":"intent","state":"prepared","signature":null}');`)
    const updates = await Promise.all([
      repository.updateIntent('intent', 'confirmed', 'signature-a'),
      repository.updateIntent('intent', 'confirmed', 'signature-b'),
    ])
    assert.equal(updates.filter(Boolean).length, 1)
    const stored = (await repository.getIntent('intent'))!
    const winner = stored.signature!
    const loser = winner === 'signature-a' ? 'signature-b' : 'signature-a'
    assert.equal(await repository.updateIntent('intent', 'finalized', winner), true)
    assert.equal(await repository.updateIntent('intent', 'confirmed', loser), false)
    assert.equal(await repository.updateIntent('intent', 'pending', winner), false)
    assert.equal((await repository.getIntent('intent'))?.signature, winner)
    assert.equal((await repository.getIntent('intent'))?.state, 'finalized')
    assert.equal(await repository.updateIntent('absent', 'confirmed', winner), false)
  } finally {
    await db.close()
  }
})
