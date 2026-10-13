// Plain-text report for a Bitcoin or Zcash deposit check (CLI): one headline for what happened, then what is left to do.

import type { BtcDepositReport } from "./btc-refund.js";
import { describeDuration } from "./core/duration.js";
import { UTXO_CHAINS, type BoardRow } from "./core/btc-refund.js";

type Report = Exclude<BtcDepositReport, { error: string }>;

/** The full NEAR Intents order checker this helper was extracted from. */
const CHECKER = "Where's My Swap (https://wheres-my-swap.higgsfield.app)";

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
const when = (sec: number): string => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
function headline(r: Report): string[] {
  const v = r.verdict;
  const f = r.facts;
  const { name, minor } = UTXO_CHAINS[f.chain];
  switch (v.state) {
    case "unconfirmed":
      return [`NOT CONFIRMED YET  the bridge counts a deposit only after ${name} confirms it; check again later.`];
    case "not_a_deposit":
      return [
        `NOT AN OMNI ${f.chain.toUpperCase()} DEPOSIT  no output of this transaction pays a deposit address the Omni ${name} bridge knows.`,
        `A deposit through the PoA bridge is not covered here: paste the same hash into ${CHECKER}.`,
      ];
    case "credited":
      return [`CREDITED  the bridge took this deposit in; follow its order account ${v.orderAccount} in ${CHECKER}.`];
    case "refunded":
      return [`REFUNDED  sent back to ${v.refundTo} in ${name} transaction ${v.refundTx}`];
    case "crediting":
      return [`CREDITING  not credited yet, which is normal in the first hours; if nothing changes by ${when(v.stuckAfterSec)}, check again for the refund steps.`];
    case "requested":
      return [`REFUND REQUESTED  the lock ends on ${when(v.unlocksAtSec)}; after that anyone can execute it.`, `The bridge can only send it to ${v.refundTo}.`];
    case "ready":
      return [
        `READY TO REFUND  the refund was requested on ${day(f.request?.createdAtSec ?? v.unlockedAtSec)} and its lock ended on ${day(v.unlockedAtSec)}; nobody has executed it yet.`,
        `The bridge can only send it to ${v.refundTo}.`,
      ];
    case "executed":
      return [`REFUND EXECUTED  waiting for the bridge to sign the ${name} refund to ${v.refundTo} and broadcast it.`];
    case "refundable": {
      const lines = [`STUCK  confirmed ${day(f.confirmedAtSec ?? 0)} and never credited on NEAR. The bridge's own refund can send it back.`];
      if (v.belowMinimum) lines.push(`It is below the bridge's ${r.config.minDepositSat}-${minor.replace(/s$/, "")} minimum deposit, which is likely why it was never credited.`);
      if (v.tooSmall) lines.push(`It is smaller than the refund's ${name} fee (up to ${r.config.maxGasFeeSat} ${minor}), so a refund would return nothing.`);
      else if (v.refundTo === null) lines.push("Several wallets funded this transaction, so we cannot tell which is yours; the refund address has to be named by the depositor (bridge-cli --refund-address).");
      else lines.push(v.refundToFromDeposit ? `The deposit names its refund address: ${v.refundTo}.` : `The deposit names no refund address; the refund would go to the wallet that sent it: ${v.refundTo}.`);
      return lines;
    }
  }
}

export function renderBtcRefundText(r: Report): string {
  const f = r.facts;
  const { name, unit, connector } = UTXO_CHAINS[f.chain];
  const lines: string[] = [];
  lines.push(`${`${name} deposit`.padEnd(18)}${f.txid} (output ${f.vout})`);
  lines.push(`                  ${(f.amountSat / 1e8).toFixed(8)} ${unit} from ${f.senders.join(", ") || "?"} to ${f.depositAddress}${f.confirmedAtSec ? `, confirmed ${when(f.confirmedAtSec)}` : ""}`);
  if (r.orderAccount) lines.push(`For NEAR account  ${r.orderAccount}`);
  lines.push("");
  lines.push(...headline(r));
  if (r.steps.length) {
    lines.push("");
    lines.push("What is left. Sign each step with your own NEAR account; anyone can pay these fees, and the coin can only go to the address above.");
    r.steps.forEach((s, i) => {
      lines.push(`${i + 1}. ${s.title}`);
      if (s.command) lines.push(`   ${s.command}`);
      if (s.note) lines.push(`   ${s.note}`);
    });
  }
  lines.push("");
  const explorer = f.chain === "btc" ? "mempool.space" : "Blockchair";
  lines.push(`Sources: ${explorer}; the Omni bridge indexer's deposit message, checked against ${connector}; ${connector} (refund request, timelocks, fees). We never hold keys or sign anything.`);
  return lines.join("\n");
}

/** The stuck-money board: every open refund request, ready ones first. */
export function renderRefundBoardText(rows: BoardRow[], nowSec: number): string {
  if (rows.length === 0) return "No refund requests are open on the Omni Bitcoin and Zcash bridges.";
  const lines = [`${rows.length} refund request${rows.length === 1 ? "" : "s"} on the Omni Bitcoin and Zcash bridges (${when(nowSec)}):`, ""];
  for (const r of rows) {
    const state = r.state === "ready" ? `READY ${describeDuration(r.readyForSec)}` : r.state === "locked" ? `locked until ${day(r.unlocksAtSec)}` : "executed";
    lines.push(`${state.padEnd(14)} ${(r.amountSat / 1e8).toFixed(8)} ${UTXO_CHAINS[r.chain].unit}  -> ${r.refundTo}  ${r.txid}@${r.vout}`);
  }
  lines.push("", "READY: the lock has passed and anyone can execute the refund; the coin can only go to the address shown.");
  return lines.join("\n");
}
