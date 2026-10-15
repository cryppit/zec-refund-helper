# zec-refund-helper

Find a Zcash deposit that is stuck in the NEAR Omni bridge from its transaction hash, see where the ZEC is and who can
move it, and get the bridge's own refund steps. Bitcoin deposits through the same bridge work the same way.

Keyless and read-only: it never asks for, sees or holds a key, and it never signs or sends anything.

Live demo: https://cryppit.github.io/zec-refund-helper/ (this repository's own web page, `web/`: the same checks, run in
your browser against public sources only).

Demo video (1:28): https://cryppit.github.io/zec-refund-helper/demo.mp4 (also attached to the
[v0.1.0 release](https://github.com/cryppit/zec-refund-helper/releases/tag/v0.1.0)).

Used for real: on 15 October 2026 this tool's own steps returned a 0.0999 BTC deposit, stuck since August, to the
address that sent it. NEAR: `execute_refund`
[4PGHNZKm…](https://explorer.near.org/transactions/4PGHNZKmQNFbhGCPXz2UrFZ4ShKwPWyL2MEkzcctqk8W) and
`sign_btc_transaction` [GHLP7iAs…](https://explorer.near.org/transactions/GHLP7iAs6ePDp12H8tLXJp3E7qZE4x8ft4j88xd5oBVB);
Bitcoin: [51623f37…](https://mempool.space/tx/51623f3708759b1e92554854458908936c6d1df4444a89a654ac04fa2d667032), block
971,560. It cost 1 NEAR, which the contract keeps, plus less than 0.0001 NEAR in fees.

## The problem

To swap ZEC through NEAR Intents, a wallet or app sends ZEC to a deposit address of the Omni bridge's Zcash connector
(`zcash-connector.bridge.near`). The bridge then credits the deposit on NEAR. If that never happens (the deposit was below
the minimum, the message was wrong, a relayer never finished it), the ZEC sits at a bridge deposit address and the user
sees nothing: no balance on NEAR, no refund, no error.

The connector contract has a refund path for exactly this case, but it is hard to use. You need to know the deposit
message behind the address, the UTXO key, which timelock applies, the NEAR deposits each call needs, the order of
calls, and who the coin can go back to. This tool reads all of that from public data and prints the steps.

## How it works

Given a 64-hex transaction hash, it:

1. Looks the hash up on Zcash (Blockchair) and then on Bitcoin (mempool.space). Both are keyless public APIs. For a
   Zcash deposit it also reads the node's decoded transaction to see whether it was funded from a shielded pool
   (Sprout, Sapling, Orchard or Ironwood). Blockchair's dashboard alone shows an Orchard- or Ironwood-funded
   transaction as 0 inputs, 0 fee and a 0 shielded delta.
2. For each output, asks the Omni bridge indexer for the deposit message behind that address, then checks the
   indexer's answer against the connector contract itself (`get_user_deposit_address`), so it does not rely on the indexer alone.
3. Reads from the connector over NEAR RPC (FastNEAR first; when it is busy or refuses, free.rpc.fastnear.com,
   near.drpc.org and rpc.mainnet.near.org in turn): whether the bridge holds the coin (`list_utxos`: credited) or
   absorbed it (`list_unavailable_utxos`: verified below the minimum, nothing minted), any refund request (`get_refund_requests_paged`, with the fee stored on it), and the live
   config: timelocks, minimum deposit and the NEAR deposits that `request_refund` and `execute_refund` need. The
   Zcash refund fee is the contract's own ZIP-317 minimum (10,000 zatoshis for a one-input refund, transparent or
   shielded), not the 0.01 ZEC `max_btc_gas_fee` cap.
4. Checks on the UTXO chain whether the deposit output was spent and, if so, whether that spend was the refund
   (it spends only that coin and pays only the refund address).
5. Gives one verdict: `unconfirmed`, `not_a_deposit`, `credited`, `absorbed` (below the minimum: verified, nothing
   minted, and no refund path, see below), `crediting` (first 6 hours), `refundable` (stuck), `requested` (in its
   timelock), `ready` (lock passed, nobody executed it), `executed` (waiting for the MPC signature) or `refunded`.
6. Classifies the refund address (ZIP-316 parsing, no dependencies: Bech32m, F4Jumble with BLAKE2b, the receiver
   typecodes; tested against the official zcash-test-vectors): a transparent t-address, a TEX address, a unified
   address and its receivers (Orchard, Sapling, transparent), or a Sapling or Sprout z-address.
7. For a stuck deposit, prints the commands left to run, with live fees and timelocks: first the one line that lets
   near-cli sign as your NEAR account (`near account import-account using-web-wallet network-config mainnet`), then
   **request** (`bridge-cli … btc-request-refund`, which builds the deposit's inclusion proof), **wait for the lock**,
   **execute**, and **sign** (`sign_btc_transaction` with near-cli, or `bridge-cli … near-sign-btc-transaction`:
   NEAR's MPC network signs the Zcash refund transaction and the bridge's relayer broadcasts it). Each step says how
   much NEAR the signing account needs, the deposit plus the gas NEAR holds upfront at 0.001 NEAR per Tgas (a little
   over 2.3 NEAR to request, 1.25 to execute, 0.25 to sign), and that the 2 NEAR and 1 NEAR deposits are not returned:
   attach exactly what the command attaches, since the contract keeps anything extra too. On Zcash the execute
   depends on the refund address:
   - to a unified address with an Orchard receiver, `bridge-cli mainnet btc-execute-refund --chain zcash` builds an
     **Orchard bundle** and the refund is shielded (since NU6.3 it lands in the Ironwood pool);
   - to a t-address, near-cli's `execute_refund` with no bundle pays one ordinary output;
   - to an address with neither an Orchard nor a transparent receiver (a Sapling `zs1…` address, for example) the
     connector cannot pay at all, and the tool says so instead of printing commands.

### Why a shielded refund needs the Orchard bundle

The connector refunds by building a Zcash transaction that spends the deposit, and NEAR's MPC network signs its
transparent input. A transparent output is just a script the contract can write. An Orchard output cannot be written
by a contract: it needs a note encrypted to the recipient and a zero-knowledge proof, and those are made off-chain.
So for a shielded-only address (no transparent receiver) `bridge-cli` builds the Orchard bundle, proof included, paying
exactly the deposit minus the stored fee, and passes it to `execute_refund`. The contract checks that the bundle pays
the request's address's Orchard receiver and that amount, and only then puts the transaction up for signing. Without
the bundle, `execute_refund` tries a transparent output, and for an address with no transparent receiver it fails.
On 2026-10-13 we sampled 11 real shielded-funded ZEC deposits to the connector: all 11 name a unified refund address
with no transparent receiver (7 Orchard-only, 4 Orchard + Sapling). For them a shielded refund is the only refund,
so this is the normal case, not an edge case.

### Deposits funded from a shielded pool

On 2026-10-13, 40 of the 104 newest coins the Zcash connector held came from transactions with no transparent input
at all: the ZEC came out of the Ironwood pool straight to the bridge deposit address. Such a deposit has no
transparent sender. The tool says so and:

- if the deposit message names a refund address (the real ones we found all do, a unified address), uses that one;
- if it does not, it explains that the depositor names their own address in the request, ideally their own unified
  address with an Orchard receiver so the refund stays shielded. It prints the request with a placeholder
  (`--refund-address <your own unified address …>`), never an address of its own choosing. Nobody can prove from the
  chain that a named address belongs to the depositor, which is why this path has the 14-day lock and the bridge's DAO
  or operator can reject a false claim during it.

`zec-refund --board` lists every refund request on both connectors, ready ones first with how long nobody has executed
them, then locked ones, then executed ones.

### How much is stuck: `--scan`

`zec-refund --scan` measures the stuck money across both connectors (results and method: [IMPACT.md](IMPACT.md)):

1. **Enumerate.** Deposit addresses are derived per deposit message, so the chain alone cannot list them. The only
   public list is the bridge indexer's transfer list (`/api/v4/transfers`), which records every deposit it sees to
   an address it handed out, with its status (`Initialised` when seen on Bitcoin or Zcash, `Finalised` and then
   `Settled` once credited on NEAR). The list is paged by a MongoDB ObjectId cursor that starts with the insertion time, so the scan reads it
   as one-day segments in parallel. The list starts on 2026-06-25.
2. **Add** every refund request on both connectors (`get_refund_requests_paged`), which reach back before that date.
3. **Check** each deposit not yet credited, and each requested one, with the same code as `zec-refund <txid>`: a fresh
   indexer look-up, the transaction on the chain, the contract's own derived address, the bridge's UTXO set, the
   spend, the refund request, and whether the NEAR account in the deposit message exists.
4. **Classify** each uncredited one: `pending` (inside the 6-hour crediting window, not counted as stuck),
   `below_minimum`, `bad_message` (no message derives the address, or it names a NEAR account that does not exist)
   or `unknown`; and whether it is refundable now (request, execute or sign) and its refund status.
5. **Total** per chain, in coins and in USD (CoinGecko, keyless).

Requests are paced per host, retried with backoff on 429 and 5xx, and cached within the run. A full scan reads
about 30,000 indexer pages (about 40 minutes); `--cache DIR` keeps finished days so the next run only reads the
new ones, and `--progress FILE` streams progress.

### Deposits below the minimum are absorbed

In the deployed connector (`deposit.rs`, v0.9.7-rc3; the same in 0.9.6), when a relayer verifies a deposit below
`min_deposit_amount`, the contract records it in `unavailable_utxos` and in its set of verified deposits, and mints
nothing. `request_refund` refuses any verified deposit, and no method spends or removes an unavailable UTXO. So such a
deposit can neither be credited nor refunded by anyone; only a contract change can release it. Earlier versions of
this tool counted it as credited; it is now its own verdict, `absorbed`. (A below-minimum deposit that no relayer has
verified yet is still refundable.)

### Request it within 90 days

`request_refund` proves the deposit against the bridge's light client for its chain on NEAR, which keeps only its
newest blocks. `zcash-client.bridge.near` keeps 103,680 Zcash blocks: 90 days at 75 seconds a block (checked
2026-10-14: `get_mainchain_size` 103,680, and `get_block_hash_by_height` has block 3,413,659 but not 3,413,658).
Bitcoin's keeps 52,704 blocks, about a year. The tool prints the date to request by, and after it the verdict
`too_old` with no commands: the request would fail, and the contract takes the 2 NEAR before it checks the proof.

## Custody and trust model

- **Keyless.** It only reads public APIs and view methods. There is no key, account, login or API key anywhere in the code.
- **Non-custodial.** The tool never touches funds. The ZEC stays at the bridge's deposit address until the
  connector contract sends it back.
- **Refund only to the original sender.** The tool only ever suggests the refund address written into the deposit
  itself, or, if the deposit names none, the single transparent address that funded it. If several addresses
  funded it, it suggests nothing. If it was funded from a shielded pool with no refund address, it explains how the
  depositor names their own address and prints a placeholder, never an address. The contract enforces the deposit's own `refund_address` when one is set. When none
  is set, the requester names the address, the longer 14-day lock applies, and the bridge's DAO or operator can reject a
  false claim during that lock. Once requested, the refund can only go to the address in the request.
- **The user signs.** Every step is a NEAR transaction the user signs with their own NEAR account, through
  `bridge-cli` or `near` CLI. Anyone may pay for these calls; that changes nothing about where the coin goes.

## What others can see

The tool runs no server and stores nothing: the web page and the CLI ask public services directly. Those services can
still see who is asking, and the refund itself happens in public. Every report ends with the same list for its own
deposit, under "What others can see": whether the sender is hidden or public, that the amount and the bridge's deposit
address are public (the bridge only takes deposits at transparent addresses, so the way in is always visible), the
NEAR account the deposit is for, whether a refund would stay shielded, and that whoever signs the steps is public.

- **Each lookup** goes to mempool.space (Bitcoin), Blockchair (Zcash), the Omni bridge indexer
  (`mainnet.api.bridge.nearone.org`) and a NEAR RPC provider (FastNEAR, with `near.drpc.org` and
  `rpc.mainnet.near.org` as fallbacks). Each one sees your IP address next to the hash or account you ask about.
  `--scan` also asks CoinGecko for prices. GitHub serves the page but never sees the hash: browsers keep the part of a
  `#q=` link after the `#` to themselves.
- **To hide your IP, look up over Tor, or through a VPN you trust.** On the web, open the page in Tor Browser (at
  the Standard or Safer security level; Safest turns off the JavaScript the page needs). For the CLI, start Tor with
  an HTTP tunnel port and let Node send its requests through it (Node 22.21 or 24 and later):

  ```bash
  tor --HTTPTunnelPort 9080 &
  NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:9080 pnpm zec-refund <hash>
  ```

  Expect retries. The bridge indexer (HTTP 403) and mempool.space (no answer) refuse many Tor exit relays: in our tests
  on 2026-10-15 the page worked on 1 of 4 Tor routes, and the CLI on the one route we tried, where Tor's own check
  confirmed the requests left through Tor and the three example deposits and `--board` gave the same answers as
  without it, in 12 to 15 seconds each. When a service refuses, the tool names it and says it could not check, never
  that the deposit does not exist. Ask Tor for a new circuit (in Tor Browser, "New Tor circuit for this site") and try
  again.
- **The refund steps are public.** They are NEAR transactions, and the account that signs them is linked to the
  deposit for good. Anyone may sign them, so if that matters, sign from an account that is not tied to your name or
  main wallet, and fund it from somewhere that is not linked to you either: the funding transfer is public too.
- **So is a transparent refund.** A refund to a Bitcoin address or a Zcash `t1…` address is an ordinary public
  transfer. A unified address with an Orchard receiver gets a shielded refund, so where the ZEC goes next stays off
  the transparent chain; the deposit and the refunded amount stay visible.

## Quickstart

Node 22.15 or newer, pnpm 11.

```bash
git clone https://github.com/cryppit/zec-refund-helper && cd zec-refund-helper
pnpm install
pnpm zec-refund <your Zcash transaction hash>            # the verdict and the steps left
pnpm zec-refund <hash> --vout 1                          # pick the output if the transaction has several
pnpm zec-refund <hash> --json                            # machine-readable report
pnpm zec-refund --board                                  # every open refund request, Zcash and Bitcoin
pnpm zec-refund --scan --cache .scan --progress scan.log # every stuck deposit and the totals (long; see IMPACT.md)
pnpm build:web                                           # the web page into web-dist/ (any static server can host it)

pnpm build && node dist/cli.js <hash>                    # or as a binary: `zec-refund` (bin in package.json)
```

For example, a credited Zcash deposit from 2026-10-13:

```text
$ pnpm zec-refund 6de202d64d2b7c04154ed73f892c7dd7f288d440bde80d39059d2341fd9abadc
Zcash deposit     6de202d64d2b7c04154ed73f892c7dd7f288d440bde80d39059d2341fd9abadc (output 0)
                  0.41000000 ZEC from t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1 to t1c4LrfuWHBmL86JZcohcdt5gWZTJfTYtte, confirmed 2026-10-13 10:23 UTC
For NEAR account  957d6bdac944b4d9877892977a76a22f05af2ff01d414b7379553ac6d6cf0c3d

CREDITED  the bridge took this deposit in; ...
```

Tests:

```bash
pnpm test        # unit tests, ZIP-316 test vectors and recorded-payload tests (no network)
pnpm typecheck
pnpm test:live   # on demand: the same checks against the real public endpoints
```

## Checked against the deployed contract

The deployed `zcash-connector.bridge.near` reports version `0.9.7-rc.3`, and its code hash
(`4gG1v7fB1DYRozVKArT2PAV8UmjzxHRoFKuN78LBYpEW`) equals the SHA-256 of `zcash_bridge_release.wasm` in the
Near-One/btc-bridge GitHub release `btc-bridge-v0.9.7-rc3` (tag commit `d2140ec`, 2026-09-19). So the refund paths,
the fee and the address rules above were read from the exact source that is deployed, not from `omni-main`
(0.9.6). Its view methods (`get_config`, `get_metadata`, `get_refund_requests_paged`, `required_balance_for_*`)
return the fields that source defines.

## Limitations

- **The bundle is built by bridge-cli, not by this tool.** The tool prints the command; building an Orchard bundle
  needs a Zcash prover (librustzcash's `orchard` crate) that we do not reimplement.
- **The Zcash refund fee is computed, not read.** No view method returns the default refund fee, so the tool
  computes the contract's ZIP-317 formula (10,000 zatoshis). Once a request exists it uses the `gas_fee` stored on
  it. A fee set by the DAO or operator at request time is only visible after the request.
- **Sapling-only addresses.** The deployed connector cannot refund to a Sapling `zs1…` address, or to a unified
  address with neither an Orchard nor a transparent receiver, but `request_refund` does not check the address. The
  tool warns; it cannot stop someone from paying for such a request.
- **Mixed funding.** A deposit funded by transparent inputs and a shielded pool together is reported as such; the
  tool still only suggests a single transparent sender, as for a transparent deposit.
- **Third-party read APIs.** Blockchair, mempool.space, the Omni bridge indexer and FastNEAR are public, keyless
  services. Their terms of use have not been reviewed. Rate limits or outages show up as errors.
- **"Stuck" is a heuristic.** A deposit counts as stuck 6 hours after confirmation with no credit.
- **The scan is a lower bound.** It sees deposits the indexer lists (from 2026-06-25) and deposits with a refund
  request. A deposit to an address the indexer never handed out, or an older one nobody requested a refund for, is
  not seen.
- **No signing by design.** You still need `bridge-cli` (Near-One/bridge-sdk-rs) for the request and a shielded
  execute, the `near` CLI for the rest, and a NEAR account with a little more NEAR than each deposit: 2 NEAR to request
  and 1 NEAR to execute, both kept by the contract, plus up to 0.3 NEAR held for gas while a call runs.
- **Mainnet only.** The connector accounts and RPC endpoint are hard-coded for mainnet.
- Only Omni bridge deposits. Deposits through the PoA bridge, and what a NEAR Intents order does after the bridge
  credits it, are out of scope.

## Built for ZECATHON 2026

All the code here was written during the hackathon's build window (28 September to 28 October 2026). The refund
logic was first written between 10 and 14 October inside the Where's My Swap app of Cryppit's private monorepo, then
moved into this repository on 13 and 14 October; the first commit says so. Only the refund code moved. Where's My
Swap, our NEAR Intents order checker, is a separate product and not part of this entry.

## Licence

MIT, see LICENSE.
