# zec-refund-helper

Find a Zcash deposit that is stuck in the NEAR Omni bridge from its transaction hash, see where the ZEC is and who can
move it, and get the bridge's own refund steps. Bitcoin deposits through the same bridge work the same way.

Keyless and read-only: it never asks for, sees or holds a key, and it never signs or sends anything.

Live demo: https://wheres-my-swap.higgsfield.app/refund (part of Cryppit's Where's My Swap checker for NEAR Intents).

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

1. Looks the hash up on Zcash (Blockchair) and then on Bitcoin (mempool.space). Both are keyless public APIs.
2. For each output, asks the Omni bridge indexer for the deposit message behind that address, then checks the
   indexer's answer against the connector contract itself (`get_user_deposit_address`), so it does not rely on the indexer alone.
3. Reads from the connector over NEAR RPC (FastNEAR): whether the bridge holds the coin (`list_utxos`,
   `list_unavailable_utxos`), any refund request (`get_refund_requests_paged`), and the live config: timelocks,
   minimum deposit, refund fee cap and the NEAR deposits that `request_refund` and `execute_refund` need.
4. Checks on the UTXO chain whether the deposit output was spent and, if so, whether that spend was the refund
   (it spends only that coin and pays only the refund address).
5. Gives one verdict: `unconfirmed`, `not_a_deposit`, `credited`, `crediting` (first 6 hours), `refundable` (stuck),
   `requested` (in its timelock), `ready` (lock passed, nobody executed it), `executed` (waiting for the MPC signature)
   or `refunded`.
6. For a stuck deposit, prints the commands left to run, with live fees and timelocks:
   **request** (`bridge-cli … btc-request-refund`), then **wait for the lock**, then **execute** (`execute_refund`,
   which anyone may call), then **sign** (`bridge-cli … near-sign-btc-transaction`: NEAR's MPC network signs the Zcash
   refund transaction and the bridge's relayer broadcasts it).

`zec-refund --board` lists every refund request on both connectors, ready ones first with how long nobody has executed
them, then locked ones, then executed ones.

## Custody and trust model

- **Keyless.** It only reads public APIs and view methods. There is no key, account, login or API key anywhere in the code.
- **Non-custodial.** The tool never touches funds. The ZEC stays at the bridge's deposit address until the
  connector contract sends it back.
- **Refund only to the original sender.** The tool only ever suggests the refund address written into the deposit
  itself, or, if the deposit names none, the single transparent address that funded it. If several addresses
  funded it, it suggests nothing. The contract enforces the deposit's own `refund_address` when one is set. When none
  is set, the requester names the address, the longer 14-day lock applies, and the bridge's DAO or operator can reject a
  false claim during that lock. Once requested, the refund can only go to the address in the request.
- **The user signs.** Every step is a NEAR transaction the user signs with their own NEAR account, through
  `bridge-cli` or `near` CLI. Anyone may pay for these calls; that changes nothing about where the coin goes.

## Quickstart

Node 22.15 or newer, pnpm 11.

```bash
pnpm install
pnpm zec-refund <your Zcash transaction hash>            # the verdict and the steps left
pnpm zec-refund <hash> --vout 1                          # pick the output if the transaction has several
pnpm zec-refund <hash> --json                            # machine-readable report
pnpm zec-refund --board                                  # every open refund request, Zcash and Bitcoin

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
pnpm test        # unit tests and recorded-payload tests (no network)
pnpm typecheck
pnpm test:live   # on demand: the same checks against the real public endpoints
```

## Limitations

- **Transparent only.** The tool reads transparent Zcash data: the deposit's `t1…` address and its transparent
  senders. A deposit funded from a shielded pool has no transparent sender. Today the tool then suggests no refund
  address, and its message wrongly says several wallets funded the transaction.
- **Transparent refund command.** The `execute_refund` command it prints sends no Orchard bundle, so it makes a
  transparent refund. The contract and `bridge-cli` can also refund to a unified address with an Orchard receiver
  (see SUBMISSION.md, "Improvements"). This tool does not guide that yet.
- **Zcash refund fee.** For "too small to refund", the tool compares the deposit to the connector's `max_btc_gas_fee`
  (0.01 ZEC on Zcash). Per the contract source (Near-One/btc-bridge `main`), a Zcash refund request defaults to the much smaller ZIP-317 minimum
  fee, so a small Zcash deposit can be called unrefundable when it is not.
- **Third-party read APIs.** Blockchair, mempool.space, the Omni bridge indexer and FastNEAR are public, keyless
  services. Their terms of use have not been reviewed. Rate limits or outages show up as errors.
- **"Stuck" is a heuristic.** A deposit counts as stuck 6 hours after confirmation with no credit.
- **No signing by design.** You still need `bridge-cli` (Near-One/bridge-sdk-rs) or the `near` CLI and a NEAR account
  with a few NEAR for the request (2 NEAR, not returned) and the execution (1 NEAR) deposits.
- **Mainnet only.** The connector accounts and RPC endpoint are hard-coded for mainnet.
- Only Omni bridge deposits. A deposit through the PoA bridge or a NEAR Intents order account is checked in
  Where's My Swap instead.

## Licence

MIT, see LICENSE.
