// The web page's view of a deposit check and of the refund board: the same words as the CLI, plus links to public
// explorers (never to another product).
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, refundSteps, type BoardRow, type BtcDepositFacts, type RefundConfig } from "../core/btc-refund.js";
import { boardView, depositView, parseQuery } from "./view.js";

const CONFIG: RefundConfig = { refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600, minDepositSat: 2_500, maxGasFeeSat: 5_000, refundFeeSat: 5_000, requestDepositYocto: 2n * 10n ** 24n, executeDepositYocto: 10n ** 24n };
const ORDER = "f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807";
const SENDER = "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t";
const TXID = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
const FACTS: BtcDepositFacts = {
  chain: "btc",
  txid: TXID,
  vout: 0,
  amountSat: 9_997_900,
  depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
  confirmedAtSec: 1_787_159_956,
  senders: [SENDER],
  msg: { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` } },
  bridgeHolds: false,
  spentBy: null,
  request: { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 },
  funding: { kind: "transparent", pools: [] },
};
const NOW = 1_791_900_000;
const reportOf = (facts: BtcDepositFacts, orderAccount: string | null = ORDER) => {
  const verdict = btcDepositVerdict(facts, CONFIG, NOW);
  return { facts, verdict, steps: refundSteps(facts, verdict, CONFIG), config: CONFIG, orderAccount };
};

describe("parseQuery", () => {
  it("takes a transaction hash, with an optional output", () => {
    expect(parseQuery(` ${TXID.toUpperCase()} `)).toEqual({ txid: TXID });
    expect(parseQuery(`${TXID}:1`)).toEqual({ txid: TXID, vout: 1 });
    expect(parseQuery(`${TXID}@2`)).toEqual({ txid: TXID, vout: 2 });
  });

  it("refuses anything else", () => {
    expect(parseQuery("")).toBeNull();
    expect(parseQuery("hello")).toBeNull();
    expect(parseQuery(TXID.slice(1))).toBeNull();
    expect(parseQuery(`0x${TXID}`)).toBeNull();
  });
});

describe("depositView", () => {
  const v = depositView(reportOf(FACTS));

  it("names a ready refund as such, as something to act on", () => {
    expect(v.title).toBe("Ready to refund");
    expect(v.tone).toBe("warn");
    expect(v.chain).toBe("Bitcoin");
  });

  it("lists the facts with links to public explorers only", () => {
    expect(v.facts).toEqual([
      { label: "Deposit", value: `${TXID} (output 0)`, href: `https://mempool.space/tx/${TXID}` },
      { label: "Amount", value: "0.09997900 BTC", href: null },
      { label: "From", value: SENDER, href: null },
      { label: "To the bridge deposit address", value: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62", href: "https://mempool.space/address/bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62" },
      { label: "Confirmed", value: "2026-08-19 17:19 UTC", href: null },
      { label: "For NEAR account", value: ORDER, href: `https://nearblocks.io/address/${ORDER}` },
    ]);
    for (const f of v.facts) if (f.href) expect(f.href).not.toContain("wheres-my-swap");
  });

  it("carries the CLI's own headline, steps and sources", () => {
    expect(v.headline[0]).toBe("READY TO REFUND  the refund was requested on 2026-08-19 and its lock ended on 2026-09-02; nobody has executed it yet.");
    expect(v.stepsIntro).toBe(
      "Sign each step with a NEAR account you control; anyone can pay these fees, and the coin can only go to the address above. That account is linked to this deposit in public, so for privacy use one not tied to your name or main wallet.",
    );
    expect(v.steps.map((s) => s.title)).toEqual(["Let near-cli sign as your NEAR account (once)", "Execute the refund (1 NEAR, not returned)", "Have the bridge sign the Bitcoin refund"]);
    expect(v.timeoutNote).toContain("look the transaction up on nearblocks.io before sending it again");
    expect(v.sources).toContain("We never hold keys or sign anything.");
  });

  it("tells a credited deposit apart, with nothing left to do", () => {
    const credited = depositView(reportOf({ ...FACTS, bridgeHolds: true, request: null }));
    expect(credited.title).toBe("Credited");
    expect(credited.tone).toBe("ok");
    expect(credited.steps).toEqual([]);
    expect(credited.stepsIntro).toBeNull();
  });

  it("stands alone: no headline sends the reader to another product", () => {
    const credited = depositView(reportOf({ ...FACTS, bridgeHolds: true, request: null }));
    expect(credited.headline).toEqual([`CREDITED  the bridge took this deposit in; its NEAR order account is ${ORDER}.`]);
    const notOmni = depositView(reportOf({ ...FACTS, msg: null, request: null }));
    expect(notOmni.title).toBe("Not an Omni bridge deposit");
    expect(notOmni.headline.join(" ")).not.toContain("Where's My Swap");
    expect(notOmni.headline.join(" ")).toContain("A deposit through the PoA bridge is not covered here.");
  });

  it("links a Zcash deposit to a Zcash explorer, and a shielded address to nothing", () => {
    const z = depositView(reportOf({ ...FACTS, chain: "zcash", depositAddress: "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs", senders: [], funding: { kind: "shielded", pools: ["Orchard"] } }, null));
    expect(z.chain).toBe("Zcash");
    expect(z.facts[0]?.href).toBe(`https://blockchair.com/zcash/transaction/${TXID}`);
    expect(z.facts.find((f) => f.label === "To the bridge deposit address")?.href).toBe("https://blockchair.com/zcash/address/t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs");
    expect(z.facts.find((f) => f.label === "From")?.value).toBe("the Orchard shielded pool (no transparent sender)");
    expect(z.facts.some((f) => f.label === "For NEAR account")).toBe(false);
  });
});

describe("boardView", () => {
  it("shows each open refund with its state and a link that checks it on this page", () => {
    const rows: BoardRow[] = [
      { chain: "btc", txid: TXID, vout: 0, amountSat: 9_997_900, refundTo: SENDER, requestedAtSec: 1_787_161_227, unlocksAtSec: 1_788_370_827, state: "ready", readyForSec: 3_542_400 },
      { chain: "zcash", txid: "ab".repeat(32), vout: 1, amountSat: 150_000, refundTo: "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs", requestedAtSec: NOW - 1000, unlocksAtSec: 1_793_000_000, state: "locked", readyForSec: 0 },
    ];
    expect(boardView(rows)).toEqual([
      { state: "Ready for 41 days", tone: "warn", amount: "0.09997900 BTC", refundTo: SENDER, deposit: `${TXID.slice(0, 8)}…@0`, href: `#q=${TXID}:0` },
      { state: "Locked until 2026-10-26", tone: "info", amount: "0.00150000 ZEC", refundTo: "t1VpYecBW4UudbGcy4ufh61eWxQCoFaUrPs", deposit: "abababab…@1", href: `#q=${"ab".repeat(32)}:1` },
    ]);
  });
});
