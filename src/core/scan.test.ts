import { describe, expect, it } from "vitest";

import type { BtcDepositFacts, BtcDepositVerdict, RefundConfig } from "./btc-refund.js";
import { ageBuckets, cursorAt, isCreditedStatus, cursorTime, parseTransfersPage, refundAddressKind, scanRow, segments, stuckCause, summarize, type ScanRow } from "./scan.js";

const CFG: RefundConfig = {
  refundTimelockSec: 172_800,
  unsafeRefundTimelockSec: 1_209_600,
  minDepositSat: 100_000,
  maxGasFeeSat: 1_000_000,
  refundFeeSat: 10_000,
  requestDepositYocto: 2n * 10n ** 24n,
  executeDepositYocto: 10n ** 24n,
};
const NOW = 1_791_900_000;

const facts = (over: Partial<BtcDepositFacts> = {}): BtcDepositFacts => ({
  chain: "zcash",
  txid: "aa".repeat(32),
  vout: 0,
  amountSat: 5_000_000,
  depositAddress: "t1c4LrfuWHBmL86JZcohcdt5gWZTJfTYtte",
  confirmedAtSec: NOW - 10 * 86_400,
  senders: ["t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1"],
  msg: { recipient_id: "intents.near" },
  bridgeHolds: false,
  spentBy: null,
  request: null,
  funding: { kind: "transparent", pools: [] },
  ...over,
});

describe("indexer cursors", () => {
  it("a cursor is a MongoDB ObjectId: 4 bytes of seconds, then zeros to start a segment at that time", () => {
    expect(cursorAt(1_782_396_000)).toBe("6a3d34600000000000000000");
    expect(cursorTime("6a3d34d295e6fb47ba34406e")).toBe(0x6a3d34d2);
  });

  it("splits a time range into back-to-back segments, the last one cut at the end", () => {
    expect(segments(100, 350, 100)).toEqual([
      { fromSec: 100, toSec: 200 },
      { fromSec: 200, toSec: 300 },
      { fromSec: 300, toSec: 350 },
    ]);
  });
});

describe("parseTransfersPage", () => {
  it("keeps only deposits from Bitcoin or Zcash (utxo transfer ids), with the indexer's status", () => {
    const page = {
      next_cursor: "6a3d34d295e6fb47ba34406e",
      transfers: [
        { transfer_id: { type: "nonce", chain: "Near", nonce: 1 }, origin_chain: "Near", destination_chain: "Sol", status: "Settled" },
        { transfer_id: { type: "utxo", chain: "Near", tx_hash: "cc".repeat(32), vout: 0 }, origin_chain: "Near", destination_chain: "Btc", status: "Settled" },
        {
          transfer_id: { type: "utxo", chain: "Btc", tx_hash: "AA".repeat(32), vout: 1 },
          origin_chain: "Btc",
          destination_chain: "Near",
          recipient: "near:intents.near",
          amount: "9997900",
          status: "Initialised",
          initialised: { transaction_hash: "aa".repeat(32), chain: "Btc", timestamp_seconds: 1_787_159_956, details: { type: "utxo", block_height: 963_199 } },
        },
        { transfer_id: { type: "utxo", chain: "Zcash", tx_hash: "bb".repeat(32), vout: 0 }, origin_chain: "Zcash", destination_chain: "Near", amount: "41000000", status: "Finalised" },
      ],
    };
    expect(parseTransfersPage(page)).toEqual({
      records: 4,
      nextCursor: "6a3d34d295e6fb47ba34406e",
      deposits: [
        { chain: "btc", txid: "aa".repeat(32), vout: 1, amountSat: 9_997_900, status: "Initialised", seenAtSec: 1_787_159_956, recipient: "near:intents.near" },
        { chain: "zcash", txid: "bb".repeat(32), vout: 0, amountSat: 41_000_000, status: "Finalised", seenAtSec: null, recipient: null },
      ],
    });
  });

  it("a page with no transfers ends the walk", () => {
    expect(parseTransfersPage({ transfers: [] })).toEqual({ records: 0, nextCursor: null, deposits: [] });
    expect(parseTransfersPage("Invalid argument")).toBeNull();
  });
});

describe("isCreditedStatus", () => {
  it("Finalised and FinalisedOnNear (the NEAR leg of an onward Omni transfer) are credited; Initialised is not", () => {
    expect(["Finalised", "FinalisedOnNear", "Initialised"].map(isCreditedStatus)).toEqual([true, true, false]);
  });

  it("the v4 statuses past signing count too: fast-finalised (a relayer paid ahead) and Settled, the terminal state; Signed does not", () => {
    expect(["FastFinalisedOnNear", "FastFinalised", "Settled", "Signed"].map(isCreditedStatus)).toEqual([true, true, true, false]);
  });
});

describe("stuckCause", () => {
  const refundable: BtcDepositVerdict = { state: "refundable", refundTo: "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1", refundToFromDeposit: false, lockSec: 1_209_600, belowMinimum: false, tooSmall: false, feeSat: 10_000, noTransparentSender: false, batchSender: false, requestBySec: null };

  it("credited, refunded or not a deposit at all: not stuck", () => {
    expect(stuckCause(facts({ bridgeHolds: true }), { state: "credited", orderAccount: "x" }, CFG, true)).toBeNull();
    expect(stuckCause(facts(), { state: "refunded", refundTo: "t1", refundTx: "dd" }, CFG, true)).toBeNull();
  });

  it("still within the crediting window, or unconfirmed: pending", () => {
    expect(stuckCause(facts(), { state: "crediting", stuckAfterSec: NOW + 60 }, CFG, true)).toBe("pending");
    expect(stuckCause(facts({ confirmedAtSec: null }), { state: "unconfirmed" }, CFG, true)).toBe("pending");
  });

  it("below the connector's minimum deposit", () => {
    expect(stuckCause(facts({ amountSat: 99_999 }), { ...refundable, belowMinimum: true }, CFG, true)).toBe("below_minimum");
  });

  it("absorbed by the bridge (verified below the minimum, nothing minted): below_minimum", () => {
    expect(stuckCause(facts({ amountSat: 40_000, absorbed: true }), { state: "absorbed", minDepositSat: 100_000 }, CFG, true)).toBe("below_minimum");
  });

  it("no deposit message that derives this address, or one naming a NEAR account that does not exist: bad message", () => {
    expect(stuckCause(facts({ msg: null }), { state: "not_a_deposit" }, CFG, null)).toBe("bad_message");
    expect(stuckCause(facts(), refundable, CFG, false)).toBe("bad_message");
  });

  it("everything checks out and it still was not credited: unknown", () => {
    expect(stuckCause(facts(), refundable, CFG, true)).toBe("unknown");
    expect(stuckCause(facts(), { state: "ready", refundTo: "t1", unlockedAtSec: NOW - 1 }, CFG, true)).toBe("unknown");
  });
});

describe("refundAddressKind", () => {
  it("names what kind of refund address a deposit carries", () => {
    expect(refundAddressKind("zcash", undefined)).toBe("none");
    expect(refundAddressKind("zcash", "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1")).toBe("transparent");
    expect(refundAddressKind("btc", "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t")).toBe("transparent");
    expect(refundAddressKind("zcash", "zs1notavalidaddress")).toBe("unpayable");
  });
});

describe("scanRow", () => {
  it("a stuck deposit whose request is past its lock and unexecuted: ready, refundable now by executing", () => {
    const f = facts({ chain: "btc", request: { refundAddress: "bc1q", amountSat: 5_000_000, createdAtSec: NOW - 20 * 86_400, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 } });
    const row = scanRow(f, { state: "ready", refundTo: "bc1q", unlockedAtSec: NOW - 6 * 86_400 }, CFG, NOW, { recipientExists: true, source: "refund_request", indexerStatus: null });
    expect(row).toMatchObject({ chain: "btc", cause: "unknown", refund: { status: "ready", refundTo: "bc1q" }, refundableNow: "execute", ageSec: 10 * 86_400, source: "refund_request" });
  });

  it("a stuck deposit with no request and a known refund address: refundable now by requesting", () => {
    const row = scanRow(facts(), { state: "refundable", refundTo: "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1", refundToFromDeposit: false, lockSec: 1_209_600, belowMinimum: false, tooSmall: false, feeSat: 10_000, noTransparentSender: false, batchSender: false, requestBySec: null }, CFG, NOW, {
      recipientExists: true,
      source: "indexer",
      indexerStatus: "Initialised",
    });
    expect(row).toMatchObject({ refund: { status: "none", refundTo: null }, refundableNow: "request", refundAddress: "none", funding: { kind: "transparent" } });
  });

  it("a deposit not larger than the refund fee cannot be refunded", () => {
    const row = scanRow(facts({ amountSat: 10_000 }), { state: "refundable", refundTo: "t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1", refundToFromDeposit: false, lockSec: 1, belowMinimum: true, tooSmall: true, feeSat: 10_000, noTransparentSender: false, batchSender: false, requestBySec: null }, CFG, NOW, {
      recipientExists: true,
      source: "indexer",
      indexerStatus: "Initialised",
    });
    expect(row?.refundableNow).toBe("no");
    expect(row?.cause).toBe("below_minimum");
  });

  it("an absorbed deposit is stuck and cannot be refunded", () => {
    const row = scanRow(facts({ amountSat: 40_000, absorbed: true }), { state: "absorbed", minDepositSat: 100_000 }, CFG, NOW, { recipientExists: null, source: "unavailable_utxos", indexerStatus: null });
    expect(row).toMatchObject({ cause: "below_minimum", verdict: "absorbed", refundableNow: "no", refund: { status: "none" } });
  });

  it("a credited deposit is no row", () => {
    expect(scanRow(facts({ bridgeHolds: true }), { state: "credited", orderAccount: "x" }, CFG, NOW, { recipientExists: true, source: "indexer", indexerStatus: "Initialised" })).toBeNull();
  });
});

describe("summarize", () => {
  const row = (over: Partial<ScanRow>): ScanRow => ({
    chain: "zcash",
    txid: "aa".repeat(32),
    vout: 0,
    amountSat: 1_000_000,
    depositAddress: "t1",
    confirmedAtSec: NOW - 86_400,
    ageSec: 86_400,
    cause: "unknown",
    causeDetail: "",
    verdict: "refundable",
    refund: { status: "none", refundTo: null, unlocksAtSec: null, gasFeeSat: null },
    refundableNow: "request",
    refundAddress: "none",
    funding: { kind: "transparent", pools: [] },
    source: "indexer",
    indexerStatus: "Initialised",
    ...over,
  });

  it("totals per chain in coins and USD, pending kept apart from stuck, with the oldest and the ready refunds", () => {
    const rows = [
      row({ amountSat: 100_000_000, ageSec: 40 * 86_400, txid: "01".repeat(32) }),
      row({ amountSat: 50_000_000, cause: "below_minimum", refundableNow: "no", ageSec: 2 * 86_400 }),
      row({ amountSat: 7_000_000, cause: "pending", refundableNow: "no", ageSec: 3_600 }),
      row({ chain: "btc", amountSat: 9_997_900, refund: { status: "ready", refundTo: "bc1q", unlocksAtSec: NOW - 1, gasFeeSat: 5_000 }, refundableNow: "execute", ageSec: 55 * 86_400 }),
      row({ funding: { kind: "shielded", pools: ["Ironwood"] }, refundAddress: "shielded_only", amountSat: 1, ageSec: 200 * 86_400 }),
      row({ amountSat: 40_000, cause: "below_minimum", verdict: "absorbed", refundableNow: "no", source: "unavailable_utxos", ageSec: 4 * 86_400 }),
    ];
    const s = summarize(rows, { btc: 100_000, zcash: 50 });
    expect(s.zcash).toMatchObject({ stuckCount: 4, stuckSat: 150_040_001, absorbedCount: 1, absorbedSat: 40_000, pendingCount: 1, pendingSat: 7_000_000, refundableNowCount: 2, refundableNowSat: 100_000_001, byCause: { unknown: { count: 2, sat: 100_000_001 }, below_minimum: { count: 2, sat: 50_040_000 } }, shieldedFunded: 1, shieldedOnlyRefundAddress: 1 });
    expect(s.zcash.stuckUsd).toBeCloseTo(75.0200005, 6);
    expect(s.zcash.oldest?.ageSec).toBe(200 * 86_400);
    expect(s.btc).toMatchObject({ stuckCount: 1, stuckSat: 9_997_900, readyUnexecuted: 1, readyUnexecutedSat: 9_997_900, refundableNowCount: 1 });
    expect(s.btc.stuckUsd).toBeCloseTo(9_997.9, 6);
  });

  it("buckets ages", () => {
    expect(ageBuckets([3_600, 2 * 86_400, 10 * 86_400, 45 * 86_400, 400 * 86_400])).toEqual({ "<1d": 1, "1-7d": 1, "7-30d": 1, "30-90d": 1, ">90d": 1 });
  });
});

describe("what the scan counts as stuck user money", () => {
  const row = (over: Partial<ScanRow>): ScanRow => ({
    chain: "btc", txid: "t", vout: 0, amountSat: 100_000, depositAddress: "bc1q", confirmedAtSec: NOW - 86_400, ageSec: 86_400,
    cause: "unknown", causeDetail: "", verdict: "refundable", refund: { status: "none", refundTo: null, unlocksAtSec: null, gasFeeSat: null },
    refundableNow: "request", refundAddress: "none", funding: { kind: "transparent", pools: [] }, source: "indexer", indexerStatus: "Initialised",
    ...over,
  });

  it("leaves out a bridge payout that landed on a deposit address, and counts it on its own", () => {
    const s = summarize([row({}), row({ txid: "payout", amountSat: 11_069, bridgePayout: true })], { btc: 80_000, zcash: 1_000 });
    expect(s.btc).toMatchObject({ stuckCount: 1, stuckSat: 100_000, bridgePayoutCount: 1, bridgePayoutSat: 11_069 });
  });

  it("the refund-address column is the deposit message's own, never the refund request's", () => {
    const q = { amountSat: 1, refundAddress: "bc1qrequester", createdAtSec: NOW - 86_400, msgHasRefundAddress: false, executed: false, gasFeeSat: 5_000 };
    const r = scanRow(facts({ request: q }), { state: "requested", refundTo: "bc1qrequester", unlocksAtSec: NOW + 86_400 }, CFG, NOW, { recipientExists: true, source: "refund_request", indexerStatus: null });
    expect(r?.refundAddress).toBe("none");
  });
});
