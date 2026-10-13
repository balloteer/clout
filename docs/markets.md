# SKR post markets

`@clout/markets` is the Node service boundary for Meteora. The mobile app never imports its legacy Solana classes. Quotes and transactions cross the API as plain objects and integer strings.

Clout uses SKR for backing, sales, creator earnings and rewards. SOL is needed only for Solana network fees and account rent. The official mainnet SKR mint is `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`, with six decimals. Sources: [Solana Mobile SKR FAQ](https://solanamobile.com/skr) and the [official SKR sample](https://github.com/solana-mobile/react-native-samples/blob/main/skr-staking/src/app/index.tsx). The sample's executable decimal constant is six; its nearby comment says nine incorrectly. This adapter reads the configured mint onchain and checks the decimals before quoting.

This build permits **devnet only**. Devnet requires a separately provisioned SPL test mint, displayed as **Test SKR**. It rejects both native SOL and the official mainnet SKR address as its devnet quote mint. It does not create a CLOUT currency or claim that devnet balances are real SKR. Each chain operation checks the RPC genesis hash, so relabeling a mainnet URL as devnet cannot enable mainnet transactions.

## Setup and current state

No onchain mint, market configuration, market pool or funded treasury has been created by this implementation. A funded devnet wallet, a Test SKR mint and funded test balances are prerequisites for the two-wallet rehearsal. The service returns configuration errors until these are supplied. It never substitutes simulated trades for wallet assets.

```ts
import { createMarketService } from '@clout/markets'

const markets = createMarketService({
  cluster: 'devnet',
  rpcUrl: process.env.SOLANA_DEVNET_RPC_URL!,
  quoteMint: process.env.SKR_DEVNET_MINT!,
  quoteDecimals: 6,
  dbcConfigAddress: process.env.METEORA_DBC_CONFIG!,
})
```

Keep RPC credentials on the API server. Supply all mint/configuration addresses explicitly. Do not include this package in the Expo dependency graph. API environment names are defined in `apps/api/.env.example`; the sample above illustrates the package API rather than loading environment variables inside it.

## Configuration and launch

`buildConfig({ payer, feeClaimer, leftoverReceiver, migrationThresholdTokens })` produces a simulated transaction for creating the reusable Clout curve. It does not submit it. The wallet must review and sign before submission; only the newly generated configuration account is partially signed by the service.

The generated configuration has:

| Setting                                | Value                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Quote currency                         | Explicit Test SKR SPL mint                                                            |
| Post position supply                   | 1 billion, six decimals, fixed before/after graduation                                |
| Post mint authority policy             | Immutable                                                                             |
| Bonding-curve trading fee              | Fixed 100 bps; dynamic fees disabled; charged in quote token                          |
| Creator share                          | 50% of the trading fee remaining after protocol fees                                  |
| DAMM v2 fee                            | Explicit customizable configuration: 100 bps, quote-token fees, dynamic fees disabled |
| Graduated liquidity ownership          | 50% creator / 50% partner, permanently locked, with fee claims                        |
| Position supply allocated to migration | 20%                                                                                   |
| Graduation threshold                   | Caller explicitly chooses 1–1,000,000 whole Test SKR                                  |
| Token vesting / leftover allocation    | None                                                                                  |

The DBC protocol currently receives 20% of trading fees. A 1% total DBC fee therefore leaves approximately 0.4% of trade value each for the creator and partner. DAMM v2 fees follow its actual pool and position accounting; do not reuse the DBC split as a promise for migrated pools. [Official DBC SDK](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk), [DBC fee formulas](https://docs.meteora.ag/core-products/dbc/formulas).

After confirming the configuration transaction, configure the returned address and call:

```ts
const launch = await markets.buildLaunch({
  postId: post.id,
  creator: authenticatedWallet,
  name: 'Late Night Cat',
  symbol: 'CAT',
  metadataUri: 'https://your-clout-domain.example/metadata/post-id.json',
})
```

The metadata URI must point to previously published JSON containing the post thumbnail and canonical post URL. Launch returns a `market` mapping (`postId`, `baseMint`, `dbcPool`) plus a transaction envelope. Keep the post in a pending-launch state until `reconcile` confirms the exact built message, then read `inspectMarket` and enable backing. Failed or expired launches must not create active market mappings.

Launch validates fixed supply, mint authority, quote currency, six post decimals and the proposed fee policy against the existing configuration. No configuration is created implicitly when a user uploads a video. New mint keys are short-lived account co-signers, never exposed or stored; the user's wallet retains control of all spending signatures.

## Quotes and wallet transactions

```ts
const quote = await markets.quote({
  market: post.market,
  owner: authenticatedWallet,
  side: 'buy', // 'sell' reverses the same pair
  amountIn: '1000000', // 1 Test SKR with six decimals
  slippageBps: 100,
})

const trade = await markets.buildTrade({ quoteId: quote.id, owner: authenticatedWallet })
// Persist trade before returning transactionBase64 to the mobile wallet.
// The wallet reviews, signs and submits; the market service never sends transactions.
const receipt = await markets.reconcileTrade({ signature, trade: storedTrade })
```

All monetary amounts are unsigned u64 integer strings in the corresponding mint's smallest units. `decimalToUnits` and `formatUnits` avoid floating point. Exact-in orders only; partial fills are rejected. Slippage is explicit and bounded to 1–500 bps. Quotes expire after 20 seconds by default, with a configurable maximum of 60 seconds. `buildTrade` re-quotes and rechecks the route, preserves the original minimum output, and rejects unfavorable price movement or graduation.

Every transaction has an explicit payer, blockhash, last-valid blockheight, measured compute limit and bounded priority fee. The service simulates before returning it, then simulates again after setting the measured compute limit. Program IDs are restricted to the SDK programs and their expected dependencies. Insufficient funds, missing accounts and simulation failures return errors; they do not produce a fake successful transaction.

Quotes have a short API lifetime. **The onchain swap's actual expiry is the Solana blockhash lifetime**, and its minimum output remains enforced during that lifetime. The legacy Meteora instruction does not contain a wall-clock quote deadline. The UI must prevent signing after its displayed quote expiry and request another quote.

The API should persist quotes through the injectable `QuoteStore`, plus all built envelopes and their owner. The default store is bounded in-memory storage for local use. Build requests must be idempotent per wallet and quote ID; retries should return the existing intent instead of generating another spend. Restore pending intents after app restart and reconcile before allowing a replacement trade.

## Confirmation and indexing

`reconcile` fetches confirmed transaction metadata and compares its serialized message with the server's persisted `messageBase64`. The Seeker wallet may replace only the compute-unit price, capped at 100,000 micro-lamports; the payer, blockhash, accounts, compute limit and every other instruction byte must still match. A client-supplied signature for another successful transfer cannot settle a Clout intent. `reconcileTrade` additionally checks the precise input debit and that the actual output meets the user-approved minimum. Results are `pending`, `expired`, `failed`, or `confirmed`.

For confirmed results, `tokenDeltas` contains actual signed integer balance changes belonging to the transaction owner; `feeLamports` reports SOL network fees separately. A processed error remains pending until confirmed. A known transaction whose metadata has not arrived remains pending even after the blockheight passes, avoiding premature replacements. Deduplicate every confirmed event by signature in the database. Early-backer recognition requires finalized buys; transferred tokens and optimistic UI balances do not establish purchase history.

Portfolio values should request fresh sell quotes and show fee-inclusive executable output. No spot-price multiplication is a substitute for an executable sell quote. Transfers outside Clout require the backend's holdings reconciliation against token accounts; trade receipts alone do not represent total wallet ownership.

The mobile Collection screen reads these wallet holdings and executable sell estimates from `/v1/portfolio`, opens the sale review for a selected post, and reveals a shareable purchase receipt when a recorded buy exists. The receipt is not a separately minted NFT. Profile reads the same SKR/SOL balances, presents the creator's uploaded posts, separates market launch from upload, and builds creator fee claims and direct Test SKR tips. Every economic action requires wallet review and confirmation. A wallet-scoped pending record is stored after signing and before broadcast, blocks replacement signing, and survives an app restart; Profile provides a confirmation recovery action. Processing or failed videos cannot launch from the creator screen. Reward eligibility verifies SGT ownership while funded SKR campaigns remain unavailable.

## Graduation and creator fees

`buildTip({ owner, recipient, amountIn })` builds a checked SPL transfer of the configured Test SKR mint, creating the recipient's associated token account idempotently if necessary. The sender pays network fees and any account rent in SOL. The sender must approve through the wallet; there is no custodial payout key. Store the returned envelope under an idempotent tip request before signing, and reconcile its exact message before showing success.

`inspectMarket` validates DBC account ownership, account discriminator, base mint, canonical pool address, configured quote mint and migration option. States are:

1. `dbc`: trades route through DBC.
2. `migration-required`: threshold reached; pause trading and prepare migration.
3. `migration-pending`: DBC reports migration but the successor is not available yet.
4. `damm-v2`: canonical successor exists and its mints/program are validated; quotes and transactions use DAMM v2.

`buildMigration({ market, payer })` returns one simulated step. If a configured token vesting locker is missing it returns `phase: 'create-locker'`; confirm that step, then call again. Otherwise it returns `phase: 'migrate'`. The SDK-generated position NFT keys partially sign the transaction; only the payer's wallet signature remains. Always re-read market state afterward. Do not assume a keeper will migrate devnet or a custom configuration. [Official DBC migration guide](https://github.com/MeteoraAg/docs/blob/main/developer-guides/dbc/index.mdx).

`buildClaim({ market, creator })` verifies the creator recorded in the pool, builds a claim for accumulated DBC fees, and also claims the creator's DAMM v2 position fees after graduation. It returns one envelope per claim transaction, all paid to the creator. Residual DBC fees remain claimable after graduation. A returned empty array means no claim transaction was built; it is not a claim receipt.

## Validation and remaining release gates

### Optional reward treasury transport

`createRewardTransferAdapter({ marketConfig, secretKeyUint8Array, maxAmountIn })` is a separate server-only devnet transport for an explicitly enabled, funded campaign. It does not read environment variables or key files, and construction does not submit anything. The API injects a dedicated treasury key only after campaign enablement. No user wallet key is used.

`availableBalance()` verifies the configured SPL mint and treasury account. `validateBudget({ amountIn })` checks the full campaign allocation before activation; the API must separately reserve it atomically and enforce both wallet/campaign and SGT/campaign uniqueness. `prepare({ wallet, amountIn })` bounds each reward, simulates a checked Test SKR transfer, and returns fully signed bytes, signature and last-valid blockheight. **Commit these exact bytes and signature to the durable claim ledger before calling `submit(signedBase64)`.** A retry submits the same bytes and signature; an RPC timeout is not permission to prepare another payout.

The funding check also requires a conservative SOL reserve. It rounds the requested allocation up to a whole number of maximum-size claims and reserves rent for a new 165-byte SPL token account per claim, even if some recipients already have one. It obtains the current network fee with `getFeeForMessage` for one treasury signature, the adapter's full 1,400,000-CU ceiling and configured priority price. Required SOL is `claimCount × (accountRent + estimatedFee)`. Missing fee/rent estimates or insufficient SOL keep the campaign unavailable; every payout preparation repeats the check. This check creates no accounts and submits no transactions. [Solana fee calculation](https://solana.com/docs/core/fees), [message fee estimation](https://solana.com/docs/rpc/http/getfeeformessage).

`reconcile(signature, lastValidBlockHeight)` returns `pending`, `finalized`, `failed` or `expired`. Successful or failed transfers become terminal only at finality. Expiry requires a finalized blockheight beyond the lifetime and a second history-aware status lookup after that check. **An unknown expired signature is not proof of nonpayment:** RPC history may be missing or pruned after downtime. The claim remains reserved for manual reconciliation and must not receive a replacement payout. Only a finalized failed attempt may be retried on the same claim, within the bounded attempt count. [Solana signature history](https://solana.com/docs/rpc/http/getsignaturestatuses), [blockheight commitments](https://solana.com/docs/rpc/http/getblockheight), [transaction submission](https://solana.com/docs/rpc/http/sendtransaction).

### Mock SKR alpha faucet

`createMockSkrFaucetAdapter({ marketConfig, secretKeyUint8Array, maxAmountIn, maxSupplyIn })` is a separate devnet mint-authority adapter. It uses the shared durable reward transport contract, but prepares a checked SPL `mintTo` instruction into the recipient's associated token account instead of transferring treasury inventory. It verifies the full devnet genesis hash, standard SPL mint ownership, configured decimals, the exact injected mint authority, and absence of a freeze authority. The real SKR mainnet mint is rejected. Construction reads no secrets and sends nothing.

`maxAmountIn` bounds one grant; the required `maxSupplyIn` is an absolute integer supply ceiling including previously minted test tokens. `availableBalance()` reports remaining mint capacity. `validateBudget` checks that the remaining unpaid campaign allocation fits that capacity and conservatively funds each recipient account's rent plus the bounded network fee in SOL. `validateBudget({ amountIn: '0' })` verifies network and mint configuration without requiring funds for additional grants. Every preparation repeats the checks, simulates twice and returns signed bytes without broadcasting.

The API enforces one fixed 1,000-SKR grant per wallet per UTC day. A stable campaign ID, database clock, wallet/day uniqueness and campaign lock enforce daily entitlement across concurrent requests and restarts. The default global circuit breaker is 10,000 allocations per UTC day. A permanent ledger records the initial supply plus every reserved grant; midnight resets entitlement, never this supply ledger. The standard SPL token program does not itself enforce the application's supply ceiling: a read-time supply check cannot serialize concurrent callers or constrain another holder of the mint-authority secret. Keep this task authority dedicated and reserve every grant in the durable API ledger. The API checks SOL funding for the current grant and uses the ledger to bound lifetime supply; it does not require SOL for all 10,000 daily recipient accounts upfront. `FAUCET_MAX_SUPPLY_UNITS` must include the initial test supply and all remaining campaign grants.

Persist the exact signed bytes and signature before submission; retry only those bytes. The same finality and ambiguous-expiry rules as rewards apply: show a grant as received only after finalization, and retain an unknown expired signature for review without preparing a replacement mint. Mock SKR has no monetary value and all faucet explorer links target devnet.

### Isolated devnet bootstrap

```sh
# Default/prepare: verify devnet, create isolated task keys, report public addresses and balance.
npx tsx packages/markets/scripts/bootstrap-devnet.ts prepare
# Explicit public-faucet request; this creates no mint or market.
npx tsx packages/markets/scripts/bootstrap-devnet.ts airdrop
# Requires at least 0.5 devnet SOL in the isolated payer.
npx tsx packages/markets/scripts/bootstrap-devnet.ts provision
```

Keys and transaction journals live only under ignored `.tooling/devnet/` with `0600` file permissions. The script never reads an existing user wallet; it uses only these task keys. The full devnet genesis hash is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`. A shortened CAIP chain identifier is not a valid `getGenesisHash` result. The optional `CLOUT_BOOTSTRAP_DEVNET_RPC_URL` selects another HTTPS devnet endpoint, still checked against that full hash.

Provisioning creates a six-decimal devnet mint explicitly labeled Test SKR in the local manifest and transaction memo, funds isolated creator/backer/treasury test accounts, and builds the canonical 1% market configuration with a two-Test-SKR graduation threshold. Labels do not create a Metaplex metadata account. The unsigned configuration and exact signed transaction bytes are persisted before broadcast. The CLI reuses persisted signed bytes and stops rather than automatically replacing an expired or failed attempt.

The initial `prepare` stage was exercised against public devnet RPC with an unfunded scratch payer; the public faucet returned an internal error. Subsequent provisioning and rehearsal results are recorded separately with their transaction receipts. No mainnet or paid service is used by this script.

```sh
npm run typecheck --workspace @clout/markets
npm run test --workspace @clout/markets
```

Tests cover integer precision/u64 limits, slippage bounds, quote mutation/expiry, owner binding, migration route changes, measured SDK transaction construction, ephemeral co-signatures, devnet enforcement, message-bound confirmations, exact token settlement, and pending/failed/expired states. RPC fixtures are explicit mocks; they do not constitute a completed devnet trade. SDK versions are pinned to `@meteora-ag/dynamic-bonding-curve-sdk@1.5.13`, `@meteora-ag/cp-amm-sdk@1.5.1` and compatible `@solana/web3.js@1.98.4`, checked against published type declarations and source. [Meteora DBC source](https://github.com/MeteoraAg/dynamic-bonding-curve-sdk), [Meteora DAMM v2 source](https://github.com/MeteoraAg/damm-v2-sdk).

### Completed live devnet graduation rehearsal

On 2026-10-13 UTC, `rehearse-graduation.ts run` completed a separate `GRADTEST` market using the original two-Mock-SKR configuration. It does not modify any catalog market or registry. It uses only the isolated task payer, creator and backer; verifies the full devnet genesis; simulates through the production market adapter; and durably records exact signed bytes before each broadcast. The licensed public Big Buck Bunny metadata is reused for this explicitly labeled rehearsal.

The exact-in buy spent **2.020203 Mock SKR** and filled the curve's **2.000000 Mock SKR** graduation reserve. The SDK's partial-fill quote was used only to calculate the exact remaining capacity; the submitted trade still used the app's normal exact-in quote and minimum-output checks. The market moved from `dbc` to `migration-required`, then to the verified canonical `damm-v2` successor. Selling 79,999,767.164982 position tokens on that successor returned **0.565389 Mock SKR**. The creator then received **0.008081 Mock SKR** in residual DBC fees and **0.002284 Mock SKR** in DAMM position fees.

All six transaction signatures were independently rechecked with historical status lookup at `finalized` commitment:

| Step                    | Devnet receipt                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                  | [Finalized launch](https://explorer.solana.com/tx/mvUvzq3gzET2vkt4PhsNAovkKa7aukzjxZqwPZPetAZS5RBn7wANjmEJkdHAexif9EJ5Eghj6A6Z6sUWPQAk4TN?cluster=devnet)      |
| Fill graduation reserve | [Finalized buy](https://explorer.solana.com/tx/2vezUxtr27WFtgtC6deHxX9tzoKe2wNxpeFbYExFLQ6w4oK9V7KUyMZmq8SyMJfaYiKbRnbLgsEMR45gynRzJ8aQ?cluster=devnet)        |
| Migrate to DAMM v2      | [Finalized migration](https://explorer.solana.com/tx/3GTYnxVk6Jb3gWC29UsFSC73uLzeXXzJb5NAF1qM96irP5P5NL56ATFF6fNSChsQr8jYRXzDf7kVkhuPwU16ccaa?cluster=devnet)  |
| Sell on DAMM v2         | [Finalized sale](https://explorer.solana.com/tx/2vGVGPdXEJgWRcgSgUGSy71Sf7wY5kduSmJEdzcAnSFSjV9wgvE52kK4QLdJXgxgpr9qXugarRQcLK8zSTbrH1Yr?cluster=devnet)       |
| Claim residual DBC fees | [Finalized DBC claim](https://explorer.solana.com/tx/2rEcqHxedz23SLCGAyBhd1ppvyms7xSBbmPQJ8z8EMKiHSu3dmheisSqdzeiYK8BfsWGyeaVqueU3ZknTPtR17Uk?cluster=devnet)  |
| Claim DAMM creator fees | [Finalized DAMM claim](https://explorer.solana.com/tx/2hy8d8Ap3jjWgdwsBQjhAyS7d5hx1eZ8fbx9q8pEnyDTTBHqrgNWwXmtz5ts2ohSZ8y84vSHRGHvR1yRDUsFHLuu?cluster=devnet) |

Full balance deltas, before/after market snapshots, the canonical successor address, and finality evidence are in [the rehearsal report](../artifacts/devnet-graduation-rehearsal.json). The public RPC occasionally returned HTTP/WebSocket 429 responses; its retry path recovered without constructing replacement transactions.

```sh
npx tsx packages/markets/scripts/rehearse-graduation.ts prepare # Read-only public preflight
npx tsx packages/markets/scripts/rehearse-graduation.ts run     # Reuses the exact isolated journals
npx tsx packages/markets/scripts/rehearse-graduation.ts verify  # Read-only finality/account verification
```

This proves the SDK's live devnet graduation path. The remaining physical-device release gate is the corresponding real-wallet mobile/API flow, including cancellation, stale quotes, app restart and duplicate indexing. Mainnet transaction construction is intentionally unsupported in this build and requires a separate reviewed release and explicit user authorization.

Dependency audit currently reports upstream advisories in the required legacy SDK stack, including `bigint-buffer` via SPL Token and `toml` via Anchor. No nonbreaking upstream fix was available when implemented. The service does not parse user TOML and its token decoding uses fixed-size SPL layouts, but that does not clear those advisories. `bn.js` is pinned to the patched 5.2.5 release. Do not use `npm audit fix --force` to replace the SDK's required web3.js/Anchor versions; review compatible upstream upgrades before production.
