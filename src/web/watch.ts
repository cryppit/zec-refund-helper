// The watch page's model: a list of deposits a person or a wallet support team waits on, each re-checked with the same
// deposit check, and what changed since the last look. Pure: no DOM, no clock, no storage (the page passes those in).
import type { DepositView, Tone } from "./view.js";
import { parseQuery } from "./view.js";

/** At most this many deposits on one watch list: each check reads several public services. */
export const WATCH_MAX = 25;
/** A note after the hash (a ticket number, a customer's name) is cut to this length. */
const NOTE_MAX = 60;

export interface WatchItem {
  /** The deposit as typed for the check: the transaction hash, with ":output" when one was given. */
  q: string;
  /** Whatever followed the hash on its line, kept in this browser only. */
  note: string;
}

/** What the last check said, kept so the next one can say what changed. */
export interface Seen {
  title: string;
  tone: Tone;
  atSec: number;
}

export interface WatchRow {
  q: string;
  note: string;
  chain: string;
  amount: string;
  title: string;
  tone: Tone;
  /** Why it is in that state and what comes next, in the check's own words. */
  why: string;
  checkedAtSec: number;
  /** The earlier state when it changed since the last check, else null. */
  was: Seen | null;
}

/**
 * One deposit per line: a transaction hash (optionally `:output`), then anything as a note. Repeats are dropped; lines
 * that are no hash come back in `rejected`, and lines past WATCH_MAX in `overflow`.
 */
export function parseWatchList(text: string): { items: WatchItem[]; rejected: string[]; overflow: number } {
  const items: WatchItem[] = [];
  const rejected: string[] = [];
  let overflow = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const [first = "", ...rest] = line.split(/\s+/);
    const parsed = parseQuery(first);
    if (!parsed) {
      rejected.push(line);
      continue;
    }
    const q = parsed.vout === undefined ? parsed.txid : `${parsed.txid}:${parsed.vout}`;
    if (items.some((i) => i.q === q)) continue;
    if (items.length >= WATCH_MAX) {
      overflow++;
      continue;
    }
    items.push({ q, note: rest.join(" ").slice(0, NOTE_MAX) });
  }
  return { items, rejected, overflow };
}

/** The watch list written back as text, one deposit per line, for the box. */
export function watchListText(items: WatchItem[]): string {
  return items.map((i) => (i.note ? `${i.q} ${i.note}` : i.q)).join("\n");
}

/** The check's headline without its state in capitals: "READY TO REFUND  the refund was…" gives "the refund was…". */
function whyOf(v: DepositView): string {
  const first = v.headline[0] ?? "";
  const cut = first.indexOf("  ");
  const why = cut >= 0 ? first.slice(cut + 2) : first;
  return [why, ...v.headline.slice(1)].join(" ");
}

export function watchRow(item: WatchItem, v: DepositView, prev: Seen | undefined, nowSec: number): WatchRow {
  return {
    q: item.q,
    note: item.note,
    chain: v.chain,
    amount: v.facts.find((f) => f.label === "Amount")?.value ?? "",
    title: v.title,
    tone: v.tone,
    why: whyOf(v),
    checkedAtSec: nowSec,
    was: prev && prev.title !== v.title ? prev : null,
  };
}

/** A deposit the check could not read this time (a busy public service): its last known state is kept, not replaced. */
export function failedRow(item: WatchItem, message: string, prev: Seen | undefined, nowSec: number): WatchRow {
  return {
    q: item.q,
    note: item.note,
    chain: "",
    amount: "",
    title: prev ? `${prev.title} (last check)` : "Not checked yet",
    tone: "info",
    why: `This check couldn't read it: ${message} It will try again on the next round.`,
    checkedAtSec: nowSec,
    was: null,
  };
}

const when = (sec: number): string => `${new Date(sec * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;

/** Plain text for a support ticket or a message: each deposit, its state, why, and what changed. */
export function summaryText(rows: WatchRow[], nowSec: number): string {
  const lines = [`Omni bridge deposits, checked ${when(nowSec)} with Zcash Refund Helper (read-only, public data):`, ""];
  for (const r of rows) {
    const head = [r.note, r.chain && r.amount ? `${r.amount} on ${r.chain}` : r.chain || r.amount].filter(Boolean).join(" · ");
    lines.push(`- ${r.q}${head ? ` (${head})` : ""}`);
    lines.push(`  ${r.title}: ${r.why}`);
    if (r.was) lines.push(`  Changed since ${when(r.was.atSec)}: it was "${r.was.title}".`);
  }
  lines.push("", "Nobody needs your keys or seed phrase to check or refund a deposit.");
  return lines.join("\n");
}
