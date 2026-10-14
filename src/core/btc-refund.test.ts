// A Bitcoin deposit into NEAR Intents through the Omni BTC bridge (btc-connector.bridge.near): was it credited, is it
// stuck, and if stuck, how its sender gets it back through the bridge's own refund (request, timelock, execute).
import { describe, expect, it } from "vitest";

import {
  BTC_REQUEST_WINDOW_SEC,
  btcDepositVerdict,
  isCredited,
  isNearAccountId,
  receiverOf,
  refundBoard,
  refundFeeFor,
  refundPath,
  refundSteps,
  REQUEST_WINDOW,
  requestWindowSec,
  zip317Fee,
  ZCASH_REFUND_FEE_ZAT,
  type BtcDepositFacts,
  type Funding,
  type RefundConfig,
  type RefundRequestRow,
} from "./btc-refund.js";
import { nearCliCommand, PENDING_ID_PLACEHOLDER, refundCalls, signRefundCall } from "./refund-calls.js";

const NEAR = 10n ** 24n;
/** The live mainnet config read on 2026-10-13. */
const CONFIG: RefundConfig = {
  refundTimelockSec: 172_800,
  unsafeRefundTimelockSec: 1_209_600,
  minDepositSat: 2_500,
  maxGasFeeSat: 5_000,
  refundFeeSat: 5_000,
  requestDepositYocto: 2n * NEAR,
  executeDepositYocto: 1n * NEAR,
};
/** The live zcash-connector.bridge.near config read on 2026-10-13 (v0.9.7-rc.3). */
const ZCONFIG: RefundConfig = { ...CONFIG, minDepositSat: 100_000, maxGasFeeSat: 1_000_000, refundFeeSat: 10_000 };

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
  funding: { kind: "transparent", pools: [] },
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
      feeSat: 5_000,
      noTransparentSender: false,
      batchSender: false,
      requestBySec: CONFIRMED + 52_704 * 600,
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
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 };
    const unlocks = 1_787_161_227 + 1_209_600;
    expect(btcDepositVerdict(facts({ request }), CONFIG, unlocks - DAY)).toEqual({ state: "requested", refundTo: SENDER, unlocksAtSec: unlocks });
    expect(btcDepositVerdict(facts({ request }), CONFIG, unlocks + 40 * DAY)).toEqual({ state: "ready", refundTo: SENDER, unlockedAtSec: unlocks });
    expect(btcDepositVerdict(facts({ request: { ...request, executed: true } }), CONFIG, unlocks + DAY)).toEqual({ state: "executed", refundTo: SENDER });
    const spentBy = { txid: "ef".repeat(32), inputs: 1, paysTo: [SENDER] };
    expect(btcDepositVerdict(facts({ request: { ...request, executed: true }, spentBy }), CONFIG, unlocks + DAY)).toEqual({ state: "refunded", refundTo: SENDER, refundTx: "ef".repeat(32) });
  });

  it("uses the 2-day lock for a request whose deposit named its refund address", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: true, gasFeeSat: 5_000 };
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
  it("for a stuck deposit: let near-cli sign, request with bridge-cli (2 NEAR), wait the lock, execute (1 NEAR) and sign with near-cli", () => {
    const f = facts({ msg: withRefundAddress });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps.map((s) => s.title)).toEqual([
      "Let near-cli sign as your NEAR account (once)",
      "Request the refund (2 NEAR, not returned)",
      "Wait 2 days for the timelock",
      "Execute the refund (1 NEAR, not returned)",
      "Have the bridge sign the Bitcoin refund",
    ]);
    expect(steps[0]?.command).toBe("near account import-account using-web-wallet network-config mainnet");
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain btc --btc-tx-hash ${TXID} --vout 0`);
    expect(steps[3]?.command).toBe(
      `near contract call-function as-transaction btc-connector.bridge.near execute_refund json-args '{"utxo_storage_key":"${TXID}@0","chain_specific_data":null}' prepaid-gas '250.0 Tgas' attached-deposit '1 NEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    );
    expect(steps[4]?.command).toBe(
      `near contract call-function as-transaction btc-connector.bridge.near sign_btc_transaction json-args '{"btc_pending_sign_id":"<btc_pending_id from the execute_refund logs>","sign_index":0,"key_version":0}' prepaid-gas '250.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    );
    expect(steps[4]?.note).toContain("Or with bridge-cli: bridge-cli mainnet near-sign-btc-transaction --chain btc --btc-pending-id <btc_pending_id from the execute_refund logs>");
  });

  it("prints the near-cli commands from the same calls a wallet would sign, so the two cannot drift", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: CONFIRMED, executed: false, msgHasRefundAddress: true, gasFeeSat: 5_000 };
    const f = facts({ msg: withRefundAddress, request });
    const v = btcDepositVerdict(f, CONFIG, CONFIRMED + 3 * DAY);
    const [execute] = refundCalls(f, v, CONFIG);
    expect(execute).toBeDefined();
    const steps = refundSteps(f, v, CONFIG);
    expect(steps[1]?.command).toBe(nearCliCommand(execute!));
    expect(steps[2]?.command).toBe(nearCliCommand(signRefundCall("btc", PENDING_ID_PLACEHOLDER)));
  });

  it("each call says what the signing account needs (deposit plus gas bought upfront) and which deposits are not returned", () => {
    const f = facts({ msg: withRefundAddress });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    const [setup, request, , execute, sign] = steps;
    expect(request?.note).toContain("The signing account needs a little over 2.3 NEAR: the 2 NEAR and 0.3 NEAR held for bridge-cli's 300 Tgas of gas (the unused gas comes back when the call finishes).");
    expect(request?.note).toContain("The contract takes the 2 NEAR before it checks the deposit against its light client, so a request that fails there still costs it.");
    expect(execute?.note).toContain("Attach exactly 1 NEAR, as this command does: the contract keeps all it is given, so anything more is lost.");
    expect(execute?.note).toContain("The signing account needs a little over 1.25 NEAR: the 1 NEAR and 0.25 NEAR held for 250 Tgas of gas (the unused gas comes back when the call finishes).");
    expect(sign?.note).toContain("The signing account needs a little over 0.25 NEAR, held for 250 Tgas of gas (the unused gas comes back when the call finishes); the 1 yoctoNEAR it attaches goes to NEAR's MPC signer.");
    expect(setup?.note).toContain("using-seed-phrase or using-private-key");
    expect(setup?.note).toContain("bridge-cli reads the account and its private key from NEAR_SIGNER and NEAR_PRIVATE_KEY.");
  });

  it("an account can have one executed refund waiting for its signature (the contract's pending_tx_limits default)", () => {
    const f = facts({ msg: withRefundAddress });
    const execute = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG).find((s) => s.title.startsWith("Execute"));
    expect(execute?.note).toContain("An account can have only one executed refund waiting for its signature: sign this one (next step) before executing another.");
  });

  it("an executed refund: only the near-cli sign-in and the sign step, with no bridge-cli setup", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: CONFIRMED, executed: true, msgHasRefundAddress: true, gasFeeSat: 5_000 };
    const f = facts({ msg: withRefundAddress, request });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + 3 * DAY), CONFIG);
    expect(steps.map((s) => s.title)).toEqual(["Let near-cli sign as your NEAR account (once)", "Have the bridge sign the Bitcoin refund"]);
    expect(steps[0]?.note).not.toContain("NEAR_SIGNER");
    expect(steps[1]?.note).toContain("generate_btc_pending_info");
  });

  it("names the sending wallet as the refund address only when the deposit has none", () => {
    const f = facts();
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain btc --btc-tx-hash ${TXID} --vout 0 --refund-address ${SENDER}`);
    expect(steps[2]?.title).toBe("Wait 14 days for the timelock");
  });

  it("gives no commands when the refund address cannot be told from the transaction, or the refund would return nothing", () => {
    const multi = facts({ senders: [SENDER, "bc1qother"] });
    expect(refundSteps(multi, btcDepositVerdict(multi, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
    const tiny = facts({ amountSat: 4_000 });
    expect(refundSteps(tiny, btcDepositVerdict(tiny, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
  });

  it("once the lock has passed: only execute and sign remain", () => {
    const request = { refundAddress: SENDER, amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 };
    const f = facts({ request });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, 1_790_000_000), CONFIG);
    expect(steps.map((s) => s.title)).toEqual(["Let near-cli sign as your NEAR account (once)", "Execute the refund (1 NEAR, not returned)", "Have the bridge sign the Bitcoin refund"]);
    expect(steps[0]?.note).not.toContain("NEAR_SIGNER");
  });

  it("a Zcash deposit gets the Zcash connector: bridge-cli's --chain zcash for the request, near-cli for a transparent execute and the sign", () => {
    const f = facts({ chain: "zcash", msg: { ...withRefundAddress, refund_address: T_ADDR }, senders: [T_ADDR] });
    const steps = refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG);
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain zcash --btc-tx-hash ${TXID} --vout 0`);
    expect(steps[3]?.command).toBe(
      `near contract call-function as-transaction zcash-connector.bridge.near execute_refund json-args '{"utxo_storage_key":"${TXID}@0","chain_specific_data":null}' prepaid-gas '250.0 Tgas' attached-deposit '1 NEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    );
    expect(steps[4]).toMatchObject({ title: "Have the bridge sign the Zcash refund", command: nearCliCommand(signRefundCall("zcash", PENDING_ID_PLACEHOLDER)) });
    expect(steps[4]?.note).toContain("bridge-cli mainnet near-sign-btc-transaction --chain zcash --btc-pending-id <btc_pending_id from the execute_refund logs>");
  });

  it("nothing to do for a credited deposit or one already refunded", () => {
    const f = facts({ bridgeHolds: true });
    expect(refundSteps(f, btcDepositVerdict(f, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
  });
});

describe("refundBoard", () => {
  const request = (over: Partial<RefundRequestRow>): RefundRequestRow => ({ refundAddress: SENDER, amountSat: 1_000_000, createdAtSec: 1_000_000, executed: false, msgHasRefundAddress: true, gasFeeSat: 5_000, ...over });
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

// ---------- Zcash: the refund fee, shielded refunds and shielded-funded deposits ----------

const T_ADDR = "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1";
/** Real refund addresses from mainnet deposit messages (deposits 04dc643f… and 477f3d00…, 2026-10). */
const UA_ORCHARD_SAPLING =
  "u1egfcnx27m4406w892hrp96n8akl66juj8pn0agqa2w2zrylpmq5yurssz0tlq3k4rmhag7y6kljezxp6me4j3h03ezs0tzrqynz2tdcnwenqqepl85f6qcxekcjv60wheqyyt5lk560t0m3tx7y2zqzwr56wr9fg76dumq08jspxmncv";
/** Synthetic: the Sapling receiver of a ZIP-316 test vector, encoded as a zs1 address. */
const SAPLING = "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn";
const UA_ORCHARD_ONLY = "u1r9ffm4hq7q2xcv4mwfhd0mpe0aw22klu9zxzsyr7shkx5rh77s0u3vpuc0vjchh7hvczldd8mwxgcydzyluhtd4h0zejlc5p5qzn5wn0";
/** ZIP-316 test vector: P2PKH + Orchard receivers. */
const UA_T_AND_ORCHARD = "u1snf9yr883aj2hm8pksp9aymnqdwzy42rpzuffevj35hhxeckays5pcpeq7vy2mtgzlcuc4mnh9443qnuyje0yx6h59angywka4v2ap6kchh2j96ezf9w0c0auyz3wwts2lx5gmk2sk9";
const ZTX = "04dc643f8a1d19baf476178d01eac8fc553700e36f849df91e46924fa3f2cae6";
const zfacts = (over: Partial<BtcDepositFacts> = {}): BtcDepositFacts =>
  facts({ chain: "zcash", txid: ZTX, amountSat: 5_000_000_000, depositAddress: "t1RTEogVdgA8cWY8zm1uomj5ThPZnbp8BB4", senders: [T_ADDR], ...over });

describe("the Zcash refund fee", () => {
  it("is the ZIP-317 minimum for a one-input refund, as the contract computes it: 10,000 zatoshis either way", () => {
    // Transparent: 1 P2PKH input, 1 P2PKH output. Shielded: 1 input, no transparent output, 1 Orchard/Ironwood action.
    expect(zip317Fee({ transparentInputs: 1, transparentOutputs: 1, orchardActions: 0 })).toBe(10_000);
    expect(zip317Fee({ transparentInputs: 1, transparentOutputs: 0, orchardActions: 1 })).toBe(10_000);
    expect(zip317Fee({ transparentInputs: 1, transparentOutputs: 0, orchardActions: 3 })).toBe(20_000);
    expect(ZCASH_REFUND_FEE_ZAT).toBe(10_000);
  });

  it("is the connector's max_btc_gas_fee on Bitcoin and the ZIP-317 minimum on Zcash (not Zcash's 0.01 ZEC max_btc_gas_fee)", () => {
    expect(refundFeeFor("btc", 5_000)).toBe(5_000);
    expect(refundFeeFor("zcash", 1_000_000)).toBe(10_000);
  });

  it("a Zcash deposit between the fee and 0.01 ZEC is refundable (it used to be called too small)", () => {
    const v = btcDepositVerdict(zfacts({ amountSat: 50_000 }), ZCONFIG, CONFIRMED + DAY);
    expect(v).toMatchObject({ state: "refundable", belowMinimum: true, tooSmall: false, feeSat: 10_000 });
    expect(refundSteps(zfacts({ amountSat: 50_000 }), v, ZCONFIG).map((s) => s.title)[1]).toBe("Request the refund (2 NEAR, not returned)");
  });

  it("the contract needs the fee to be less than the deposit: 10,000 zatoshis or less cannot be refunded", () => {
    expect(btcDepositVerdict(zfacts({ amountSat: 10_000 }), ZCONFIG, CONFIRMED + DAY)).toMatchObject({ tooSmall: true });
    expect(btcDepositVerdict(zfacts({ amountSat: 10_001 }), ZCONFIG, CONFIRMED + DAY)).toMatchObject({ tooSmall: false });
  });
});

describe("refundPath: which execute_refund the connector can build for an address", () => {
  it("Bitcoin is always transparent", () => {
    expect(refundPath("btc", SENDER)).toBe("transparent");
  });

  it("Zcash: an Orchard receiver gets the shielded bundle; a t-address the transparent refund; Sapling-only nothing", () => {
    expect(refundPath("zcash", UA_ORCHARD_ONLY)).toBe("shielded");
    expect(refundPath("zcash", UA_ORCHARD_SAPLING)).toBe("shielded");
    expect(refundPath("zcash", UA_T_AND_ORCHARD)).toBe("shielded");
    expect(refundPath("zcash", T_ADDR)).toBe("transparent");
    expect(refundPath("zcash", SAPLING)).toBe("none");
    expect(refundPath("zcash", "not an address")).toBe("none");
  });
});

describe("refundSteps for Zcash refunds", () => {
  it("a unified address with an Orchard receiver: bridge-cli btc-execute-refund builds the Orchard bundle by default", () => {
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: UA_ORCHARD_ONLY } });
    const steps = refundSteps(f, btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY), ZCONFIG);
    expect(steps.map((s) => s.title)).toEqual([
      "Let near-cli sign as your NEAR account (once)",
      "Request the refund (2 NEAR, not returned)",
      "Wait 2 days for the timelock",
      "Execute the refund, shielded (1 NEAR, not returned)",
      "Have the bridge sign the Zcash refund",
    ]);
    expect(steps[3]?.command).toBe(`bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash ${ZTX} --vout 0`);
    expect(steps[3]?.note).toContain("Orchard bundle");
    expect(steps[3]?.note).not.toContain("--transparent");
    // bridge-cli attaches the live deposit itself, with its own 300 Tgas.
    expect(steps[3]?.note).toContain("The signing account needs a little over 1.3 NEAR: the 1 NEAR and 0.3 NEAR held for bridge-cli's 300 Tgas of gas");
    expect(steps[3]?.note).not.toContain("Attach exactly");
  });

  it("a Zcash execute takes the 1 NEAR before the contract checks the lock and the request, so a failed one still costs it", () => {
    for (const address of [UA_ORCHARD_ONLY, T_ADDR]) {
      const f = zfacts({ msg: { ...withRefundAddress, refund_address: address } });
      const execute = refundSteps(f, btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY), ZCONFIG).find((s) => s.title.startsWith("Execute"));
      expect(execute?.note, address).toContain("On Zcash the contract takes the 1 NEAR before it checks the lock and the request, so a call that fails there still costs it: send it once, after the lock has passed.");
    }
    const btc = facts({ msg: withRefundAddress });
    expect(refundSteps(btc, btcDepositVerdict(btc, CONFIG, CONFIRMED + DAY), CONFIG).find((s) => s.title.startsWith("Execute"))?.note).not.toContain("On Zcash");
  });

  it("a unified address with both an Orchard and a transparent receiver: shielded by default, --transparent offered", () => {
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: UA_T_AND_ORCHARD } });
    const steps = refundSteps(f, btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY), ZCONFIG);
    expect(steps[3]?.command).not.toContain("--transparent");
    expect(steps[3]?.note).toContain("--transparent");
  });

  it("a t-address: the transparent refund with near-cli (no Orchard bundle to build), attaching exactly the live deposit", () => {
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: T_ADDR } });
    const steps = refundSteps(f, btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY), ZCONFIG);
    expect(steps[3]).toMatchObject({
      title: "Execute the refund, transparent (1 NEAR, not returned)",
      command: nearCliCommand(refundCalls(f, { state: "ready", refundTo: T_ADDR }, ZCONFIG)[0]!),
    });
    expect(steps[3]?.command).toContain(`execute_refund json-args '{"utxo_storage_key":"${ZTX}@0","chain_specific_data":null}'`);
    expect(steps[3]?.note).toContain("Attach exactly 1 NEAR");
    expect(steps[0]?.note).toContain("NEAR_SIGNER"); // the request is still bridge-cli's
  });

  it("a ready request to a unified address: execute shielded, with the fee stored on the request", () => {
    const request = { refundAddress: UA_ORCHARD_SAPLING, amountSat: 5_000_000_000, createdAtSec: CONFIRMED, executed: false, msgHasRefundAddress: true, gasFeeSat: 10_000 };
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: UA_ORCHARD_SAPLING }, request });
    const v = btcDepositVerdict(f, ZCONFIG, CONFIRMED + 3 * DAY);
    expect(v.state).toBe("ready");
    const steps = refundSteps(f, v, ZCONFIG);
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash ${ZTX} --vout 0`);
    expect(steps[0]?.note).toContain("NEAR_SIGNER");
  });

  it("a deposit whose refund address is Sapling-only (synthetic): no commands, the connector cannot pay it", () => {
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: SAPLING } });
    const v = btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY);
    expect(v).toMatchObject({ state: "refundable", refundTo: f.msg?.refund_address });
    expect(refundSteps(f, v, ZCONFIG)).toEqual([]);
  });
});

describe("a Zcash deposit funded from a shielded pool", () => {
  const shielded: Funding = { kind: "shielded", pools: ["Ironwood"] };

  it("with the deposit's own refund address (as real 1Click deposits carry): that address, no sender needed", () => {
    const f = zfacts({ senders: [], funding: shielded, msg: { ...withRefundAddress, refund_address: UA_ORCHARD_SAPLING } });
    expect(btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY)).toMatchObject({ state: "refundable", refundTo: UA_ORCHARD_SAPLING, refundToFromDeposit: true, noTransparentSender: true, lockSec: 172_800 });
  });

  it("synthetic, no refund address in the deposit: no sender to suggest; the depositor names their own address (14-day lock)", () => {
    const f = zfacts({ senders: [], funding: shielded });
    const v = btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY);
    expect(v).toMatchObject({ state: "refundable", refundTo: null, refundToFromDeposit: false, noTransparentSender: true, lockSec: 1_209_600 });
    const steps = refundSteps(f, v, ZCONFIG);
    expect(steps.map((s) => s.title)).toEqual([
      "Let near-cli sign as your NEAR account (once)",
      "Request the refund to your own address (2 NEAR, not returned)",
      "Wait 14 days for the timelock",
      "Execute the refund, shielded (1 NEAR, not returned)",
      "Have the bridge sign the Zcash refund",
    ]);
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain zcash --btc-tx-hash ${ZTX} --vout 0 --refund-address <your own unified address (u1…) with an Orchard receiver>`);
    expect(steps[1]?.note).toContain("cannot check that the address is yours");
    expect(steps[1]?.note).toContain("The signing account needs a little over 2.3 NEAR");
    expect(steps[1]?.note).toContain("Request it before about 2026-11-17");
  });

  it("several transparent senders still get no suggestion and no commands", () => {
    const f = zfacts({ senders: [T_ADDR, "t1other"] });
    const v = btcDepositVerdict(f, ZCONFIG, CONFIRMED + DAY);
    expect(v).toMatchObject({ refundTo: null, noTransparentSender: false });
    expect(refundSteps(f, v, ZCONFIG)).toEqual([]);
  });
});

describe("a deposit below the minimum that the bridge verified (unavailable_utxos)", () => {
  it("is absorbed, not credited: nothing was minted and the contract has no refund path for it", () => {
    const f = facts({ chain: "zcash", amountSat: 40_000, absorbed: true });
    expect(isCredited(f)).toBe(false);
    expect(btcDepositVerdict(f, ZCONFIG, CONFIRMED + 86_400)).toEqual({ state: "absorbed", minDepositSat: 100_000 });
    expect(refundSteps(f, { state: "absorbed", minDepositSat: 100_000 }, ZCONFIG)).toEqual([]);
  });
});

// From the 2026-10-14 verification of the 28 stuck Bitcoin deposits (research_notes/Stuck BTC verification).
describe("refund safety", () => {
  const DAY_S = 86_400;

  it("never suggests refunding to the sender of a batch payout (an exchange or service paying many outputs): the user names their own address", () => {
    const f = facts({ outputs: 22, senders: ["bc1qexchangehotwallet0000000000000000000"] });
    const v = btcDepositVerdict(f, CONFIG, CONFIRMED + DAY_S);
    expect(v).toMatchObject({ state: "refundable", refundTo: null, batchSender: true });
    const steps = refundSteps(f, v, CONFIG);
    expect(steps[1]?.command).toBe(`bridge-cli mainnet btc-request-refund --chain btc --btc-tx-hash ${TXID} --vout 0 --refund-address <your own Bitcoin address>`);
    expect(steps[1]?.note).toContain("came in a batch payout of 22 outputs");
    expect(steps[1]?.note).toContain("The signing account needs a little over 2.3 NEAR");
  });

  it("a single sender that paid one or two outputs (payment and change) is still the refund address", () => {
    expect(btcDepositVerdict(facts({ outputs: 2 }), CONFIG, CONFIRMED + DAY_S)).toMatchObject({ state: "refundable", refundTo: SENDER, batchSender: false });
  });

  it("a deposit whose message pins the refund to a public example address cannot be recovered by its depositor: no steps", () => {
    const placeholder = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
    const f = facts({ msg: { ...withRefundAddress, refund_address: placeholder } });
    const v = btcDepositVerdict(f, CONFIG, CONFIRMED + DAY_S);
    expect(v).toEqual({ state: "placeholder_refund", refundTo: placeholder });
    expect(refundSteps(f, v, CONFIG)).toEqual([]);
  });

  it("a Bitcoin refund must be requested while the bridge's light client still has the deposit's block (52,704 blocks, about 366 days)", () => {
    const v = btcDepositVerdict(facts(), CONFIG, CONFIRMED + DAY_S);
    expect(v).toMatchObject({ state: "refundable", requestBySec: CONFIRMED + 52_704 * 600 });
    expect(refundSteps(facts(), v, CONFIG)[1]?.note).toContain("Request it before about 2027-08-20");
    expect(btcDepositVerdict(facts(), CONFIG, CONFIRMED + 52_704 * 600 + 1)).toEqual({ state: "too_old", requestBySec: CONFIRMED + 52_704 * 600 });
  });

  it("a Zcash refund must be requested while zcash-client.bridge.near still has the deposit's block (103,680 blocks: 90 days at 75 seconds)", () => {
    expect(REQUEST_WINDOW.zcash).toMatchObject({ blocks: 103_680, blockSec: 75 });
    expect(requestWindowSec("zcash")).toBe(90 * DAY_S);
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: T_ADDR } });
    const v = btcDepositVerdict(f, ZCONFIG, CONFIRMED + 60 * DAY_S);
    expect(v).toMatchObject({ state: "refundable", requestBySec: CONFIRMED + 90 * DAY_S });
    expect(refundSteps(f, v, ZCONFIG).find((s) => s.title.startsWith("Request"))?.note).toContain("Request it before about 2026-11-17");
    expect(btcDepositVerdict(f, ZCONFIG, CONFIRMED + 91 * DAY_S)).toEqual({ state: "too_old", requestBySec: CONFIRMED + 90 * DAY_S });
    expect(refundSteps(f, { state: "too_old", requestBySec: CONFIRMED + 90 * DAY_S }, ZCONFIG)).toEqual([]);
  });

  it("the Bitcoin window is unchanged: 52,704 blocks at 10 minutes, about 366 days", () => {
    expect(REQUEST_WINDOW.btc).toMatchObject({ blocks: 52_704, blockSec: 600 });
    expect(requestWindowSec("btc")).toBe(52_704 * 600);
    expect(BTC_REQUEST_WINDOW_SEC).toBe(52_704 * 600);
  });

  it("a request made in time is not too old later: the light client is needed only for the request", () => {
    const request = { refundAddress: T_ADDR, amountSat: 5_000_000_000, createdAtSec: CONFIRMED + 80 * DAY_S, executed: false, msgHasRefundAddress: true, gasFeeSat: 10_000 };
    const f = zfacts({ msg: { ...withRefundAddress, refund_address: T_ADDR }, request });
    expect(btcDepositVerdict(f, ZCONFIG, CONFIRMED + 120 * DAY_S)).toMatchObject({ state: "ready", refundTo: T_ADDR });
  });

  it("a deposit spent alone to one address after its request was deleted is refunded there, not credited", () => {
    // The contract deletes a finished request: a refund to an address the requester named leaves only the spend.
    const f = facts({ spentBy: { txid: "ref", inputs: 1, paysTo: ["bc1qnamedbytherequester000000000000000000"] } });
    expect(isCredited(f)).toBe(false);
    expect(btcDepositVerdict(f, CONFIG, CONFIRMED + 30 * DAY_S)).toEqual({ state: "refunded", refundTo: "bc1qnamedbytherequester000000000000000000", refundTx: "ref" });
  });
});

describe("receiverOf", () => {
  const safe = (msg: string) => ({ recipient_id: "intents.near", safe_deposit: { msg } });

  it("takes a bare account as the safe deposit message (intents.near's DepositMessage::from_str accepts one)", () => {
    expect(receiverOf(safe("alice.near"))).toBe("alice.near");
    expect(receiverOf(safe("a1-b_c.sub.near"))).toBe("a1-b_c.sub.near");
    expect(receiverOf(safe(`0x${"ab".repeat(20)}`))).toBe(`0x${"ab".repeat(20)}`);
  });

  it("never names an account id the protocol rejects: separators at either end or doubled, wrong case or length (docs.near.org account-validation)", () => {
    for (const bad of ["-a", "a-", ".near", "near.", "a..b", "a-_b", "a.-b", "Alice.near", "a", "a".repeat(65), "alice near", "alice@near", ""]) {
      expect(receiverOf(safe(bad)), bad).toBe("intents.near");
      expect(receiverOf(safe(JSON.stringify({ receiver_id: bad }))), `json ${bad}`).toBe("intents.near");
    }
    expect(isNearAccountId("a".repeat(64))).toBe(true);
    expect(isNearAccountId("ab")).toBe(true);
  });

  it("reads the JSON form only when the message starts with {, as intents.near does", () => {
    expect(receiverOf(safe(`{"receiver_id":"${ORDER}"}`))).toBe(ORDER);
    // Not an object: intents.near would take the whole string as the account id, which is not one.
    expect(receiverOf(safe('"alice.near"'))).toBe("intents.near");
    expect(receiverOf(safe("{not json"))).toBe("intents.near");
  });
});
