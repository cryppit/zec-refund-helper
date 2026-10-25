// What the web page shows for a deposit check and for the refund board. The words are the CLI's own (render-btc-refund),
// so the page and the terminal never disagree; this file only adds structure and links to public explorers.
import type { BtcDepositReport } from "../btc-refund.js";
import { lockYears, unreachableLock, UTXO_CHAINS, type BoardRow, type BtcDepositVerdict, type RefundStep, type UtxoChain } from "../core/btc-refund.js";
import { describeDuration } from "../core/duration.js";
import { BOARD_LOCK_WHY, boardLockYears, fromWhom, headline, NEAR_CLI_TIMEOUT_NOTE, privacyLines, requestLockSec, sourcesLine, stepsIntro } from "../render-btc-refund.js";

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
  /** What anyone watching the chains can see about the deposit, and what stays hidden (the CLI's own lines). */
  privacy: string[];
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

/** The state's title, or what the bridge's years-long lock makes of it (a refund nobody can execute is not refundable). */
function titleOf(r: Report): [string, Tone] {
  const v = r.verdict;
  if (v.state === "refundable" && !v.tooSmall && unreachableLock(v.lockSec)) return [`Stuck: a refund would be locked for ${lockYears(v.lockSec)} years`, "bad"];
  if (v.state === "requested") {
    const lock = requestLockSec(r, v.unlocksAtSec);
    if (unreachableLock(lock)) return [`Refund requested, locked for ${lockYears(lock)} years`, "bad"];
  }
  return TITLE[v.state];
}

export function depositView(r: Report): DepositView {
  const f = r.facts;
  const { name, unit } = UTXO_CHAINS[f.chain];
  const [title, tone] = titleOf(r);
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
    headline: headline(r),
    stepsIntro: intro,
    steps: r.steps,
    timeoutNote: intro ? NEAR_CLI_TIMEOUT_NOTE : null,
    sources: sourcesLine(r),
    privacy: privacyLines(r),
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
  return rows.map((r) => {
    const lock = r.unlocksAtSec - r.requestedAtSec;
    const forever = r.state === "locked" && unreachableLock(lock);
    return {
      state: r.state === "ready" ? `Ready for ${describeDuration(r.readyForSec)}` : forever ? `Locked for ${lockYears(lock)} years (until ${day(r.unlocksAtSec)})` : r.state === "locked" ? `Locked until ${day(r.unlocksAtSec)}` : "Executed",
      tone: r.state === "ready" ? "warn" : forever ? "bad" : r.state === "locked" ? "info" : "ok",
      amount: `${coins(r.amountSat)} ${UTXO_CHAINS[r.chain].unit}`,
      refundTo: r.refundTo,
      deposit: `${r.txid.slice(0, 8)}…@${r.vout}`,
      href: `#q=${r.txid}:${r.vout}`,
    };
  });
}

/** The lines under the board: what Ready means, and the bridge's years-long lock when a row waits it out. */
export function boardNotes(rows: BoardRow[]): string[] {
  const years = boardLockYears(rows);
  return ["Ready: the lock has passed and anyone can execute the refund; the coin can only go to the address shown.", ...(years === null ? [] : [`Locked for ${years} years: ${BOARD_LOCK_WHY}`])];
}

/** `next`: the step someone can take now; `waiting`: it is coming without anyone acting; `stopped`: it did not happen. */
export type JourneyState = "done" | "next" | "waiting" | "stopped" | "not_reached";

export interface JourneyStop {
  title: string;
  note: string;
  state: JourneyState;
  /** The chain the stop happens on, for its logo: the deposit's chain, or NEAR where the bridge contract acts. */
  logo: UtxoChain | "near";
}

/**
 * The deposit's way as the page draws it: on its chain, the credit on NEAR, and, when the bridge never credited it, the
 * refund path (request, lock, execute, back to the sender). Null for a transaction that is not a bridge deposit.
 */
export function journeyView(r: Report): JourneyStop[] | null {
  const v = r.verdict;
  const f = r.facts;
  const chain = UTXO_CHAINS[f.chain].name;
  if (v.state === "not_a_deposit") return null;
  const home = f.chain;
  const deposit: JourneyStop = f.confirmedAtSec ? { title: `Deposit on ${chain}`, note: `Confirmed ${when(f.confirmedAtSec)}`, state: "done", logo: home } : { title: `Deposit on ${chain}`, note: "Waiting for its first confirmation", state: "waiting", logo: home };
  const credit = (state: JourneyState, note: string): JourneyStop => ({ title: "Credit on NEAR", note, state, logo: "near" });
  const lockFor = (sec: number): string => (unreachableLock(sec) ? `${lockYears(sec)} years` : describeDuration(sec));
  type Step = Omit<JourneyStop, "logo">;
  // The bridge contract on NEAR runs the request, lock and execute; the coin goes back on its own chain.
  const refund = (request: Step, lock: Step, execute: Step, back: Step): JourneyStop[] => [deposit, credit("stopped", "Never credited: the refund path is the way out"), { ...request, logo: "near" }, { ...lock, logo: "near" }, { ...execute, logo: "near" }, { ...back, logo: home }];
  const later = (title: string, note: string): Step => ({ title, note, state: "not_reached" });
  const back: Step = { title: "Back to the sender", note: "To the refund address only", state: "not_reached" };

  switch (v.state) {
    case "unconfirmed":
      return [deposit, credit("not_reached", "After the deposit confirms")];
    case "credited":
      return [deposit, credit("done", r.orderAccount ? `Into ${r.orderAccount.slice(0, 10)}…` : "Into the NEAR account it named")];
    case "crediting":
      return [deposit, credit("waiting", "Not credited yet; the bridge usually credits within the hour")];
    case "absorbed":
      return [deposit, credit("stopped", `Absorbed below the bridge's minimum: no refund path`)];
    case "placeholder_refund":
      return refund({ title: "Refund request", note: "Its refund address is a public placeholder", state: "stopped" }, later("Lock", "Before anyone can execute"), later("Execute", "Anyone can"), back);
    case "too_old":
      return refund({ title: "Refund request", note: "Too old: the bridge no longer has the deposit's block", state: "stopped" }, later("Lock", "Before anyone can execute"), later("Execute", "Anyone can"), back);
    case "refundable": {
      const request: Step = unreachableLock(v.lockSec)
        ? { title: "Refund request", note: `A refund would be locked for ${lockYears(v.lockSec)} years`, state: "stopped" }
        : v.tooSmall
          ? { title: "Refund request", note: "Smaller than the refund fee: the contract refuses it", state: "stopped" }
          : { title: "Refund request", note: "Your step: request it (2 NEAR, signed by you)", state: "next" };
      return refund(request, later("Lock", lockFor(v.lockSec)), later("Execute", "Anyone can, after the lock"), back);
    }
    case "requested": {
      const lock = requestLockSec(r, v.unlocksAtSec);
      const waits: Step = unreachableLock(lock) ? { title: "Lock", note: `Locked for ${lockYears(lock)} years`, state: "stopped" } : { title: "Lock", note: `Unlocks ${when(v.unlocksAtSec)}`, state: "waiting" };
      return refund({ title: "Refund requested", note: "The request is on chain", state: "done" }, waits, later("Execute", "Anyone can, after the lock"), back);
    }
    case "ready":
      return refund({ title: "Refund requested", note: "The request is on chain", state: "done" }, { title: "Lock", note: `Passed ${when(v.unlockedAtSec)}`, state: "done" }, { title: "Execute", note: "Anyone can execute it now", state: "next" }, back);
    case "executed":
      return refund({ title: "Refund requested", note: "The request is on chain", state: "done" }, { title: "Lock", note: "Passed", state: "done" }, { title: "Execute", note: "Executed", state: "done" }, { title: "Back to the sender", note: "The bridge signs and sends it", state: "waiting" });
    case "refunded":
      return refund({ title: "Refund requested", note: "The request is on chain", state: "done" }, { title: "Lock", note: "Passed", state: "done" }, { title: "Execute", note: "Executed", state: "done" }, { title: "Back to the sender", note: `Returned to ${v.refundTo.slice(0, 12)}…`, state: "done" });
  }
}
