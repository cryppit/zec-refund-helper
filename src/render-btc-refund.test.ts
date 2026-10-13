// The plain-text report for a Bitcoin deposit check: what happened, in one headline, and what is left to do.
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, refundSteps, type BtcDepositFacts, type RefundConfig } from "./core/btc-refund.js";
import { renderBtcRefundText, renderRefundBoardText } from "./render-btc-refund.js";

const CONFIG: RefundConfig = { refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600, minDepositSat: 2_500, maxGasFeeSat: 5_000, refundFeeSat: 5_000, requestDepositYocto: 2n * 10n ** 24n, executeDepositYocto: 10n ** 24n };
const ORDER = "f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807";
const SENDER = "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t";
const FACTS: BtcDepositFacts = {
  chain: "btc",
  txid: "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39",
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
const report = (facts: BtcDepositFacts, nowSec: number) => {
  const verdict = btcDepositVerdict(facts, CONFIG, nowSec);
  return renderBtcRefundText({ facts, verdict, steps: refundSteps(facts, verdict, CONFIG), config: CONFIG, orderAccount: ORDER });
};

describe("renderBtcRefundText", () => {
  it("a refund past its lock that nobody executed: the headline, where it can go, and the steps left", () => {
    const text = report(FACTS, 1_791_900_000);
    expect(text).toContain("0.09997900 BTC from bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t");
    expect(text).toContain(`For NEAR account  ${ORDER}`);
    expect(text).toContain("READY TO REFUND  the refund was requested on 2026-08-19 and its lock ended on 2026-09-02; nobody has executed it yet");
    expect(text).toContain(`The bridge can only send it to ${SENDER}.`);
    expect(text).toContain("1. Execute the refund (1 NEAR)");
    expect(text).toContain("2. Have the bridge sign the Bitcoin refund");
    expect(text).toContain("If the near CLI shows an error or a timeout, look the transaction up on nearblocks.io before sending it again: it may have gone through.");
    expect(text).toContain("We never hold keys");
  });

  it("a deposit the bridge absorbed below the minimum: no credit and no refund path, said plainly", () => {
    const text = report({ ...FACTS, amountSat: 1_000, request: null, absorbed: true }, 1_791_900_000);
    expect(text).toContain("ABSORBED  the bridge verified this deposit but it is below the 2500-satoshi minimum, so nothing was minted on NEAR");
    expect(text).toContain("no refund path");
    expect(text).not.toContain("1. ");
  });

  it("a stuck deposit nobody has asked about yet", () => {
    const text = report({ ...FACTS, request: null }, 1_791_900_000);
    expect(text).toContain("STUCK  confirmed 2026-08-19 and never credited on NEAR");
    expect(text).toContain("1. Request the refund (2 NEAR, not returned)");
    expect(text).toContain(`--refund-address ${SENDER}`);
  });

  it("a deposit too small to refund says so instead of giving steps", () => {
    const text = report({ ...FACTS, request: null, amountSat: 2_000 }, 1_791_900_000);
    expect(text).toContain("below the bridge's 2500-satoshi minimum");
    expect(text).toContain("It is not larger than the refund fee (5000 satoshis)");
    expect(text).not.toContain("1. ");
  });

  it("a Zcash deposit is shown in ZEC", () => {
    const text = report({ ...FACTS, chain: "zcash", request: null, bridgeHolds: true, amountSat: 41_000_000 }, 1_791_900_000);
    expect(text).toContain("Zcash deposit     9deffb31");
    expect(text).toContain("0.41000000 ZEC from");
    expect(text).toContain("zcash-connector.bridge.near");
  });

  it("credited and not-a-deposit headlines", () => {
    expect(report({ ...FACTS, request: null, bridgeHolds: true }, 1_791_900_000)).toContain(`CREDITED  the bridge took this deposit in; follow its order account ${ORDER} in Where's My Swap`);
    expect(report({ ...FACTS, request: null, msg: null }, 1_791_900_000)).toContain("NOT AN OMNI BTC DEPOSIT");
  });
});

describe("renderBtcRefundText for Zcash", () => {
  const ZCONFIG: RefundConfig = { ...CONFIG, minDepositSat: 100_000, maxGasFeeSat: 1_000_000, refundFeeSat: 10_000 };
  const UA =
    "u1egfcnx27m4406w892hrp96n8akl66juj8pn0agqa2w2zrylpmq5yurssz0tlq3k4rmhag7y6kljezxp6me4j3h03ezs0tzrqynz2tdcnwenqqepl85f6qcxekcjv60wheqyyt5lk560t0m3tx7y2zqzwr56wr9fg76dumq08jspxmncv";
  const ZFACTS: BtcDepositFacts = {
    ...FACTS,
    chain: "zcash",
    txid: "04dc643f8a1d19baf476178d01eac8fc553700e36f849df91e46924fa3f2cae6",
    amountSat: 5_000_000_000,
    depositAddress: "t1RTEogVdgA8cWY8zm1uomj5ThPZnbp8BB4",
    senders: [],
    msg: { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` }, refund_address: UA },
    request: null,
    funding: { kind: "shielded", pools: ["Ironwood"] },
  };
  const zreport = (facts: BtcDepositFacts, nowSec = 1_791_900_000) => {
    const verdict = btcDepositVerdict(facts, ZCONFIG, nowSec);
    return renderBtcRefundText({ facts, verdict, steps: refundSteps(facts, verdict, ZCONFIG), config: ZCONFIG, orderAccount: ORDER });
  };

  it("a deposit funded from a shielded pool: no transparent sender, and the deposit's own unified refund address gets a shielded refund", () => {
    const text = zreport(ZFACTS);
    expect(text).toContain("50.00000000 ZEC from the Ironwood shielded pool (no transparent sender) to t1RTEogVdgA8cWY8zm1uomj5ThPZnbp8BB4");
    expect(text).toContain(`The deposit names its refund address: ${UA}, a unified address (Orchard + Sapling receivers).`);
    expect(text).toContain("no transparent receiver");
    expect(text).toContain("bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash 04dc643f");
    expect(text).not.toContain("Several wallets");
  });

  it("synthetic, a shielded-funded deposit without a refund address: explains there is no sender and how to name your own address", () => {
    const text = zreport({ ...ZFACTS, msg: { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` } } });
    expect(text).not.toContain("Several wallets");
    expect(text).toContain("came from the Ironwood shielded pool, so it has no transparent sender");
    expect(text).toContain("--refund-address <your own unified address (u1…) with an Orchard receiver>");
    expect(text).toContain("14 days");
    expect(text).toContain("the coin can only go to the address named in the request.");
  });

  it("a transparent t-address refund: execute with --transparent", () => {
    const text = zreport({ ...ZFACTS, senders: ["t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1"], funding: { kind: "transparent", pools: [] }, msg: { recipient_id: "intents.near", refund_address: "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1" } });
    expect(text).toContain("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1, a transparent t-address.");
    expect(text).toContain("--vout 0 --transparent");
  });

  it("a 0.0005 ZEC deposit is below the minimum but refundable: the fee is 10,000 zatoshis, not the 0.01 ZEC cap", () => {
    const text = zreport({ ...ZFACTS, amountSat: 50_000 });
    expect(text).toContain("below the bridge's 100000-zatoshi minimum deposit");
    expect(text).toContain("A refund returns 0.00040000 ZEC: the deposit minus the 10000-zatoshi refund fee (the ZIP-317 minimum the Zcash connector charges).");
    expect(text).not.toContain("would return nothing");
    expect(text).toContain("1. Request the refund");
  });

  it("a deposit no larger than the fee cannot be refunded", () => {
    const text = zreport({ ...ZFACTS, amountSat: 10_000 });
    expect(text).toContain("It is not larger than the refund fee (10000 zatoshis), so the contract would refuse a refund request.");
    expect(text).not.toContain("1. ");
  });

  it("a Sapling-only refund address (synthetic): says the connector cannot pay it, and gives no commands", () => {
    const sapling = "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn";
    const text = zreport({ ...ZFACTS, msg: { recipient_id: "intents.near", refund_address: sapling } });
    expect(text).toContain("cannot pay a Sapling z-address");
    expect(text).not.toContain("1. ");
  });

  it("a ready request: what it returns after the fee stored on the request", () => {
    const request = { refundAddress: UA, amountSat: 5_000_000_000, createdAtSec: 1_791_000_000, executed: false, msgHasRefundAddress: true, gasFeeSat: 10_000 };
    const text = zreport({ ...ZFACTS, request });
    expect(text).toContain("READY TO REFUND");
    expect(text).toContain("A refund returns 49.99990000 ZEC: the deposit minus the 10000-zatoshi fee stored on the request.");
    expect(text).toContain("1. Execute the refund, shielded (1 NEAR)");
  });
});

describe("renderRefundBoardText", () => {
  it("one line per request, ready ones saying how long nobody has executed them", () => {
    const text = renderRefundBoardText(
      [{ chain: "btc", txid: FACTS.txid, vout: 0, amountSat: 9_997_900, refundTo: SENDER, requestedAtSec: 1_787_161_227, unlocksAtSec: 1_788_370_827, state: "ready", readyForSec: 41 * 86_400 }],
      1_791_900_000,
    );
    expect(text).toContain("1 refund request on the Omni Bitcoin and Zcash bridges");
    expect(text).toContain(`READY 41 days  0.09997900 BTC  -> ${SENDER}  ${FACTS.txid}@0`);
    expect(renderRefundBoardText([], 1_791_900_000)).toContain("No refund requests are open");
  });
});
