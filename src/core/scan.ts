// The stuck-money scan, pure part: reading the Omni bridge indexer's transfer pages, why an uncredited deposit is
// stuck, whether it can be refunded now, and the totals. No I/O and no clock: the current time is passed in.

import { refundPath, UTXO_CHAINS, type BtcDepositFacts, type BtcDepositVerdict, type Funding, type RefundConfig, type UtxoChain } from "./btc-refund.js";
import { classifyZcashAddress } from "./zcash-address.js";

/**
 * The indexer pages `/api/v4/transfers` by a MongoDB ObjectId cursor: 4 bytes of insertion time in seconds, then 8
 * bytes that only order records within a second. A cursor of `<seconds>` and zeros starts a walk at that time, so a
 * long range can be read as independent segments.
 */
export const cursorAt = (sec: number): string => Math.floor(sec).toString(16).padStart(8, "0") + "0".repeat(16);
export const cursorTime = (cursor: string): number => parseInt(cursor.slice(0, 8), 16);

export interface Segment {
  fromSec: number;
  toSec: number;
}

export function segments(fromSec: number, toSec: number, stepSec: number): Segment[] {
  const out: Segment[] = [];
  for (let s = fromSec; s < toSec; s += stepSec) out.push({ fromSec: s, toSec: Math.min(s + stepSec, toSec) });
  return out;
}

/** A deposit from Bitcoin or Zcash as the indexer lists it. */
export interface IndexedDeposit {
  chain: UtxoChain;
  txid: string;
  vout: number;
  amountSat: number;
  /** `Finalised` once credited on NEAR; `Initialised` while only seen on the UTXO chain. */
  status: string;
  seenAtSec: number | null;
  recipient: string | null;
}

/**
 * Statuses that mean the deposit was credited on NEAR: `Finalised`; `FinalisedOnNear` (a deposit to `omni.bridge.near`
 * for an onward Omni transfer whose NEAR leg is done; the record carries that NEAR transaction); the fast-finalised
 * pair (a relayer paid the recipient ahead of finalisation); and `Settled`, the v4 terminal state. Only `Initialised`
 * and `Signed` are not credited (bridge-indexer-rs OpenAPI `TransferStatusV4`, read 2026-10-14).
 */
const CREDITED: ReadonlySet<string> = new Set(["Finalised", "FinalisedOnNear", "FastFinalisedOnNear", "FastFinalised", "Settled"]);
export const isCreditedStatus = (status: string): boolean => CREDITED.has(status);

export interface TransfersPage {
  records: number;
  nextCursor: string | null;
  deposits: IndexedDeposit[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ORIGINS: Record<string, UtxoChain> = { Btc: "btc", Zcash: "zcash" };

/** One page of `/api/v4/transfers`; null when the body is not a page (an error message). */
export function parseTransfersPage(body: unknown): TransfersPage | null {
  if (!isObj(body) || !Array.isArray(body["transfers"])) return null;
  const transfers = body["transfers"];
  const deposits: IndexedDeposit[] = [];
  for (const t of transfers) {
    if (!isObj(t) || !isObj(t["transfer_id"])) continue;
    const id = t["transfer_id"];
    const chain = ORIGINS[String(t["origin_chain"])];
    if (id["type"] !== "utxo" || !chain || typeof id["tx_hash"] !== "string") continue;
    const init = isObj(t["initialised"]) ? t["initialised"] : null;
    deposits.push({
      chain,
      txid: id["tx_hash"].toLowerCase(),
      vout: Number(id["vout"]),
      amountSat: Number(t["amount"] ?? 0),
      status: String(t["status"]),
      seenAtSec: init && typeof init["timestamp_seconds"] === "number" ? init["timestamp_seconds"] : null,
      recipient: typeof t["recipient"] === "string" ? t["recipient"] : null,
    });
  }
  const next = body["next_cursor"];
  return { records: transfers.length, nextCursor: transfers.length > 0 && typeof next === "string" ? next : null, deposits };
}

/** Why an uncredited deposit was not credited. */
export type StuckCause = "pending" | "below_minimum" | "bad_message" | "unknown";

/**
 * The likely cause, from the facts the check collected; null when the deposit is not stuck (credited or refunded).
 * `recipientExists`: whether the NEAR account the deposit message names exists (null: not checked).
 */
export function stuckCause(f: BtcDepositFacts, v: BtcDepositVerdict, c: RefundConfig, recipientExists: boolean | null): StuckCause | null {
  if (v.state === "credited" || v.state === "refunded") return null;
  if (v.state === "absorbed") return "below_minimum";
  if (v.state === "unconfirmed" || v.state === "crediting") return "pending";
  if (f.amountSat < c.minDepositSat) return "below_minimum";
  if (!f.msg || recipientExists === false) return "bad_message";
  return "unknown";
}

function causeDetail(f: BtcDepositFacts, v: BtcDepositVerdict, cause: StuckCause, c: RefundConfig, recipientExists: boolean | null): string {
  const unit = UTXO_CHAINS[f.chain].unit;
  if (v.state === "absorbed") return "verified below the minimum into the bridge's unavailable UTXOs: nothing minted, no refund path";
  switch (cause) {
    case "pending":
      return f.confirmedAtSec === null ? "not confirmed yet" : "confirmed less than 6 hours ago";
    case "below_minimum":
      return `${(f.amountSat / 1e8).toFixed(8)} ${unit} is below the ${(c.minDepositSat / 1e8).toFixed(8)} ${unit} minimum deposit`;
    case "bad_message":
      if (!f.msg) return "the indexer has no deposit message that the contract derives this address from";
      return recipientExists === false ? `the deposit message names a NEAR account that does not exist (${f.msg.recipient_id})` : "";
    case "unknown":
      return "confirmed, above the minimum, with a valid deposit message, and still not credited";
  }
}

export type RefundAddressKind = "none" | "transparent" | "shielded_only" | "shielded_and_transparent" | "unpayable";

/** What kind of refund address a deposit names (Bitcoin: always transparent). */
export function refundAddressKind(chain: UtxoChain, address: string | undefined): RefundAddressKind {
  if (!address) return "none";
  if (chain === "btc") return "transparent";
  const a = classifyZcashAddress(address);
  if (!a.valid || a.network !== "main") return "unpayable";
  if (a.refund.shielded) return a.refund.transparent ? "shielded_and_transparent" : "shielded_only";
  return a.refund.transparent ? "transparent" : "unpayable";
}

/** What can be done now: request a refund, execute a ready one, have the bridge sign an executed one, or nothing yet. */
export type RefundableNow = "request" | "execute" | "sign" | "locked" | "no";

export interface ScanRow {
  chain: UtxoChain;
  txid: string;
  vout: number;
  amountSat: number;
  depositAddress: string;
  confirmedAtSec: number | null;
  /** Since confirmation (or since the indexer saw it, for an unconfirmed one); 0 if neither is known. */
  ageSec: number;
  cause: StuckCause;
  causeDetail: string;
  verdict: BtcDepositVerdict["state"];
  refund: { status: "none" | "locked" | "ready" | "executed"; refundTo: string | null; unlocksAtSec: number | null; gasFeeSat: number | null };
  refundableNow: RefundableNow;
  /** The refund address the deposit message itself names ("none": a requester names one, with the longer lock). */
  refundAddress: RefundAddressKind;
  funding: Funding;
  /** How the scan found it: the indexer's list of transfers, the connector's refund requests, or its unavailable UTXOs. */
  source: "indexer" | "refund_request" | "unavailable_utxos";
  indexerStatus: string | null;
  /** The bridge's own payout of a NEAR→chain withdrawal that landed on a deposit address: not a user's deposit. */
  bridgePayout?: boolean;
}

function refundableNow(f: BtcDepositFacts, v: BtcDepositVerdict): RefundableNow {
  switch (v.state) {
    case "ready":
      return refundPath(f.chain, v.refundTo) === "none" ? "no" : "execute";
    case "executed":
      return "sign";
    case "requested":
      return "locked";
    case "refundable":
      if (v.tooSmall) return "no";
      if (v.refundTo !== null && refundPath(f.chain, v.refundTo) === "none") return "no";
      return "request";
    default:
      return "no";
  }
}

export function scanRow(
  f: BtcDepositFacts,
  v: BtcDepositVerdict,
  c: RefundConfig,
  nowSec: number,
  extra: { recipientExists: boolean | null; source: ScanRow["source"]; indexerStatus: string | null; seenAtSec?: number | null; bridgePayout?: boolean },
): ScanRow | null {
  const cause = stuckCause(f, v, c, extra.recipientExists);
  if (cause === null) return null;
  const q = f.request;
  const unlocks = q ? q.createdAtSec + (q.msgHasRefundAddress ? c.refundTimelockSec : c.unsafeRefundTimelockSec) : null;
  const status = !q ? "none" : q.executed ? "executed" : unlocks !== null && nowSec >= unlocks ? "ready" : "locked";
  const since = f.confirmedAtSec ?? extra.seenAtSec ?? null;
  return {
    chain: f.chain,
    txid: f.txid,
    vout: f.vout,
    amountSat: f.amountSat,
    depositAddress: f.depositAddress,
    confirmedAtSec: f.confirmedAtSec,
    ageSec: since === null ? 0 : Math.max(0, nowSec - since),
    cause,
    causeDetail: causeDetail(f, v, cause, c, extra.recipientExists),
    verdict: v.state,
    refund: { status, refundTo: q?.refundAddress ?? null, unlocksAtSec: unlocks, gasFeeSat: q?.gasFeeSat ?? null },
    refundableNow: refundableNow(f, v),
    refundAddress: refundAddressKind(f.chain, f.msg?.refund_address),
    funding: f.funding,
    source: extra.source,
    indexerStatus: extra.indexerStatus,
    ...(extra.bridgePayout ? { bridgePayout: true } : {}),
  };
}

const DAY = 86_400;
export type AgeBucket = "<1d" | "1-7d" | "7-30d" | "30-90d" | ">90d";

export function ageBuckets(ages: number[]): Record<AgeBucket, number> {
  const b: Record<AgeBucket, number> = { "<1d": 0, "1-7d": 0, "7-30d": 0, "30-90d": 0, ">90d": 0 };
  for (const a of ages) b[a < DAY ? "<1d" : a < 7 * DAY ? "1-7d" : a < 30 * DAY ? "7-30d" : a < 90 * DAY ? "30-90d" : ">90d"] += 1;
  return b;
}

export interface ChainSummary {
  /** Uncredited, past the crediting window, not refunded. */
  stuckCount: number;
  stuckSat: number;
  stuckUsd: number;
  /** Uncredited but still inside the crediting window: not counted as stuck. */
  pendingCount: number;
  pendingSat: number;
  byCause: Partial<Record<StuckCause, { count: number; sat: number }>>;
  /** Verified below the minimum into the bridge's unavailable UTXOs: nothing minted, no refund path. Part of stuck. */
  absorbedCount: number;
  absorbedSat: number;
  refundableNowCount: number;
  refundableNowSat: number;
  /** Refund requests past their lock that nobody has executed. */
  readyUnexecuted: number;
  readyUnexecutedSat: number;
  ages: Record<AgeBucket, number>;
  oldest: { txid: string; vout: number; ageSec: number; amountSat: number } | null;
  /** Zcash: stuck deposits funded (wholly or partly) from a shielded pool. */
  shieldedFunded: number;
  /** Zcash: stuck deposits whose refund address has an Orchard receiver and no transparent one. */
  shieldedOnlyRefundAddress: number;
  /** Bridge payouts of NEAR→chain withdrawals that landed on deposit addresses: uncredited, but not user deposits. */
  bridgePayoutCount: number;
  bridgePayoutSat: number;
}

export function summarize(rows: ScanRow[], usd: Record<UtxoChain, number>): Record<UtxoChain, ChainSummary> {
  const one = (chain: UtxoChain): ChainSummary => {
    const all = rows.filter((r) => r.chain === chain);
    const payouts = all.filter((r) => r.bridgePayout === true);
    const stuck = all.filter((r) => r.cause !== "pending" && r.bridgePayout !== true);
    const pending = all.filter((r) => r.cause === "pending");
    const sum = (xs: ScanRow[]): number => xs.reduce((s, r) => s + r.amountSat, 0);
    const byCause: ChainSummary["byCause"] = {};
    for (const r of stuck) {
      const e = (byCause[r.cause] ??= { count: 0, sat: 0 });
      e.count += 1;
      e.sat += r.amountSat;
    }
    const now = stuck.filter((r) => r.refundableNow === "request" || r.refundableNow === "execute" || r.refundableNow === "sign");
    const ready = stuck.filter((r) => r.refund.status === "ready");
    const absorbed = stuck.filter((r) => r.verdict === "absorbed");
    const oldest = stuck.reduce<ScanRow | null>((o, r) => (o === null || r.ageSec > o.ageSec ? r : o), null);
    const stuckSat = sum(stuck);
    return {
      stuckCount: stuck.length,
      stuckSat,
      stuckUsd: (stuckSat / 1e8) * usd[chain],
      pendingCount: pending.length,
      pendingSat: sum(pending),
      byCause,
      absorbedCount: absorbed.length,
      absorbedSat: sum(absorbed),
      refundableNowCount: now.length,
      refundableNowSat: sum(now),
      readyUnexecuted: ready.length,
      readyUnexecutedSat: sum(ready),
      ages: ageBuckets(stuck.map((r) => r.ageSec)),
      oldest: oldest ? { txid: oldest.txid, vout: oldest.vout, ageSec: oldest.ageSec, amountSat: oldest.amountSat } : null,
      shieldedFunded: stuck.filter((r) => r.funding.kind !== "transparent").length,
      shieldedOnlyRefundAddress: stuck.filter((r) => r.refundAddress === "shielded_only").length,
      bridgePayoutCount: payouts.length,
      bridgePayoutSat: sum(payouts),
    };
  };
  return { btc: one("btc"), zcash: one("zcash") };
}
