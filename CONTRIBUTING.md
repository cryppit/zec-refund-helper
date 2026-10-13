# Contributing

Thanks for helping people get stuck ZEC back. Issues and pull requests are welcome.

## Ground rules

- **Read-only, keyless, non-custodial.** No change may add a private key, seed, API key, wallet connection,
  transaction signing or broadcasting. The tool prints commands; the user signs them.
- **Never suggest a refund address the deposit does not prove.** The only address the tool may suggest is the one in
  the deposit's own message or, failing that, the deposit's single transparent sender.
- **Facts from the source.** Every verdict comes from the chain, the connector contract or the bridge indexer. If the
  indexer is used, its answer is checked against the contract.

## Development

Node 22.15 or newer, pnpm 11.

```bash
pnpm install
pnpm test          # no network: recorded payloads in src/fixtures/
pnpm typecheck     # strict TypeScript
pnpm test:live     # optional: the real public endpoints
```

- Write the failing test first. Pure logic (verdicts, steps, the board) lives in `src/core/` and takes plain data,
  with no network and no clock. I/O lives in `src/btc-refund.ts` behind the `BtcRefundClient` interface. Tests pass
  a recorded `fetch`.
- TypeScript is strict with `noUncheckedIndexedAccess`. Do not use `any`; parse unknown JSON with type guards.
- No runtime dependencies: use the platform's `fetch`. A new dev dependency needs an exact version.
- New fixtures are real responses recorded from the public endpoints, trimmed to what the test needs. Never record
  anything that is not public chain or contract data.

## Pull requests

Keep one change per pull request. Say what it changes for a user with a stuck deposit, and how you tested it,
including a live run if it touches a client. By contributing you agree that your contribution is licensed under the
MIT licence of this repository.

## Security

If you find a way the tool could point someone's refund at the wrong address, do not open a public issue. Contact the
maintainers privately first. If the problem is in the bridge itself (Near-One/btc-bridge), report it to that project's
own security channel.
