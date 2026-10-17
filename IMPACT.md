# Impact: BTC and ZEC stuck in the NEAR Omni bridge

Snapshot: **2026-10-13 16:52 UTC**, made with `zec-refund --scan` (this repository). Read-only: public GET requests
and NEAR view calls only; nothing was signed or sent. Every number below can be rebuilt with the command at the end,
and every deposit is listed with its transaction hash so anyone can check it on a block explorer.

> **Since this snapshot:** both connectors now lock a refund requested for a deposit that named no refund address for
> 100 years (`unsafe_refund_timelock_sec` 3,153,600,000 s, 14 days before; `btc-connector.bridge.near` since
> 2026-10-16, `zcash-connector.bridge.near` by 2026-10-17), and the contract applies it to requests already made. The
> 14-day locks and "refundable now" counts below are as of 2026-10-13. The tool now gives no steps on that lock: see
> [README, The 100-year lock](README.md#the-100-year-lock-since-mid-october-2026).

## Headline

| | Bitcoin (`btc-connector.bridge.near`, v0.9.6) | Zcash (`zcash-connector.bridge.near`, v0.9.7-rc.3) |
|---|---|---|
| Stuck deposits | **570**, **6.36170296 BTC** (**$530,528**) | **51**, **0.02262864 ZEC** (**$27.28**) |
| Never credited, sitting at a deposit address | 28, 6.35425388 BTC: **27 user deposits, 6.35414319 BTC**, and 1 bridge payout (an end-to-end test, 0.00011069 BTC) | 0 |
| Absorbed below the minimum (no refund path at all) | 542, 0.00744908 BTC | 51, 0.02262864 ZEC |
| Recoverable by their senders through the bridge's own refund (verified 2026-10-14) | **24, 6.30408319 BTC ($525,723)** | 0 |
| Refund requests past their lock, never executed | 1: `9deffb31…@0`, 0.09997900 BTC, ready since 2026-09-02 | 0 |
| Pending (inside the 6-hour crediting window, not counted) | 5, 0.05417639 BTC | 0 |

Prices: CoinGecko `simple/price` (keyless), BTC $83,394 (2026-10-13 16:53 UTC), ZEC $1,205.59 (2026-10-13 16:53 UTC).

What it means:

- **Bitcoin:** 6.35 BTC (about $530,000) sits at 27 user deposits to bridge deposit addresses, confirmed on Bitcoin,
  never credited on NEAR and never refunded. 24 of them (6.30 BTC) can be recovered by their senders through the
  connector's own permissionless refund; 3 cannot (one names a public example address as its refund address, two are
  no larger than the refund fee). Two deposits alone are 1.998 BTC (12 days old) and 1.8 BTC (138 days old). One
  refund (0.1 BTC) has been ready for 41 days and nobody has executed it (we executed it on 2026-10-15 with this
  tool's steps: Bitcoin transaction 51623f37…, block 971,560). The total is growing: two of the five
  deposits pending at the snapshot were still uncredited 9 to 13 hours later (another 0.05093722 BTC).
- **Zcash:** no ZEC deposit sits uncredited at a deposit address. Every uncredited ZEC deposit is one the
  connector absorbed below its 0.001 ZEC minimum. That money is small (0.0226 ZEC), but nobody can recover it today,
  and 32 of the 51 deposits came out of a shielded pool.
- **Absorbed deposits are a finding in themselves.** The deployed contracts record a deposit below
  `min_deposit_amount` as an "unavailable UTXO", mark it verified and mint nothing. `request_refund` refuses verified
  deposits, and no method spends or releases an unavailable UTXO, so these coins are locked until the contract changes
  (both deployed versions, see "Why absorbed deposits cannot be refunded").

## Independent verification (2026-10-14)

Every one of the 28 was re-checked by hand from primary sources, separately from the scan
(`research_notes/Stuck BTC verification` in Cryppit's notes; recheck at 2026-10-14 00:58 UTC):

- **On Bitcoin:** each is a confirmed output (237 to 46,709 confirmations); mempool.space and blockstream.info agree on
  block, address and amount, and both show it unspent.
- **The address is the bridge's:** `btc-connector.bridge.near` itself derives each deposit address from the deposit
  message (`get_user_deposit_address`, 28 of 28).
- **Not credited:** none is in the connector's `list_utxos`, `utxos_in_progress` or `list_unavailable_utxos`, and no
  NEAR account received it another way.
- **The deployed code is the published release:** the connectors' code hashes equal the `btc-bridge-v0.9.6` and
  `btc-bridge-v0.9.7-rc3` release builds.

What the verification changed (the tool is fixed accordingly):

- `4b58625f…@0` is not a user's deposit: it is the bridge's own payout of a NEAR→BTC withdrawal, an end-to-end test,
  paid to a deposit address. The scan now counts such payouts apart.
- `8fc88d4e…@0` (0.05 BTC) names `bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh` as its refund address: a public example
  address from documentation, with 1,142 transactions from unrelated payers. The bridge can only refund there, so its
  sender cannot recover it.
- `81ed1be3…@19`, `81ed1be3…@17` and `06bfb7fd…@2` came in an exchange's batch payout (22 outputs): their single sender
  is the exchange's hot wallet, not the user's. The tool no longer suggests it; the user names their own address.
- Bitcoin refunds must be requested while the bridge's light client (`btc-client.bridge.near`, the last 52,704 blocks)
  still has the deposit's block: `993d7056…@0` and `10906dfa…@1` must be requested by about 2026-11-24.
- The "Refund address in deposit" column showed the refund request's address for `9deffb31…@0` and `f25e17c3…@0`; their
  deposits name none (which is why both have the 14-day lock).

## Method

Deposit addresses are derived per deposit message (`get_user_deposit_address`), so neither chain alone can list the
bridge's deposits. The scan combines the three public sources that can:

1. **The bridge indexer's transfer list** (`mainnet.api.bridge.nearone.org/api/v4/transfers`). This is the only
   public list of deposits to the bridge's per-user addresses. It records every deposit the indexer sees to an
   address it handed out, with a status: `Initialised` once seen on Bitcoin or Zcash; `Finalised` once credited on
   NEAR (or `FinalisedOnNear` for a deposit to `omni.bridge.near` whose NEAR leg is done; the fast-finalised pair when
   a relayer paid ahead), and `Settled`, the terminal state. The list is cursor-paged by
   a MongoDB ObjectId whose first 4 bytes are the insertion time, so the scan starts one cursor per UTC day and reads
   the 111 days in parallel (8 workers). Pages that neighbouring days share are counted once. It read
   **27,044 pages, 1,352,177 transfers**, of which **255,494 Bitcoin and 35,905 Zcash deposits**. The first record in
   the list is from 2026-06-25.
2. **Each connector's refund requests** (`get_refund_requests_paged`, all time): 2 on Bitcoin, 0 on Zcash.
3. **Each connector's unavailable UTXOs** (`get_unavailable_utxos_paged`, all time): 542 on Bitcoin, 51 on Zcash.

The candidates are every deposit from (1) not shown as credited (524 Bitcoin, 47 Zcash), plus everything in (2) and (3).
The scan checks each one with the same code as `zec-refund <txid>`:

- a fresh indexer look-up (2 had been credited since the walk);
- the transaction on its chain (mempool.space for Bitcoin, Blockchair for Zcash, including the node's decoded
  transaction for the shielded pool that funded it);
- the indexer's deposit message, accepted only if the contract derives the same address from it;
- the bridge's own records: `list_utxos` (credited and held), `list_unavailable_utxos` (absorbed), and whether the
  output was spent and by what (a spend that is not the refund means the bridge took it in);
- the refund request, if any;
- `view_account` on the NEAR account the message names.

A deposit counts as stuck when it is confirmed, more than 6 hours old, not in the bridge's UTXO set, not spent, and
not refunded; or when it is absorbed.

Causes:

- `below_minimum`: under the connector's `min_deposit_amount` (2,500 sat; 100,000 zat). Absorbed if a relayer
  already verified it.
- `bad_message`: no deposit message derives the address, or it names a NEAR account that does not exist.
- `pending`: confirmed less than 6 hours ago. Not counted as stuck.
- `unknown`: confirmed, above the minimum, with a valid message and an existing account, and still not credited.

"Refundable now":

- `request`: the deposit exceeds the refund fee and its refund address (the deposit's own, or one the requester names)
  can be paid;
- `execute`: a request is past its lock;
- otherwise no.

Requests were paced per host (indexer 60 ms, mempool.space 300 ms, Blockchair 2.1 s, FastNEAR 250 ms), retried with
backoff on 429 and 5xx (51 retries, all recovered), and cached within the run. **0 candidates were left unchecked.**

## Coverage and limits

The totals are a **lower bound**. The scan sees:

- every deposit the indexer lists (inserted from 2026-06-25 on; it also lists older deposits it picked up then, such as
  ones confirmed in 2025);
- every refund request on either connector;
- every absorbed (unavailable) UTXO on either connector, all time.

It cannot see:

- a deposit to an address the indexer never handed out (for example, an address derived directly from the contract
  by an integrator) that nobody has requested a refund for and no relayer has verified;
- a deposit before 2026-06-25 that the indexer does not list and that has no refund request. The indexer's look-up
  returns 404 for, for example, the first `verify_deposit` deposits of January 2025.

Other limits:

- "Stuck" uses this tool's 6-hour window. Bitcoin needs 2+ confirmations (about 20 minutes) and Zcash 5 to 15 (about
  15 to 40 minutes) before a relayer can verify, so 6 hours is generous.
- `unknown` is honest: the contract and the chain show the deposit uncredited and unspent, but not why the relayer
  never verified it. The connector's legacy entry points (`verify_deposit`, `safe_verify_deposit`, …) are paused on
  `btc-connector` (`get_metadata` → `pa_all_paused`), but current deposits are credited through
  `verify_deposit_v2`, which is not paused. So the pause alone does not explain them.
- One Bitcoin row, `4b58625f…@0` (0.00011069 BTC), is a bridge payout that landed on a deposit address: a NEAR→BTC
  withdrawal from `intents.near` was paid to an address the bridge had handed out for deposits. The indexer lists two
  records for that transaction, the withdrawal (`Settled`) and the new deposit (`Initialised`). The deposit was never
  credited, and the contract and the chain show its coin unspent, so it is counted. (The first scan read the
  withdrawal's status for it; the look-up now reads the deposit's own record.)
- The refund-address column reflects the deposit message where the indexer knows it. "none" means the message names
  no refund address, or the indexer has no message. The requester then names an address and the 14-day lock applies.
- USD values use one spot price per coin at the snapshot time.

## Stuck deposits that are not absorbed (Bitcoin; Zcash has none)

The per-deposit list is not published here: a ready-made list of people with stuck funds is what "recovery" scammers look for. `pnpm zec-refund --scan` reproduces it from public data, and we share it with the bridge team and the judges on request.

## Ready refunds nobody executed

- `9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39@0`: 0.09997900 BTC to
  `bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t`, requested 2026-08-19, lock (14 days, the deposit named no refund
  address) ended 2026-09-02 17:40 UTC, unexecuted for 41 days. Anyone can call `execute_refund`; the coin can only go
  to that address.
- `f25e17c393fd14b19d7d0d69516eb048656a5059c5ffc304b9ff3c100d0ebf07@0`: 0.09544976 BTC, requested, lock ends
  2026-10-27.

## Why absorbed deposits cannot be refunded

The source is Near-One/btc-bridge, tags `btc-bridge-v0.9.7-rc3` (the deployed Zcash code hash) and `btc-bridge-v0.9.6`
(the Bitcoin connector's reported version), `contracts/satoshi-bridge/src`:

- `btc_light_client/deposit.rs`: `internal_verify_deposit` and `internal_safe_verify_deposit` send a deposit with
  `deposit_amount < config.min_deposit_amount` to `unavailable_utxo_callback`. That callback inserts the key into
  `verified_deposit_utxo`, stores the coin in `unavailable_utxos` (`internal_set_unavailable_utxo`) and mints nothing.
- `refund.rs`: `request_refund` requires the UTXO not to be in `verified_deposit_utxo` ("UTXO already verified via
  deposit").
- Nothing else in the contract reads `unavailable_utxos` except the two views and a guard in
  `complete_failed_deposit_mint` that refuses them. No method removes or spends an unavailable UTXO.

A below-minimum deposit that no relayer has verified yet is still refundable. Only a verified one is absorbed.

## Zcash specifics

- All 51 uncredited ZEC deposits are absorbed below the 0.001 ZEC minimum: 0.02262864 ZEC, the largest 0.00094182 ZEC.
- **32 of 51 were shielded-funded**, with no transparent input: 30 from the Ironwood pool and 2 from Orchard. 19 were
  transparent.
- **14 of 51 name a shielded-only refund address** (a unified address with an Orchard receiver and no transparent
  one). 6 name a transparent address; 31 name none, or the indexer has no message for them.
- Ages: 38 confirmed in September 2026, 6 in October, 1 in August, 5 in February 2026, and 1 in August 2025, the oldest:
  `cf39e77e…@0`, 0.0003 ZEC, 410 days.
- The indexer lists 35,905 ZEC deposits since 2026-06-25 (291,343 ZEC). 35,858 show as credited when walked; the 47 others
  are all absorbed.

### Absorbed Zcash deposits (51)

The per-deposit list is not published here: a ready-made list of people with stuck funds is what "recovery" scammers look for. `pnpm zec-refund --scan` reproduces it from public data, and we share it with the bridge team and the judges on request.

## Age distribution of stuck deposits

| Age | Bitcoin | Zcash |
|---|---|---|
| < 1 day | 1 | 0 |
| 1 to 7 days | 11 | 5 |
| 7 to 30 days | 41 | 16 |
| 30 to 90 days | 85 | 24 |
| > 90 days | 432 | 6 |

Oldest overall:

- Bitcoin: `9b2c643b…@0`, 3,000 sat, absorbed, 544 days.
- Bitcoin, not absorbed: `993d7056…@0`, 15,000 sat, 326 days.
- Zcash: `cf39e77e…@0`, 410 days.

## Absorbed Bitcoin deposits (542, 0.00744908 BTC)

The per-deposit list is not published here: a ready-made list of people with stuck funds is what "recovery" scammers look for. `pnpm zec-refund --scan` reproduces it from public data, and we share it with the bridge team and the judges on request.

## Reproduce

```bash
pnpm install
pnpm zec-refund --scan --cache .scan --progress scan.log            # text report
pnpm zec-refund --scan --json --cache .scan > report.json           # the same as JSON
```

A full run reads about 27,000 indexer pages (about 30 minutes with 8 workers) and then checks the candidates (about 15
minutes). `--cache` keeps each finished day, so a second run only reads new days. Numbers will move as deposits are
credited, refunded or added; the hashes above pin this snapshot.
