// The web page: the same deposit check and refund board as the CLI, run in the browser against public sources only.
// Everything shown is built with textContent, never parsed as HTML.
import { checkBtcDeposit, checkRefundBoard, publicUtxoRefundClients } from "../src/btc-refund.js";
import { boardNotes, boardView, depositView, journeyView, parseQuery, type DepositView, type JourneyStop } from "../src/web/view.js";

function byId<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} is missing`);
  return e as T;
}

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("q");
const out = byId<HTMLElement>("out");
const boardBtn = byId<HTMLButtonElement>("board-btn");
const board = byId<HTMLElement>("board");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string; href?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.href && e instanceof HTMLAnchorElement) {
    e.href = props.href;
    if (props.href.startsWith("https:")) {
      e.target = "_blank";
      e.rel = "noopener noreferrer";
    }
  }
  e.append(...children);
  return e;
}

const BUSY = "NEAR's public servers are busy right now, so the bridge contract could not be read. This says nothing about the deposit itself. Try again in a minute.";
const busy = (e: unknown): boolean => e instanceof Error && e.name === "NearRpcUnavailable";
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const nowSec = (): number => Math.floor(Date.now() / 1000);

const ICON: Record<JourneyStop["state"], string> = { done: "✓", next: "→", waiting: "…", stopped: "!", not_reached: "" };

/** The deposit's way, top to bottom: each stop with its state, the rail between them. Text only, no HTML parsing. */
function renderJourney(stops: JourneyStop[]): HTMLElement {
  const list = el("ol", { className: "journey" });
  list.setAttribute("aria-label", stops.map((s) => `${s.title}: ${s.note}`).join(". "));
  stops.forEach((s, i) => {
    const logo = document.createElement("img");
    logo.className = "jlogo";
    logo.src = `logos/${s.logo === "zcash" ? "zec" : s.logo}.svg`;
    logo.alt = "";
    logo.width = 22;
    logo.height = 22;
    const node = el("span", { className: "jnode" }, logo, el("span", { className: "jbadge", text: ICON[s.state] }));
    const li = el("li", { className: `jstop ${s.state}` }, node, el("span", { className: "jtext" }, el("b", { text: s.title }), el("span", { text: s.note })));
    li.querySelector(".jnode")?.setAttribute("aria-hidden", "true");
    if (i < stops.length - 1) li.append(el("span", { className: "jrail" }));
    list.append(li);
  });
  return list;
}

/** Plays the journey in: the rail draws down stop by stop until the first one nobody has reached; a stop that did not happen pulses. */
function playJourney(list: HTMLElement): void {
  if (typeof list.animate !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stops = [...list.querySelectorAll<HTMLElement>(".jstop")];
  let t = 0;
  for (const [i, stop] of stops.entries()) {
    const node = stop.querySelector<HTMLElement>(".jnode");
    const text = stop.querySelector<HTMLElement>(".jtext");
    node?.animate([{ opacity: 0.15, transform: "scale(0.6)" }, { opacity: 1, transform: "scale(1.15)", offset: 0.6 }, { opacity: 1, transform: "scale(1)" }], { duration: 380, delay: t, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" });
    text?.animate([{ opacity: 0.15, transform: "translateX(-6px)" }, { opacity: 1, transform: "none" }], { duration: 340, delay: t + 60, easing: "ease-out", fill: "backwards" });
    if (node && stop.classList.contains("stopped")) node.animate([{ boxShadow: "0 0 0 0 rgba(255,181,71,0.6)" }, { boxShadow: "0 0 0 14px rgba(255,181,71,0)" }], { duration: 700, delay: t + 360, iterations: 3, easing: "ease-out" });
    if (node && stop.classList.contains("next")) node.animate([{ boxShadow: "0 0 0 0 rgba(221,242,74,0.6)" }, { boxShadow: "0 0 0 14px rgba(221,242,74,0)" }], { duration: 900, delay: t + 360, iterations: 3, easing: "ease-out" });
    const rail = stop.querySelector<HTMLElement>(".jrail");
    const reached = stops[i + 1] && !stops[i + 1]?.classList.contains("not_reached");
    if (rail && reached) rail.animate([{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }], { duration: 300, delay: t + 200, easing: "ease-in-out", fill: "backwards" });
    t += reached ? 420 : 160;
  }
}

function renderDeposit(v: DepositView, journey: JourneyStop[] | null): HTMLElement {
  const card = el("article", { className: `card ${v.tone}` }, el("p", { className: "kicker", text: `${v.chain} deposit` }), el("h2", { text: v.title }));
  if (journey) card.append(renderJourney(journey));
  const dl = el("dl");
  for (const f of v.facts) dl.append(el("dt", { text: f.label }), el("dd", {}, f.href ? el("a", { href: f.href, text: f.value }) : f.value));
  card.append(dl, el("div", { className: "headline" }, ...v.headline.map((line) => el("p", { text: line }))));
  if (v.stepsIntro) {
    const steps = el("ol", { className: "steps" });
    for (const s of v.steps) {
      const li = el("li", {}, el("p", { className: "step-title", text: s.title }));
      const command = s.command;
      if (command) {
        const copy = el("button", { className: "copy", text: "Copy" });
        copy.type = "button";
        copy.addEventListener("click", () => {
          void navigator.clipboard.writeText(command).then(() => {
            copy.textContent = "Copied";
            setTimeout(() => (copy.textContent = "Copy"), 1500);
          });
        });
        li.append(el("div", { className: "cmd" }, el("pre", { text: command }), copy));
      }
      if (s.note) li.append(el("p", { className: "muted", text: s.note }));
      steps.append(li);
    }
    card.append(el("h3", { text: "What is left" }), el("p", { className: "muted", text: v.stepsIntro }), steps);
    if (v.timeoutNote) card.append(el("p", { className: "muted", text: v.timeoutNote }));
  }
  if (v.privacy.length) card.append(el("h3", { text: "What others can see" }), el("ul", { className: "privacy" }, ...v.privacy.map((line) => el("li", { text: line }))));
  card.append(el("p", { className: "sources", text: v.sources }));
  return card;
}

let latest = 0;
async function check(raw: string): Promise<void> {
  const q = parseQuery(raw);
  if (!q) {
    out.replaceChildren(el("p", { className: "err", text: "Paste a Zcash or Bitcoin transaction hash: 64 hexadecimal characters, optionally followed by :output." }));
    return;
  }
  input.value = raw.trim();
  const mine = ++latest;
  out.replaceChildren(el("p", { className: "muted", text: "Checking: reading the chain, the Omni bridge indexer and the connector contract on NEAR…" }));
  try {
    const r = await checkBtcDeposit(q.txid, publicUtxoRefundClients(), nowSec(), q.vout);
    if (mine !== latest) return;
    if ("error" in r) return void out.replaceChildren(el("p", { className: "err", text: r.error }));
    out.replaceChildren(renderDeposit(depositView(r), journeyView(r)));
    const journey = out.querySelector<HTMLElement>(".journey");
    if (journey) playJourney(journey);
  } catch (e) {
    if (mine !== latest) return;
    out.replaceChildren(el("p", { className: "err", text: busy(e) ? BUSY : `The check failed: ${reason(e)}` }));
  }
}

async function showBoard(): Promise<void> {
  boardBtn.disabled = true;
  board.replaceChildren(el("p", { className: "muted", text: "Reading every refund request on both connectors…" }));
  try {
    const open = await checkRefundBoard(publicUtxoRefundClients(), nowSec());
    const rows = boardView(open);
    if (!rows.length) {
      board.replaceChildren(el("p", { text: "No refund requests are open on the Omni Bitcoin and Zcash bridges." }));
      return;
    }
    const body = el("tbody", {}, ...rows.map((r) => el("tr", {}, el("td", { className: r.tone, text: r.state }), el("td", { text: r.amount }), el("td", { className: "mono", text: r.refundTo }), el("td", {}, el("a", { href: r.href, text: r.deposit })))));
    const head = el("thead", {}, el("tr", {}, ...["State", "Amount", "Refund goes to", "Deposit"].map((h) => el("th", { text: h }))));
    board.replaceChildren(el("table", {}, head, body), ...boardNotes(open).map((text) => el("p", { className: "muted", text })));
  } catch (e) {
    board.replaceChildren(el("p", { className: "err", text: busy(e) ? BUSY : `Could not read the board: ${reason(e)}` }));
  } finally {
    boardBtn.disabled = false;
  }
}

const fromHash = (): string | null => {
  const m = /^#q=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1] ?? "") : null;
};

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = parseQuery(input.value);
  if (!q) return void check(input.value);
  const next = `#q=${q.txid}${q.vout === undefined ? "" : `:${q.vout}`}`;
  if (location.hash === next) void check(input.value);
  else location.hash = next;
});
window.addEventListener("hashchange", () => {
  const q = fromHash();
  if (q) void check(q);
});
boardBtn.addEventListener("click", () => void showBoard());

// The real result beside "How a check works": the 0.1 BTC deposit refunded on 15 October, played when it comes into view.
const EXAMPLE: JourneyStop[] = [
  { title: "Deposit on Bitcoin", note: "Confirmed 2026-08-19 17:19 UTC", state: "done", logo: "btc" },
  { title: "Credit on NEAR", note: "Never credited: the refund path is the way out", state: "stopped", logo: "near" },
  { title: "Refund requested", note: "The request is on chain", state: "done", logo: "near" },
  { title: "Lock", note: "Passed", state: "done", logo: "near" },
  { title: "Execute", note: "Executed 15 October", state: "done", logo: "near" },
  { title: "Back to the sender", note: "Returned to bc1qyp0a54gj…", state: "done", logo: "btc" },
];
const exampleBox = document.getElementById("example-journey");
if (exampleBox) {
  const list = renderJourney(EXAMPLE);
  exampleBox.replaceChildren(list);
  new IntersectionObserver((entries, observer) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    observer.disconnect();
    playJourney(list);
  }, { threshold: 0.5 }).observe(list);
}
const initial = fromHash();
if (initial) void check(initial);
