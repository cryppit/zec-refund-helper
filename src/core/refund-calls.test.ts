// The exact NEAR calls that finish a stuck Bitcoin or Zcash refund: execute_refund, then sign_btc_transaction, as a
// wallet signs them and as near-cli prints them.
import { describe, expect, it } from "vitest";

import { btcDepositVerdict, type BtcDepositFacts, type BtcDepositVerdict, type RefundConfig } from "./btc-refund.js";
import {
  BRIDGE_CLI_GAS,
  type BridgeEvent,
  executeRefundCall,
  nearCliCommand,
  PENDING_ID_PLACEHOLDER,
  pendingIdOf,
  REFUND_CALL_GAS,
  refundCalls,
  signRefundCall,
  upfrontYocto,
  walletTransaction,
} from "./refund-calls.js";

const NEAR = 10n ** 24n;
const CONFIG: RefundConfig = {
  refundTimelockSec: 172_800,
  unsafeRefundTimelockSec: 1_209_600,
  minDepositSat: 2_500,
  maxGasFeeSat: 5_000,
  refundFeeSat: 5_000,
  requestDepositYocto: 2n * NEAR,
  executeDepositYocto: 1n * NEAR,
};
const ZCONFIG: RefundConfig = { ...CONFIG, minDepositSat: 100_000, maxGasFeeSat: 1_000_000, refundFeeSat: 10_000 };

const SENDER = "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t";
const TXID = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
const CONFIRMED = 1_787_159_956;
const DAY = 86_400;
const T_ADDR = "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1";
const UA_ORCHARD_ONLY = "u1r9ffm4hq7q2xcv4mwfhd0mpe0aw22klu9zxzsyr7shkx5rh77s0u3vpuc0vjchh7hvczldd8mwxgcydzyluhtd4h0zejlc5p5qzn5wn0";
const SAPLING = "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn";
const PENDING = "4c1b3f0e9a8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a3928170605f4e";

const request = (refundAddress: string, executed = false) => ({ refundAddress, amountSat: 9_997_900, createdAtSec: CONFIRMED, executed, msgHasRefundAddress: true, gasFeeSat: 5_000 });
const facts = (over: Partial<BtcDepositFacts> = {}): BtcDepositFacts => ({
  chain: "btc",
  txid: TXID,
  vout: 0,
  amountSat: 9_997_900,
  depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
  confirmedAtSec: CONFIRMED,
  senders: [SENDER],
  msg: { recipient_id: "intents.near", refund_address: SENDER },
  bridgeHolds: false,
  spentBy: null,
  request: null,
  funding: { kind: "transparent", pools: [] },
  ...over,
});
const zfacts = (refundAddress: string, over: Partial<BtcDepositFacts> = {}): BtcDepositFacts =>
  facts({ chain: "zcash", senders: [T_ADDR], msg: { recipient_id: "intents.near", refund_address: refundAddress }, request: request(refundAddress), ...over });
const AFTER_LOCK = CONFIRMED + 3 * DAY;

describe("refundCalls: the calls a wallet can sign now", () => {
  it("a ready Bitcoin refund: execute_refund on btc-connector.bridge.near, args as bridge-cli sends them, 250 Tgas, the live execute deposit", () => {
    const f = facts({ request: request(SENDER) });
    const v = btcDepositVerdict(f, CONFIG, AFTER_LOCK);
    expect(v.state).toBe("ready");
    expect(refundCalls(f, v, CONFIG)).toEqual([
      {
        receiverId: "btc-connector.bridge.near",
        methodName: "execute_refund",
        args: { utxo_storage_key: `${TXID}@0`, chain_specific_data: null },
        gas: "250000000000000",
        deposit: "1000000000000000000000000",
      },
    ]);
  });

  it("the deposit is the config's (read live from required_balance_for_execute_refund), in yoctoNEAR as a string", () => {
    const f = facts({ request: request(SENDER) });
    const c = { ...CONFIG, executeDepositYocto: 3n * NEAR + 5n };
    expect(refundCalls(f, btcDepositVerdict(f, c, AFTER_LOCK), c)[0]?.deposit).toBe("3000000000000000000000005");
  });

  it("nothing to sign before the lock has passed, for a deposit nobody requested, or one credited, absorbed or refunded", () => {
    const requested = facts({ request: request(SENDER) });
    expect(refundCalls(requested, btcDepositVerdict(requested, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
    const stuck = facts();
    expect(refundCalls(stuck, btcDepositVerdict(stuck, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
    const credited = facts({ bridgeHolds: true });
    expect(refundCalls(credited, btcDepositVerdict(credited, CONFIG, CONFIRMED + DAY), CONFIG)).toEqual([]);
    const absorbed: BtcDepositVerdict = { state: "absorbed", minDepositSat: 2_500 };
    const refunded: BtcDepositVerdict = { state: "refunded", refundTo: SENDER, refundTx: "ab".repeat(32) };
    expect(refundCalls(facts(), absorbed, CONFIG)).toEqual([]);
    expect(refundCalls(facts(), refunded, CONFIG)).toEqual([]);
  });

  it("an executed refund: sign_btc_transaction with the pending id, input 0, key version 0, 1 yoctoNEAR; nothing without the id", () => {
    const f = facts({ request: request(SENDER, true) });
    const v = btcDepositVerdict(f, CONFIG, AFTER_LOCK);
    expect(v.state).toBe("executed");
    expect(refundCalls(f, v, CONFIG, PENDING)).toEqual([
      {
        receiverId: "btc-connector.bridge.near",
        methodName: "sign_btc_transaction",
        args: { btc_pending_sign_id: PENDING, sign_index: 0, key_version: 0 },
        gas: "250000000000000",
        deposit: "1",
      },
    ]);
    expect(refundCalls(f, v, CONFIG)).toEqual([]);
  });

  it("Zcash: a transparent refund goes to zcash-connector.bridge.near; a shielded one needs bridge-cli's Orchard bundle; a Sapling-only address none", () => {
    const transparent = zfacts(T_ADDR);
    expect(refundCalls(transparent, btcDepositVerdict(transparent, ZCONFIG, AFTER_LOCK), ZCONFIG)).toEqual([
      { receiverId: "zcash-connector.bridge.near", methodName: "execute_refund", args: { utxo_storage_key: `${TXID}@0`, chain_specific_data: null }, gas: "250000000000000", deposit: "1000000000000000000000000" },
    ]);
    const shielded = zfacts(UA_ORCHARD_ONLY);
    expect(btcDepositVerdict(shielded, ZCONFIG, AFTER_LOCK).state).toBe("ready");
    expect(refundCalls(shielded, btcDepositVerdict(shielded, ZCONFIG, AFTER_LOCK), ZCONFIG)).toEqual([]);
    const sapling = zfacts(SAPLING);
    expect(refundCalls(sapling, btcDepositVerdict(sapling, ZCONFIG, AFTER_LOCK), ZCONFIG)).toEqual([]);
    // Signing is the same for a shielded refund: the bundle was given to execute_refund.
    expect(refundCalls(shielded, { state: "executed", refundTo: UA_ORCHARD_ONLY }, ZCONFIG, PENDING)[0]).toMatchObject({ receiverId: "zcash-connector.bridge.near", methodName: "sign_btc_transaction" });
  });

  it("250 Tgas fits every NEAR Connect wallet (Ethereum wallets cap a call at 270 Tgas) and covers the contracts' ~90 Tgas of static needs", () => {
    expect(REFUND_CALL_GAS).toBe(250_000_000_000_000n);
    expect(REFUND_CALL_GAS <= 270_000_000_000_000n && REFUND_CALL_GAS >= 90_000_000_000_000n).toBe(true);
    expect(BRIDGE_CLI_GAS).toBe(300_000_000_000_000n);
  });
});

describe("the same calls for the site's wallet button and for near-cli", () => {
  it("walletTransaction is the shape NEAR Connect's signAndSendTransaction takes: one FunctionCall action", () => {
    expect(walletTransaction(executeRefundCall("btc", `${TXID}@0`, NEAR))).toEqual({
      receiverId: "btc-connector.bridge.near",
      actions: [
        {
          type: "FunctionCall",
          params: { methodName: "execute_refund", args: { utxo_storage_key: `${TXID}@0`, chain_specific_data: null }, gas: "250000000000000", deposit: "1000000000000000000000000" },
        },
      ],
    });
  });

  it("nearCliCommand prints the call in near-cli's full form (docs.near.org /tools/cli)", () => {
    expect(nearCliCommand(executeRefundCall("btc", `${TXID}@0`, NEAR))).toBe(
      `near contract call-function as-transaction btc-connector.bridge.near execute_refund json-args '{"utxo_storage_key":"${TXID}@0","chain_specific_data":null}' prepaid-gas '250.0 Tgas' attached-deposit '1 NEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    );
    expect(nearCliCommand(signRefundCall("zcash", PENDING_ID_PLACEHOLDER))).toBe(
      `near contract call-function as-transaction zcash-connector.bridge.near sign_btc_transaction json-args '{"btc_pending_sign_id":"<btc_pending_id from the execute_refund logs>","sign_index":0,"key_version":0}' prepaid-gas '250.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    );
    expect(nearCliCommand(executeRefundCall("btc", `${TXID}@0`, 1_500_000_000_000_000_000_000_000n))).toContain("attached-deposit '1.5 NEAR'");
  });
});

describe("upfrontYocto: what the signing account must hold while a call runs", () => {
  it("the deposit plus the gas bought upfront at 0.001 NEAR per Tgas (the protocol's minimum gas purchase price)", () => {
    expect(upfrontYocto(REFUND_CALL_GAS, NEAR)).toBe(1_250_000_000_000_000_000_000_000n); // execute: 1.25 NEAR
    expect(upfrontYocto(BRIDGE_CLI_GAS, 2n * NEAR)).toBe(2_300_000_000_000_000_000_000_000n); // request: 2.3 NEAR
    expect(upfrontYocto(REFUND_CALL_GAS, 1n)).toBe(250_000_000_000_000_000_000_001n); // sign: 0.25 NEAR
  });
});

describe("pendingIdOf: the btc_pending_id the sign call needs, from the execute_refund outcome", () => {
  // Events as a NEP-297 decoder gives them (Where's My Swap's decodeTxStatus) from the connector's log
  // EVENT_JSON:{"standard":"bridge","version":"1.0.0","event":"generate_btc_pending_info","data":[{"account_id":"…","btc_pending_id":"…"}]}
  const event = (over: Partial<BridgeEvent> = {}): BridgeEvent => ({
    standard: "bridge",
    event: "generate_btc_pending_info",
    data: [{ account_id: "alice.near", btc_pending_id: PENDING }],
    executor: "btc-connector.bridge.near",
    failed: false,
    ...over,
  });

  it("reads the connector's generate_btc_pending_info event", () => {
    expect(pendingIdOf([event({ event: "refund_executed", data: [{}] }), event()], "btc")).toBe(PENDING);
  });

  it("only from the chain's own connector, from a receipt that succeeded", () => {
    expect(pendingIdOf([event({ executor: "evil.near" })], "btc")).toBeNull();
    expect(pendingIdOf([event()], "zcash")).toBeNull();
    expect(pendingIdOf([event({ failed: true })], "btc")).toBeNull();
    expect(pendingIdOf([], "btc")).toBeNull();
  });
});
