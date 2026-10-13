// The plain-text report for a Bitcoin deposit check: what happened, in one headline, and what is left to do.
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, refundSteps, type BtcDepositFacts, type RefundConfig } from "./core/btc-refund.js";
import { renderBtcRefundText, renderRefundBoardText } from "./render-btc-refund.js";

const CONFIG: RefundConfig = { refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600, minDepositSat: 2_500, maxGasFeeSat: 5_000, requestDepositYocto: 2n * 10n ** 24n, executeDepositYocto: 10n ** 24n };
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
  request: { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false },
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
    expect(text).toContain("We never hold keys");
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
    expect(text).toContain("smaller than the refund's Bitcoin fee");
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
