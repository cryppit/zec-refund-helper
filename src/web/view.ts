// What the web page shows for a deposit check and for the refund board. The words are the CLI's own (render-btc-refund),
// so the page and the terminal never disagree; this file only adds structure and links to public explorers.
import type { BtcDepositReport } from "../btc-refund.js";
import { UTXO_CHAINS, type BoardRow, type BtcDepositVerdict, type RefundStep, type UtxoChain } from "../core/btc-refund.js";
import { describeDuration } from "../core/duration.js";
import { fromWhom, headline, NEAR_CLI_TIMEOUT_NOTE, sourcesLine, stepsIntro } from "../render-btc-refund.js";

type Report = Exclude<BtcDepositReport, { error: string }>;
export type Tone = "ok" | "warn" | "bad" | "info";

export interface Fact {
  label: string;
  value: string;
  href: string | null;
}

export interface DepositView {
  chain: string;
  title: string;
  tone: Tone;
  facts: Fact[];
  /** The CLI's headline: the state in capitals, then why. */
  headline: string[];
  stepsIntro: string | null;
  steps: RefundStep[];
  timeoutNote: string | null;
  sources: string;
}

const TITLE: Record<BtcDepositVerdict["state"], [string, Tone]> = {
  unconfirmed: ["Not confirmed yet", "info"],
  not_a_deposit: ["Not an Omni bridge deposit", "info"],
  credited: ["Credited", "ok"],
  absorbed: ["Absorbed below the minimum", "bad"],
  placeholder_refund: ["Not recoverable by its sender", "bad"],
  too_old: ["Too old to request", "bad"],
  refunded: ["Refunded", "ok"],
  crediting: ["Not credited yet", "info"],
  refundable: ["Stuck, and refundable", "warn"],
  requested: ["Refund requested", "info"],
  ready: ["Ready to refund", "warn"],
  executed: ["Refund executed", "info"],
};

const coins = (sat: number): string => (sat / 1e8).toFixed(8);
const when = (sec: number): string => `${new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

function txUrl(chain: UtxoChain, txid: string): string {
  return chain === "btc" ? `https://mempool.space/tx/${txid}` : `https://blockchair.com/zcash/transaction/${txid}`;
}

/** A transparent address has a public page; a shielded one (u1…, zs…) has none. */
function addressUrl(chain: UtxoChain, address: string): string | null {
  if (chain === "btc") return `https://mempool.space/address/${address}`;
  return /^t[13]/.test(address) ? `https://blockchair.com/zcash/address/${address}` : null;
}

/** A pasted transaction hash, with an optional output (`txid:1` or `txid@1`). */
export function parseQuery(raw: string): { txid: string; vout?: number } | null {
  const m = /^([0-9a-fA-F]{64})(?:[:@](\d{1,5}))?$/.exec(raw.trim());
  if (!m) return null;
  const txid = (m[1] ?? "").toLowerCase();
  return m[2] === undefined ? { txid } : { txid, vout: Number(m[2]) };
}

export function depositView(r: Report): DepositView {
  const f = r.facts;
  const { name, unit } = UTXO_CHAINS[f.chain];
  const [title, tone] = TITLE[r.verdict.state];
  const facts: Fact[] = [
    { label: "Deposit", value: `${f.txid} (output ${f.vout})`, href: txUrl(f.chain, f.txid) },
    { label: "Amount", value: `${coins(f.amountSat)} ${unit}`, href: null },
    { label: "From", value: fromWhom(f), href: null },
    { label: "To the bridge deposit address", value: f.depositAddress, href: addressUrl(f.chain, f.depositAddress) },
    { label: "Confirmed", value: f.confirmedAtSec ? when(f.confirmedAtSec) : "not yet", href: null },
  ];
  if (r.orderAccount) facts.push({ label: "For NEAR account", value: r.orderAccount, href: `https://nearblocks.io/address/${r.orderAccount}` });
  const intro = stepsIntro(r);
  return {
    chain: name,
    title,
    tone,
    facts,
    headline: headline(r, null),
    stepsIntro: intro,
    steps: r.steps,
    timeoutNote: intro ? NEAR_CLI_TIMEOUT_NOTE : null,
    sources: sourcesLine(r),
  };
}

export interface BoardRowView {
  state: string;
  tone: Tone;
  amount: string;
  refundTo: string;
  deposit: string;
  /** Checks this deposit on the same page. */
  href: string;
}

export function boardView(rows: BoardRow[]): BoardRowView[] {
  return rows.map((r) => ({
    state: r.state === "ready" ? `Ready for ${describeDuration(r.readyForSec)}` : r.state === "locked" ? `Locked until ${day(r.unlocksAtSec)}` : "Executed",
    tone: r.state === "ready" ? "warn" : r.state === "locked" ? "info" : "ok",
    amount: `${coins(r.amountSat)} ${UTXO_CHAINS[r.chain].unit}`,
    refundTo: r.refundTo,
    deposit: `${r.txid.slice(0, 8)}…@${r.vout}`,
    href: `#q=${r.txid}:${r.vout}`,
  }));
}
