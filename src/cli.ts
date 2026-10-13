#!/usr/bin/env node
// zec-refund: check a Zcash (or Bitcoin) deposit into NEAR Intents through the Omni bridge and, if it is stuck, the
// bridge's own refund steps.
//
//   zec-refund <your Zcash or Bitcoin transaction hash> [--vout N] [--json]
//   zec-refund --board [--json]          # every open refund request on both connectors
//
// Public data only, no key: Blockchair / mempool.space, the Omni bridge indexer, and the connector contracts over NEAR
// RPC. Prints the commands still to run; it never signs or sends anything.

import { publicBtcRefundClient, checkBtcDeposit, checkRefundBoard, type BtcRefundClient } from "./btc-refund.js";
import { renderBtcRefundText, renderRefundBoardText } from "./render-btc-refund.js";

const USAGE = "usage: zec-refund <your Zcash or Bitcoin transaction hash> [--vout N] [--json]\n       zec-refund --board [--json]";

const argv = process.argv.slice(2);
const replacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);
/** Zcash first: this is the Zcash refund helper. A hash is looked up on each chain in turn. */
const clients = (): BtcRefundClient[] => [publicBtcRefundClient(fetch, undefined, "zcash"), publicBtcRefundClient(fetch, undefined, "btc")];
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

  const voutIdx = argv.indexOf("--vout");
  const input = argv.find((a, i) => !a.startsWith("--") && (voutIdx === -1 || i !== voutIdx + 1));
  const vout = voutIdx === -1 ? undefined : Number(argv[voutIdx + 1]);
  if (!input || (vout !== undefined && (!Number.isInteger(vout) || vout < 0))) {
    console.error(USAGE);
    return 2;
  }
  const r = await checkBtcDeposit(input, clients(), nowSec(), vout);
  if ("error" in r) {
    console.error(`error: ${r.error}`);
    return 1;
  }
  console.log(json ? JSON.stringify(r, replacer, 2) : renderBtcRefundText(r));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
