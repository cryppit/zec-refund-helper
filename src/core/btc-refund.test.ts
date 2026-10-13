// A Bitcoin deposit into NEAR Intents through the Omni BTC bridge (btc-connector.bridge.near): was it credited, is it
// stuck, and if stuck, how its sender gets it back through the bridge's own refund (request, timelock, execute).
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, isCredited, receiverOf, refundBoard, refundSteps, type BtcDepositFacts, type RefundConfig, type RefundRequestRow } from "./btc-refund.js";

const NEAR = 10n ** 24n;
/** The live mainnet config read on 2026-10-13. */
const CONFIG: RefundConfig = {
  refundTimelockSec: 172_800,
  unsafeRefundTimelockSec: 1_209_600,
  minDepositSat: 2_500,
  maxGasFeeSat: 5_000,
  requestDepositYocto: 2n * NEAR,
  executeDepositYocto: 1n * NEAR,
};

const ORDER = "f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807";
const SENDER = "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t";
const TXID = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
const CONFIRMED = 1_787_159_956; // 2026-08-19 17:19:16 UTC

const facts = (over: Partial<BtcDepositFacts> = {}): BtcDepositFacts => ({
  chain: "btc",
  txid: TXID,
  vout: 0,
  amountSat: 9_997_900,
  depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
  confirmedAtSec: CONFIRMED,
  senders: [SENDER],
  msg: { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` } },
  bridgeHolds: false,
  spentBy: null,
  request: null,
  ...over,
});
const withRefundAddress = { recipient_id: "intents.near", safe_deposit: { msg: `{"receiver_id":"${ORDER}"}` }, refund_address: SENDER };
const HOUR = 3_600;
const DAY = 86_400;

describe("receiverOf", () => {
  it("is the order account inside a 1Click deposit message, or the plain NEAR recipient", () => {
    expect(receiverOf(facts().msg!)).toBe(ORDER);
    expect(receiverOf({ recipient_id: "alice.near" })).toBe("alice.near");
    expect(receiverOf({ recipient_id: "intents.near", safe_deposit: { msg: "not json" } })).toBe("intents.near");
  });
});

describe("btcDepositVerdict", () => {
  it("waits for a Bitcoin confirmation first", () => {
    expect(btcDepositVerdict(facts({ confirmedAtSec: null }), CONFIG, CONFIRMED)).toEqual({ state: "unconfirmed" });
  });

  it("says when no output is a bridge deposit address", () => {
    expect(btcDepositVerdict(facts({ msg: null }), CONFIG, CONFIRMED + DAY)).toEqual({ state: "not_a_deposit" });
  });

  it("is credited while the bridge holds the coin, and hands over the order account", () => {
    expect(btcDepositVerdict(facts({ bridgeHolds: true }), CONFIG, CONFIRMED + DAY)).toEqual({ state: "credited", orderAccount: ORDER });
  });

  it("is credited when the bridge has since spent the coin in its own transaction", () => {
    const spentBy = { txid: "ab".repeat(32), inputs: 7, paysTo: ["bc1qbridgechange", "bc1qsomeuser"] };
    expect(btcDepositVerdict(facts({ spentBy }), CONFIG, CONFIRMED + DAY)).toEqual({ state: "credited", orderAccount: ORDER });
  });

  it("is refunded when the coin was spent alone, straight back to the refund address", () => {
    const spentBy = { txid: "cd".repeat(32), inputs: 1, paysTo: [SENDER] };
    expect(btcDepositVerdict(facts({ msg: withRefundAddress, spentBy }), CONFIG, CONFIRMED + 20 * DAY)).toEqual({ state: "refunded", refundTo: SENDER, refundTx: "cd".repeat(32) });
  });

  it("is still crediting inside the first 6 hours after confirmation", () => {
    expect(btcDepositVerdict(facts(), CONFIG, CONFIRMED + 2 * HOUR)).toEqual({ state: "crediting", stuckAfterSec: CONFIRMED + 6 * HOUR });
  });

  it("is refundable after 6 hours: to the deposit's own refund address with the 2-day lock", () => {
    expect(btcDepositVerdict(facts({ msg: withRefundAddress }), CONFIG, CONFIRMED + 7 * HOUR)).toEqual({
      state: "refundable",
      refundTo: SENDER,
      refundToFromDeposit: true,
      lockSec: 172_800,
      belowMinimum: false,
      tooSmall: false,
    });
  });

  it("without a refund address in the deposit, suggests only the single sending wallet, with the 14-day lock", () => {
    expect(btcDepositVerdict(facts(), CONFIG, CONFIRMED + 7 * HOUR)).toMatchObject({ state: "refundable", refundTo: SENDER, refundToFromDeposit: false, lockSec: 1_209_600 });
    expect(btcDepositVerdict(facts({ senders: [SENDER, "bc1qother"] }), CONFIG, CONFIRMED + 7 * HOUR)).toMatchObject({ state: "refundable", refundTo: null });
  });

  it("flags a deposit under the bridge minimum, and one too small to cover the refund's Bitcoin fee", () => {
    expect(btcDepositVerdict(facts({ amountSat: 2_000 }), CONFIG, CONFIRMED + DAY)).toMatchObject({ belowMinimum: true, tooSmall: true });
    expect(btcDepositVerdict(facts({ amountSat: 4_000 }), CONFIG, CONFIRMED + DAY)).toMatchObject({ belowMinimum: false, tooSmall: true });
  });

  it("follows a refund request through its timelock to ready, executed and refunded", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false };
    const unlocks = 1_787_161_227 + 1_209_600;
    expect(btcDepositVerdict(facts({ request }), CONFIG, unlocks - DAY)).toEqual({ state: "requested", refundTo: SENDER, unlocksAtSec: unlocks });
    expect(btcDepositVerdict(facts({ request }), CONFIG, unlocks + 40 * DAY)).toEqual({ state: "ready", refundTo: SENDER, unlockedAtSec: unlocks });
    expect(btcDepositVerdict(facts({ request: { ...request, executed: true } }), CONFIG, unlocks + DAY)).toEqual({ state: "executed", refundTo: SENDER });
    const spentBy = { txid: "ef".repeat(32), inputs: 1, paysTo: [SENDER] };
    expect(btcDepositVerdict(facts({ request: { ...request, executed: true }, spentBy }), CONFIG, unlocks + DAY)).toEqual({ state: "refunded", refundTo: SENDER, refundTx: "ef".repeat(32) });
  });

  it("uses the 2-day lock for a request whose deposit named its refund address", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: true };
    expect(btcDepositVerdict(facts({ msg: withRefundAddress, request }), CONFIG, 1_787_161_227)).toEqual({ state: "requested", refundTo: SENDER, unlocksAtSec: 1_787_161_227 + 172_800 });
  });
});

describe("isCredited", () => {
  it("credited while the bridge holds the coin or once it spent it itself; not when the coin went back as a refund", () => {
    expect(isCredited(facts({ bridgeHolds: true }))).toBe(true);
    expect(isCredited(facts({ spentBy: { txid: "ab", inputs: 7, paysTo: ["bc1qx"] } }))).toBe(true);
    expect(isCredited(facts({ msg: withRefundAddress, spentBy: { txid: "cd", inputs: 1, paysTo: [SENDER] } }))).toBe(false);
    expect(isCredited(facts())).toBe(false);
    expect(isCredited(facts({ msg: null, bridgeHolds: true }))).toBe(false);
  });
});

describe("refundSteps", () => {
  it("for a stuck deposit: request with bridge-cli (2 NEAR), wait the lock, execute (1 NEAR), sign", () => {
    const f = facts({ msg: withRefundAddress });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps.map((s) => s.title)).toEqual([
      "Request the refund (2 NEAR, not returned)",
      "Wait 2 days for the timelock",
      "Execute the refund (1 NEAR)",
      "Have the bridge sign the Bitcoin refund",
    ]);
    expect(steps[0]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain btc --btc-tx-hash ${TXID} --vout 0`);
    expect(steps[2]?.command).toContain(`json-args '{"utxo_storage_key":"${TXID}@0"}'`);
    expect(steps[2]?.command).toContain("attached-deposit '1 NEAR'");
    expect(steps[3]?.command).toBe("bridge-cli mainnet near-sign-btc-transaction --chain btc --btc-pending-id <btc_pending_id from the execute_refund logs>");
  });

  it("names the sending wallet as the refund address only when the deposit has none", () => {
    const f = facts();
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps[0]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain btc --btc-tx-hash ${TXID} --vout 0 --refund-address ${SENDER}`);
    expect(steps[1]?.title).toBe("Wait 14 days for the timelock");
  });

  it("gives no commands when the refund address cannot be told from the transaction, or the refund would return nothing", () => {
    const multi = facts({ senders: [SENDER, "bc1qother"] });
    expect(refundSteps(multi, btcDepositVerdict(multi, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
    const tiny = facts({ amountSat: 4_000 });
    expect(refundSteps(tiny, btcDepositVerdict(tiny, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
  });

  it("once the lock has passed: only execute and sign remain", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false };
    const f = facts({ request });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, 1_790_000_000), CONFIG);
    expect(steps.map((s) => s.title)).toEqual(["Execute the refund (1 NEAR)", "Have the bridge sign the Bitcoin refund"]);
  });

  it("a Zcash deposit gets the Zcash connector and bridge-cli's --chain zcash", () => {
    const f = facts({ chain: "zcash", msg: withRefundAddress, senders: ["t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1"] });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps[0]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain zcash --btc-tx-hash ${TXID} --vout 0`);
    expect(steps[2]?.command).toContain("as-transaction zcash-connector.bridge.near execute_refund");
    expect(steps[3]).toMatchObject({ title: "Have the bridge sign the Zcash refund", command: "bridge-cli mainnet near-sign-btc-transaction --chain zcash --btc-pending-id <btc_pending_id from the execute_refund logs>" });
  });

  it("nothing to do for a credited deposit or one already refunded", () => {
    const f = facts({ bridgeHolds: true });
    expect(refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
  });
});

describe("refundBoard", () => {
  const request = (over: Partial<RefundRequestRow>): RefundRequestRow => ({ refundAddress: SENDER, amountSat: 1_000_000, createdAtSec: 1_000_000, executed: false, msgHasRefundAddress: true, ...over });
  const configs = { btc: CONFIG, zcash: CONFIG };

  it("lists every open refund request: ready ones first (longest wait first), then locked, then executed", () => {
    const rows = refundBoard(
      [
        { chain: "btc", key: `${"a".repeat(64)}@0`, request: request({ createdAtSec: 1_000_000 }) },
        { chain: "zcash", key: `${"b".repeat(64)}@1`, request: request({ createdAtSec: 1_500_000, msgHasRefundAddress: false }) },
        { chain: "btc", key: `${"c".repeat(64)}@0`, request: request({ createdAtSec: 900_000 }) },
        { chain: "btc", key: `${"d".repeat(64)}@0`, request: request({ createdAtSec: 950_000, executed: true }) },
      ],
      configs,
      1_600_000,
    );
    expect(rows.map((r) => [r.txid[0], r.state])).toEqual([
      ["c", "ready"],
      ["a", "ready"],
      ["b", "locked"],
      ["d", "executed"],
    ]);
    expect(rows[0]).toMatchObject({ chain: "btc", vout: 0, unlocksAtSec: 900_000 + 172_800, readyForSec: 1_600_000 - 900_000 - 172_800, refundTo: SENDER });
    expect(rows[2]).toMatchObject({ chain: "zcash", vout: 1, unlocksAtSec: 1_500_000 + 1_209_600, readyForSec: 0 });
  });
});
