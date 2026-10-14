// Plain-text report for `zec-refund --scan`: the totals per chain, then one line per stuck deposit.

import { describeDuration } from "./core/duration.js";
import { UTXO_CHAINS, type UtxoChain } from "./core/btc-refund.js";
import type { ScanRow } from "./core/scan.js";
import type { ScanReport } from "./scan.js";

const when = (sec: number): string => new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const coins = (sat: number): string => (sat / 1e8).toFixed(8);
const usd = (x: number): string => `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const REFUND: Record<ScanRow["refundableNow"], string> = {
  request: "request now",
  execute: "EXECUTE now",
  sign: "sign now",
  locked: "locked",
  no: "no",
};

export function rowLine(r: ScanRow): string {
  const unit = UTXO_CHAINS[r.chain].unit;
  const refund = r.verdict === "absorbed" ? "absorbed" : r.refund.status === "none" ? "no request" : `request ${r.refund.status}`;
  return `${coins(r.amountSat)} ${unit}  ${describeDuration(r.ageSec).padEnd(8)}  ${r.cause.padEnd(13)}  ${refund.padEnd(16)}  ${REFUND[r.refundableNow].padEnd(11)}  ${r.txid}@${r.vout}`;
}

function chainBlock(rep: ScanReport, chain: UtxoChain): string[] {
  const s = rep.summary[chain];
  const { unit, name } = UTXO_CHAINS[chain];
  const seen = rep.coverage.seen[chain];
  const lines = [
    `${name}: ${s.stuckCount} stuck deposits, ${coins(s.stuckSat)} ${unit} (${usd(s.stuckUsd)} at $${rep.prices.usd[chain]})`,
    `  the indexer lists ${seen.deposits} ${name} deposits in the window, ${seen.finalised} credited when walked`,
    `  by cause: ${Object.entries(s.byCause).map(([k, v]) => `${k} ${v.count} (${coins(v.sat)} ${unit})`).join(", ") || "none"}`,
    `  absorbed below the minimum (verified into unavailable UTXOs, nothing minted, no refund path): ${s.absorbedCount} (${coins(s.absorbedSat)} ${unit})`,
    `  refundable now: ${s.refundableNowCount} (${coins(s.refundableNowSat)} ${unit}); requests ready and unexecuted: ${s.readyUnexecuted} (${coins(s.readyUnexecutedSat)} ${unit})`,
    `  pending (inside the 6-hour crediting window, not counted): ${s.pendingCount} (${coins(s.pendingSat)} ${unit})`,
    `  bridge payouts that landed on deposit addresses (not user deposits, not counted): ${s.bridgePayoutCount} (${coins(s.bridgePayoutSat)} ${unit})`,
    `  ages: ${Object.entries(s.ages).map(([k, v]) => `${k} ${v}`).join(", ")}`,
  ];
  if (s.oldest) lines.push(`  oldest: ${s.oldest.txid}@${s.oldest.vout}, ${describeDuration(s.oldest.ageSec)}, ${coins(s.oldest.amountSat)} ${unit}`);
  if (chain === "zcash") lines.push(`  shielded-funded: ${s.shieldedFunded}; refund address shielded-only (Orchard, no transparent receiver): ${s.shieldedOnlyRefundAddress}`);
  const rows = rep.rows.filter((r) => r.chain === chain && r.cause !== "pending");
  if (rows.length > 0) lines.push("", ...rows.map((r) => `  ${rowLine(r)}`));
  return lines;
}

export function renderScanText(rep: ScanReport): string {
  return [
    `Stuck deposits in the Omni bridge's Bitcoin and Zcash connectors, ${when(rep.snapshotAtSec)}`,
    `Coverage: deposits the bridge indexer lists from ${when(rep.coverage.indexFromSec)} (${rep.coverage.records} transfers on ${rep.coverage.pages} pages), plus every refund request on the connectors (${rep.coverage.refundRequests.btc} Bitcoin, ${rep.coverage.refundRequests.zcash} Zcash) and every coin in their unavailable UTXOs, all time (${rep.coverage.unavailableUtxos.btc} Bitcoin, ${rep.coverage.unavailableUtxos.zcash} Zcash). A lower bound: deposits to addresses the indexer never knew, and deposits before the window without a refund request, are not seen.`,
    `Prices: ${rep.prices.source}, BTC $${rep.prices.usd.btc} (${when(rep.prices.asOfSec.btc)}), ZEC $${rep.prices.usd.zcash} (${when(rep.prices.asOfSec.zcash)}).`,
    "",
    ...chainBlock(rep, "zcash"),
    "",
    ...chainBlock(rep, "btc"),
    ...(rep.unchecked.length > 0 ? ["", `Not checked (API errors, not counted): ${rep.unchecked.length}`, ...rep.unchecked.map((u) => `  ${u.chain} ${u.txid}@${u.vout}: ${u.error}`)] : []),
  ].join("\n");
}
