// The watch page's model: parsing a watch list, a row per deposit, what changed, and the ticket summary.
import { describe, expect, it } from "vitest";

import type { DepositView } from "./view.js";
import { failedRow, parseWatchList, summaryText, WATCH_MAX, watchListText, watchRow } from "./watch.js";

const A = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
const B = "51623f37" + "ab".repeat(28);
const NOW = 1_791_900_000;

const view = (title: string, headline: string[]): DepositView => ({
  chain: "Bitcoin",
  title,
  tone: "warn",
  facts: [{ label: "Amount", value: "0.09997900 BTC", href: null }],
  headline,
  stepsIntro: null,
  steps: [],
  timeoutNote: null,
  sources: "",
  privacy: [],
});
const READY = view("Ready to refund", ["READY TO REFUND  the refund was requested on 2026-08-19 and its lock ended on 2026-09-02; nobody has executed it yet."]);

describe("parseWatchList", () => {
  it("reads one deposit per line, with an optional output and a note, and drops repeats", () => {
    const r = parseWatchList(`${A} ticket #4512\n\n${B.toUpperCase()}:1\n${A} again\nnot a hash`);
    expect(r.items).toEqual([{ q: A, note: "ticket #4512" }, { q: `${B}:1`, note: "" }]);
    expect(r.rejected).toEqual(["not a hash"]);
    expect(r.overflow).toBe(0);
  });

  it(`keeps at most ${WATCH_MAX} deposits and counts the rest`, () => {
    const many = Array.from({ length: WATCH_MAX + 3 }, (_, i) => i.toString(16).padStart(64, "0")).join("\n");
    const r = parseWatchList(many);
    expect(r.items).toHaveLength(WATCH_MAX);
    expect(r.overflow).toBe(3);
  });

  it("writes the list back as the same text", () => {
    const items = parseWatchList(`${A} ticket #4512\n${B}`).items;
    expect(parseWatchList(watchListText(items)).items).toEqual(items);
  });
});

describe("watchRow", () => {
  it("carries the check's title, the amount and the reason without the state in capitals", () => {
    const row = watchRow({ q: A, note: "ticket #4512" }, READY, undefined, NOW);
    expect(row).toMatchObject({ title: "Ready to refund", amount: "0.09997900 BTC", chain: "Bitcoin", was: null });
    expect(row.why).toBe("the refund was requested on 2026-08-19 and its lock ended on 2026-09-02; nobody has executed it yet.");
  });

  it("says what it was when the state changed since the last check, and nothing when it did not", () => {
    const before = { title: "Refund requested", tone: "info" as const, atSec: NOW - 3600 };
    expect(watchRow({ q: A, note: "" }, READY, before, NOW).was).toEqual(before);
    expect(watchRow({ q: A, note: "" }, READY, { ...before, title: "Ready to refund" }, NOW).was).toBeNull();
  });

  it("a failed check keeps the last known state and says it will try again", () => {
    const row = failedRow({ q: A, note: "" }, "NEAR's public servers are busy.", { title: "Refund requested", tone: "info", atSec: NOW - 60 }, NOW);
    expect(row.title).toBe("Refund requested (last check)");
    expect(row.why).toMatch(/try again on the next round/);
  });
});

describe("summaryText", () => {
  it("lists each deposit with its note, amount, state, reason and change, for a ticket", () => {
    const before = { title: "Refund requested", tone: "info" as const, atSec: 1_791_800_000 };
    const text = summaryText([watchRow({ q: A, note: "ticket #4512" }, READY, before, NOW)], NOW);
    expect(text).toContain(`- ${A} (ticket #4512 · 0.09997900 BTC on Bitcoin)`);
    expect(text).toContain("  Ready to refund: the refund was requested on 2026-08-19");
    expect(text).toContain('Changed since 2026-10-12 10:13 UTC: it was "Refund requested".');
    expect(text).toMatch(/Nobody needs your keys or seed phrase/);
    expect(text).not.toMatch(/https?:\/\//);
  });
});
