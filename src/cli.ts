#!/usr/bin/env node
// zec-refund: check a Zcash (or Bitcoin) deposit into NEAR Intents through the Omni bridge and, if it is stuck, the
// bridge's own refund steps.
//
//   zec-refund <your Zcash or Bitcoin transaction hash> [--vout N] [--json]
//   zec-refund <a Zcash address> [--json]   # can a transparent-only or a shielded wallet pay it (offline)
//   zec-refund --board [--json]          # every open refund request on both connectors
//   zec-refund --scan [--json] [--since YYYY-MM-DD] [--cache DIR] [--progress FILE] [--concurrency N]
//                                        # every uncredited deposit the bridge indexer lists, checked, with totals
//
// Public data only, no key: Blockchair / mempool.space, the Omni bridge indexer, and the connector contracts over NEAR
// RPC. Prints the commands still to run; it never signs or sends anything.

import { checkBtcDeposit, checkRefundBoard, type BtcRefundClient } from "./btc-refund.js";
import { refundAddressNote, zcashSendAdvice } from "./core/zcash-address.js";
import { renderBtcRefundText, renderRefundBoardText } from "./render-btc-refund.js";
import { asZcashAddress, renderAddressText } from "./render-address.js";
import { renderScanText } from "./render-scan.js";
import { checkClients, INDEX_FIRST_RECORD_SEC, pacedFetch, SCAN_INTERVALS_MS, scanCandidates, walkIndexer } from "./scan.js";
import { appendFileSync } from "node:fs";

const USAGE =
  "usage: zec-refund <your Zcash or Bitcoin transaction hash> [--vout N] [--json]\n       zec-refund <a Zcash address> [--json]\n       zec-refund --board [--json]\n       zec-refund --scan [--json] [--since YYYY-MM-DD] [--cache DIR] [--progress FILE] [--concurrency N]";

const argv = process.argv.slice(2);
const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
/** Zcash first: this is the Zcash refund helper. A hash is looked up on each chain in turn, paced per host. */
const clients = (): BtcRefundClient[] => checkClients(fetch);
const nowSec = (): number => Math.floor(Date.now() / 1000);

async function main(): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const json = argv.includes("--json");
  if (argv.includes("--board")) {
    const now = nowSec();
    const rows = await checkRefundBoard(clients(), now);
    console.log(json ? JSON.stringify(rows, null, 2) : renderRefundBoardText(rows, now));
    return 0;
  }

  if (argv.includes("--scan")) return scan(json);

  const voutIdx = argv.indexOf("--vout");
  const input = argv.find((a, i) => !a.startsWith("--") && (voutIdx === -1 || i !== voutIdx + 1));
  const vout = voutIdx === -1 ? undefined : Number(argv[voutIdx + 1]);
  if (!input || (vout !== undefined && (!Number.isInteger(vout) || vout < 0))) {
    console.error(USAGE);
    return 2;
  }
  const address = /^[0-9a-fA-F]{64}$/.test(input) ? null : asZcashAddress(input);
  if (address) {
    console.log(json ? JSON.stringify({ ...address, advice: zcashSendAdvice(address), refundNote: refundAddressNote(address) }, null, 2) : renderAddressText(address));
    return 0;
  }
  const r = await checkBtcDeposit(input, clients(), nowSec(), vout);
  if ("error" in r) {
    console.error(`error: ${r.error}`);
    return 1;
  }
  console.log(json ? JSON.stringify(r, replacer, 2) : renderBtcRefundText(r));
  return 0;
}

const opt = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

/** The full scan: walk the indexer (long; progress on stderr and in --progress FILE), then check each candidate. */
async function scan(json: boolean): Promise<number> {
  const progressFile = opt("--progress");
  const progress = (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.error(line);
    if (progressFile) appendFileSync(progressFile, line + "\n");
  };
  const since = opt("--since");
  const fromSec = since ? Date.parse(`${since}T00:00:00Z`) / 1000 : Math.floor(INDEX_FIRST_RECORD_SEC / 86_400) * 86_400;
  const concurrency = Number(opt("--concurrency") ?? 8);
  if (!Number.isFinite(fromSec) || !Number.isInteger(concurrency) || concurrency < 1) {
    console.error(USAGE);
    return 2;
  }
  const now = nowSec();
  const onRetry = (url: string, attempt: number, why: string): void => progress(`retry ${attempt} ${new URL(url).host}: ${why}`);
  const walk = await walkIndexer(pacedFetch(fetch, { intervalMs: SCAN_INTERVALS_MS, onRetry }), { fromSec, toSec: now, concurrency, cacheDir: opt("--cache"), onProgress: progress });
  progress(`walk done: ${walk.pages} pages, ${walk.records} transfers, ${walk.open.length} deposits not Finalised`);
  const report = await scanCandidates(pacedFetch(fetch, { intervalMs: SCAN_INTERVALS_MS, cache: true, onRetry }), { nowSec: now, walk, onProgress: progress });
  console.log(json ? JSON.stringify(report, replacer, 2) : renderScanText(report));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
