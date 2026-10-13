# Architecture

Four modules and no runtime dependencies.

| File | Role |
|---|---|
| `src/core/btc-refund.ts` | Pure logic: the connector accounts, `btcDepositVerdict`, `refundSteps`, `refundBoard`, `receiverOf`. No I/O, no clock (the current time is passed in). |
| `src/btc-refund.ts` | I/O. `publicBtcRefundClient(fetch, rpc, chain)` reads Blockchair (Zcash) or mempool.space (Bitcoin), the Omni bridge indexer and the connector's view methods over NEAR RPC. `checkBtcDeposit` collects the facts and asks the core for a verdict; `checkRefundBoard` builds the board. |
| `src/render-btc-refund.ts` | Plain-text report and board. |
| `src/cli.ts` | `zec-refund <txid> [--vout N] [--json]`, `zec-refund --board`. |

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
  H --> V2[refundable: stuck]
  H --> V3[requested: in timelock]
  H --> V4[ready / executed]
  V2 --> S1[1. bridge-cli btc-request-refund<br/>2 NEAR, refund address pinned]
  S1 --> S2[2. wait 2 or 14 days<br/>DAO may reject a false claim]
  V3 --> S2
  S2 --> S3[3. execute_refund, anyone, 1 NEAR]
  V4 --> S3
  S3 --> S4[4. near-sign-btc-transaction:<br/>MPC signs, relayer broadcasts ZEC<br/>to the refund address only]
```

## Trust boundaries

- The **indexer** is only a lookup. Its deposit message is used only after the connector derives the same deposit
  address from it.
- The **connector contract** decides everything that matters: whether the coin was credited, the timelocks, and
  where the refund goes.
- **Blockchair and mempool.space** supply the transaction, its senders and whether the output was spent. A refund is
  recognised only when the spend uses that one coin and pays only the refund address.
- The tool holds no key. Signing happens outside it, by the user (NEAR transactions) and by NEAR's MPC network (the
  Zcash refund transaction).

## Testing

`src/**/*.test.ts` replays payloads recorded on 2026-10-13 from the real endpoints (`src/fixtures/btc-refund/`) through
an injected `fetch`. Any request that was not recorded fails the test. `src/btc-refund.live.test.ts` runs the same
checks against the live endpoints, on demand.
