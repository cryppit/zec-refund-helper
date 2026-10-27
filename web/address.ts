// The address page: a Zcash address checked before sending, read from the address itself (offline, nothing is sent).
import { asZcashAddress } from "../src/render-address.js";
import { addressView, type AddressView } from "../src/web/view.js";
import { byId, coin, el } from "./ui.js";

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("q");
const out = byId<HTMLElement>("out");

/** The plain next step, each kind of wallet with a tick or a cross, the refund the bridge could make to it. */
function renderAddress(v: AddressView): HTMLElement {
  const head = el("div", { className: "addr-head" }, coin("zec"), el("p", { className: "kicker", text: "Zcash address · before you send" }));
  const card = el("article", { className: `card ${v.tone}` }, head, el("h2", { text: v.title }));
  const wallets = el("ul", { className: "wallets" });
  for (const w of v.wallets) wallets.append(el("li", { className: w.can === "no" ? "no" : "yes" }, coin("zec", w.can === "no" ? "✕" : "✓"), el("div", {}, el("b", { text: w.label }), el("p", { text: w.why }))));
  card.append(wallets);
  if (v.refund) card.append(el("div", { className: `refund-row${v.refund.includes("don't use it") ? " no" : ""}` }, coin("near"), el("p", { text: v.refund })));
  const dl = el("dl", {}, el("dt", { text: "Address" }), el("dd", { className: "mono", text: v.address }), el("dt", { text: "Kind" }), el("dd", { text: v.what }));
  card.append(dl, el("p", { className: "sources", text: v.note }));
  return card;
}

function check(raw: string): void {
  input.value = raw.trim();
  const address = asZcashAddress(raw);
  out.replaceChildren(address ? renderAddress(addressView(address)) : el("p", { className: "err", text: "That is not a Zcash address. Zcash addresses start with t1, t3, tex1, u1 or zs1 (on testnet: tm, textest1, utest1 or ztestsapling1)." }));
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

const fromHash = (): string | null => {
  const m = /^#a=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1] ?? "") : null;
};

form.addEventListener("submit", (e) => {
  e.preventDefault();
  // A transaction hash pasted here belongs to the deposit check.
  if (/^\s*[0-9a-fA-F]{64}(:\d+)?\s*$/.test(input.value)) return void location.assign(`./#q=${input.value.trim()}`);
  const a = asZcashAddress(input.value);
  if (!a) return check(input.value);
  const next = `#a=${encodeURIComponent(a.address)}`;
  if (location.hash === next) check(a.address);
  else location.hash = next;
});
window.addEventListener("hashchange", () => {
  const a = fromHash();
  if (a) check(a);
});
const initial = fromHash();
if (initial) check(initial);
