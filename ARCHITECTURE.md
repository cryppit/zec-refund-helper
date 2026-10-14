# Architecture

Ten modules and no runtime dependencies.

| File | Role |
|---|---|
| `src/core/btc-refund.ts` | Pure logic: the connector accounts, `btcDepositVerdict`, `refundSteps`, `refundBoard`, `receiverOf` (with `isNearAccountId`, the protocol's account-id rule); `REQUEST_WINDOW` (how many blocks each light client keeps: the request deadline); the Zcash refund fee (`zip317Fee`, `ZCASH_REFUND_FEE_ZAT`, `refundFeeFor`). No I/O, no clock (the current time is passed in). |
| `src/core/refund-calls.ts` | Pure: the exact NEAR calls that finish a refund, `{receiverId, methodName, args, gas, deposit}`: `refundCalls` (what a wallet can sign now: `execute_refund`, then `sign_btc_transaction`), `nearCliCommand` (the printed near-cli steps come from these same calls), `walletTransaction` (NEAR Connect's `signAndSendTransaction` shape), `pendingIdOf`, `upfrontYocto`; and `refundPath` (which `execute_refund` an address can take: `shielded`, `transparent` or `none`). |
| `src/core/zcash-address.ts` | Pure Zcash address parsing with no dependencies: Base58Check (own SHA-256), Bech32/Bech32m, ZIP-316 unified addresses (F4Jumble with own BLAKE2b, typecode items), and `classifyZcashAddress`: kind, receivers, and which refund the connector can build to it. |
| `src/core/rpc.ts` | NEAR JSON-RPC with retries and provider fallback (FastNEAR, free.rpc.fastnear.com, near.drpc.org, rpc.mainnet.near.org): a busy provider (429, 5xx, network error, a provider-side timeout or `UNAVAILABLE_SHARD`) is retried with backoff, then the next is tried; a chain answer, errors included, is returned as is. Clock, sleep, randomness and fetch are injected. |
| `src/btc-refund.ts` | I/O. `publicBtcRefundClient(fetch, rpc, chain)` (`rpc`: a caller from `liveNearRpc`, or one provider URL) reads Blockchair (Zcash: the transaction dashboard, and for the deposit the node's decoded transaction for the shielded pools that funded it) or mempool.space (Bitcoin), the Omni bridge indexer and the connector's view methods over NEAR RPC. `checkBtcDeposit` collects the facts and asks the core for a verdict; `checkRefundBoard` builds the board. |
| `src/render-btc-refund.ts` | Plain-text report and board. |
| `src/core/scan.ts` | Pure scan logic: the indexer's ObjectId cursors and time segments, `parseTransfersPage`, `stuckCause` (pending, below_minimum, bad_message, unknown), `scanRow` (refund status, refundable now, refund-address kind, funding), `summarize` (totals, ages, oldest, ready refunds, Zcash shielded counts). |
| `src/scan.ts` | I/O for the scan: `pacedFetch` (per-host spacing, retry with backoff, per-run cache), `walkIndexer` (the transfer list in parallel one-day segments, finished days cached on disk), `scanCandidates` (each uncredited deposit and each refund request through `btcDepositFacts`, plus `view_account` and CoinGecko prices). |
| `src/render-scan.ts` | Plain-text scan report. |
| `src/cli.ts` | `zec-refund <txid> [--vout N] [--json]`, `zec-refund --board`, `zec-refund --scan [--json] [--since] [--cache] [--progress] [--concurrency]`. |

## Flow

```mermaid
flowchart TD
  A[zec-refund txid] --> B{Zcash: Blockchair<br/>then Bitcoin: mempool.space}
  B -- not found --> E1[error: no transaction with this hash]
  B -- found --> C[For each output: Omni indexer<br/>get_deposit_message for its address]
  C --> D[Connector: get_user_deposit_address<br/>must equal the output address]
  D -- no match --> V0[not_a_deposit]
  D -- match --> F[Connector: list_utxos / list_unavailable_utxos<br/>get_refund_requests_paged, get_config,<br/>required_balance_for_request/execute_refund]
  F --> G[UTXO chain: was the output spent, and by what]
  G --> H[core: btcDepositVerdict]
  H --> V1[credited / crediting / refunded]
  H --> V5[absorbed: below the minimum,<br/>in unavailable_utxos, no refund path]
  H --> V2[refundable: stuck]
  H --> V6[too_old: the light client no longer<br/>has the block: no commands]
  H --> V3[requested: in timelock]
  H --> V4[ready / executed]
  V2 --> R{refund address}
  R -- in the deposit, or the single<br/>transparent sender --> S1[1. bridge-cli btc-request-refund<br/>2 NEAR, refund address pinned]
  R -- shielded-funded, none named --> S1b[1. request with --refund-address<br/>your own unified address: a placeholder only]
  R -- several senders, or an address<br/>the connector cannot pay --> X[explain, no commands]
  S1 --> S2[2. wait 2 or 14 days<br/>DAO may reject a false claim]
  S1b --> S2
  V3 --> S2
  S2 --> P{refundPath of the address}
  V4 --> P
  P -- Orchard receiver --> S3a[3. bridge-cli btc-execute-refund --chain zcash<br/>builds the Orchard bundle: shielded]
  P -- t-address --> S3b[3. near-cli execute_refund<br/>no bundle: transparent]
  S3a --> S4[4. sign_btc_transaction with near-cli:<br/>MPC signs, relayer broadcasts ZEC<br/>to the refund address only]
  S3b --> S4
```

## Trust boundaries

- The **indexer** is only a lookup. Its deposit message is used only after the connector derives the same deposit
  address from it.
- The **connector contract** decides everything that matters: whether the coin was credited, the timelocks, and
  where the refund goes.
- **Blockchair and mempool.space** supply the transaction, its senders, the shielded pools that funded it and whether
  the output was spent. A refund is
  recognised only when the spend uses that one coin and pays only the refund address.
- The tool holds no key. Signing happens outside it, by the user (NEAR transactions) and by NEAR's MPC network (the
  Zcash refund transaction).

## Zcash refund rules (from the deployed source)

Read from Near-One/btc-bridge `btc-bridge-v0.9.7-rc3` (`d2140ec`), whose release wasm has the deployed code hash.

- `request_refund` stores `gas_fee`: on Zcash `get_refund_gas_fee()` = max(ZIP-317 fee of a 1-input/1-P2PKH-output
  transparent refund, ZIP-317 fee of a 1-input/1-action shielded refund) = 10,000 zatoshis. Only the DAO or operator may
  pass a custom fee. The request is refused unless `gas_fee < amount`.
- `execute_refund(utxo_storage_key, chain_specific_data)`: without `chain_specific_data` it builds one transparent
  output, which needs a scriptPubKey (t-address, TEX, or a unified address's P2PKH/P2SH receiver). With an Orchard
  bundle it builds no transparent output; `validate_orchard_bundle` checks the bundle pays the unified address's
  Orchard receiver, and the contract checks the amount equals `amount - gas_fee`. Since NU6.3 the bundle goes in the
  v6 transaction's Ironwood slot.
- The address parser has no Sapling or Sprout conversion, so those addresses can never be paid; `request_refund` does
  not check the address.
- The deposits are checked with `>=` and kept: 2 NEAR for `request_refund`, 1 NEAR for `execute_refund` ("NOT
  refunded"), anything attached beyond them too. `request_refund` checks the light-client proof in a callback, after
  taking the 2 NEAR; on Zcash `execute_refund` also checks the lock and the request in a callback (it needs the light
  client's height first), after taking the 1 NEAR.
- An account can hold one executed refund awaiting its signature (`pending_tx_limits`, default 1): it must get that one
  signed before it executes another ("Too many pending sign transactions"). `sign_btc_transaction` is open to anyone
  for a refund and passes its 1 yoctoNEAR to the MPC signer.

## Testing

`src/**/*.test.ts` replays payloads recorded on 2026-10-13 from the real endpoints (`src/fixtures/btc-refund/`) through
an injected `fetch`. Any request that was not recorded fails the test. The two Blockchair raw-transaction payloads are
trimmed (hex, proofs, signatures and ciphertexts removed). Cases with no real example on mainnet (a stuck
shielded-funded deposit, a Sapling refund address) are built from real data with one field changed and say
"synthetic" in the test name. `src/core/zcash-address.test.ts` runs the ZIP-316 F4Jumble and unified-address vectors
from zcash/zcash-test-vectors (`src/fixtures/zip316/vectors.json`, a subset). `src/btc-refund.live.test.ts` runs the same
checks against the live endpoints, on demand. `src/scan.test.ts` walks three trimmed pages of the indexer's real
transfer list (the test sets the cursors so two segments share a page) and checks the stuck 0.1 BTC deposit
`9deffb31…@0` end to end; `src/core/scan.test.ts` covers the causes, the refund states and the totals.
