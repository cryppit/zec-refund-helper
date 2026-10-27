// The watch page: a list of deposits re-checked with the same deposit check, showing what changed since the last look.
// The list and the last states stay in this browser (localStorage); lookups go to the same public sources as a check.
// Everything shown is built with textContent, never parsed as HTML.
import { checkBtcDeposit, publicUtxoRefundClients } from "../src/btc-refund.js";
import { depositView } from "../src/web/view.js";
import { failedRow, parseWatchList, summaryText, watchListText, watchRow, type Seen, type WatchItem, type WatchRow } from "../src/web/watch.js";
import { byId, el, loading } from "./ui.js";

const form = byId<HTMLFormElement>("form");
const box = byId<HTMLTextAreaElement>("list");
const out = byId<HTMLElement>("out");
const status = byId<HTMLElement>("status");
const copyBtn = byId<HTMLButtonElement>("copy");
const notifyBtn = byId<HTMLButtonElement>("notify");
const clearBtn = byId<HTMLButtonElement>("clear");

const KEY = "zec-refund-helper.watch.v1";
const ROUND_MS = 10 * 60 * 1000; // a fresh round every 10 minutes while the page is open
const GAP_MS = 1500; // between deposits, so the free public services are not flooded

interface Saved {
  items: WatchItem[];
  seen: Record<string, Seen>;
}

// Storage can be missing or refused (a private window, blocked site data): the page still works, it just forgets.
function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as Saved | null;
    if (s && Array.isArray(s.items) && s.seen && typeof s.seen === "object") return s;
  } catch {
    /* nothing saved, or storage refused */
  }
  return { items: [], seen: {} };
}
function save(s: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage refused: this round still shows */
  }
}

const nowSec = (): number => Math.floor(Date.now() / 1000);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const when = (sec: number): string => `${new Date(sec * 1000).toISOString().replace("T", " ").slice(11, 16)} UTC`;
const reason = (e: unknown): string => (e instanceof Error && e.name === "NearRpcUnavailable" ? "NEAR's public servers are busy." : e instanceof Error ? e.message : String(e));

let state = load();
let rows: WatchRow[] = [];
let round = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function short(q: string): string {
  const [txid = "", vout] = q.split(":");
  return `${txid.slice(0, 10)}…${txid.slice(-6)}${vout === undefined ? "" : `:${vout}`}`;
}

function render(): void {
  if (!rows.length) return void out.replaceChildren();
  const body = el("tbody");
  for (const r of rows) {
    const deposit = el("td", {}, el("a", { href: `./#q=${r.q}`, text: short(r.q) }));
    if (r.note) deposit.append(el("small", { text: r.note }));
    const stateCell = el("td", { className: r.tone }, el("b", { text: r.title }));
    if (r.was) stateCell.append(el("span", { className: "changed", text: `Changed · was ${r.was.title}` }));
    body.append(el("tr", { className: r.was ? "is-changed" : "" }, deposit, el("td", { text: r.amount ? `${r.amount}` : "" }), stateCell, el("td", { className: "why", text: r.why }), el("td", { className: "mono", text: when(r.checkedAtSec) })));
  }
  const head = el("thead", {}, el("tr", {}, ...["Deposit", "Amount", "State", "Why, and what comes next", "Checked"].map((h) => el("th", { text: h }))));
  out.replaceChildren(el("div", { className: "watch-table" }, el("table", {}, head, body)));
  copyBtn.disabled = false;
}

function changedCount(): number {
  return rows.filter((r) => r.was).length;
}

async function checkAll(): Promise<void> {
  clearTimeout(timer);
  const mine = ++round;
  const items = state.items;
  if (!items.length) {
    rows = [];
    render();
    status.textContent = "Add at least one deposit hash to watch.";
    return;
  }
  if (!rows.length) out.replaceChildren(loading("Reading the chain…", `Checking ${items.length} deposit${items.length === 1 ? "" : "s"}, one at a time.`));
  const next: WatchRow[] = [];
  for (const [i, item] of items.entries()) {
    status.textContent = `Checking ${i + 1} of ${items.length}…`;
    const [txid = "", vout] = item.q.split(":");
    const prev = state.seen[item.q];
    try {
      const r = await checkBtcDeposit(txid, publicUtxoRefundClients(), nowSec(), vout === undefined ? undefined : Number(vout));
      if (mine !== round) return;
      if ("error" in r) next.push(failedRow(item, r.error, prev, nowSec()));
      else {
        const row = watchRow(item, depositView(r), prev, nowSec());
        next.push(row);
        state.seen[item.q] = { title: row.title, tone: row.tone, atSec: row.checkedAtSec };
      }
    } catch (e) {
      if (mine !== round) return;
      next.push(failedRow(item, reason(e), prev, nowSec()));
    }
    rows = [...next, ...rows.slice(next.length)];
    render();
    if (i < items.length - 1) await sleep(GAP_MS);
  }
  if (mine !== round) return;
  rows = next;
  save(state);
  render();
  const changed = changedCount();
  document.title = changed ? `(${changed} changed) Watch deposits · Zcash Refund Helper` : "Watch deposits · Zcash Refund Helper";
  status.textContent = `${changed ? `${changed} changed since the last check. ` : "Nothing changed since the last check. "}Checked at ${when(nowSec())}; the next round starts in 10 minutes while this page stays open.`;
  if (changed && "Notification" in window && Notification.permission === "granted") {
    new Notification("Zcash Refund Helper", { body: `${changed} watched deposit${changed === 1 ? "" : "s"} changed state.`, icon: "icons/favicon-32.png" });
  }
  timer = setTimeout(() => void checkAll(), ROUND_MS);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const { items, rejected, overflow } = parseWatchList(box.value);
  const kept = new Set(items.map((i) => i.q));
  state = { items, seen: Object.fromEntries(Object.entries(state.seen).filter(([q]) => kept.has(q))) };
  save(state);
  box.value = watchListText(items);
  const notes = [rejected.length ? `${rejected.length} line${rejected.length === 1 ? " is" : "s are"} not a transaction hash and ${rejected.length === 1 ? "was" : "were"} left out.` : "", overflow ? `Only the first ${items.length} are watched; ${overflow} more were left out.` : ""].filter(Boolean);
  rows = [];
  void checkAll().then(() => {
    if (notes.length) status.textContent = `${notes.join(" ")} ${status.textContent ?? ""}`;
  });
});

copyBtn.addEventListener("click", () => {
  void navigator.clipboard.writeText(summaryText(rows, nowSec())).then(() => {
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy a summary for a ticket"), 1500);
  });
});

notifyBtn.addEventListener("click", () => {
  if (!("Notification" in window)) return void (notifyBtn.textContent = "This browser can't show notifications");
  void Notification.requestPermission().then((p) => {
    notifyBtn.textContent = p === "granted" ? "You'll get a notification when one changes" : "Notifications are off in this browser";
    notifyBtn.disabled = p === "granted";
  });
});

clearBtn.addEventListener("click", () => {
  clearTimeout(timer);
  round++;
  state = { items: [], seen: {} };
  save(state);
  rows = [];
  box.value = "";
  render();
  copyBtn.disabled = true;
  status.textContent = "The watch list is cleared from this browser.";
});

copyBtn.disabled = true;
if (state.items.length) {
  box.value = watchListText(state.items);
  void checkAll();
}
