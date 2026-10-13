// A Bitcoin (or Zcash) deposit into NEAR Intents through the Omni UTXO bridge (`btc-connector.bridge.near`,
// `zcash-connector.bridge.near`: the same Near-One/btc-bridge contract):
// credited, still crediting, or stuck; and for a stuck one, the bridge's own refund (request_refund, a timelock,
// execute_refund, MPC signing) that sends the coin back to the deposit's refund address. Anyone may pay for these
// calls; the contract only ever pays the refund address, so we never need, see or hold a key.

import { classifyZcashAddress } from "./zcash-address.js";

export type UtxoChain = "btc" | "zcash";

/** Each UTXO chain's connector contract and how to name its coin (both count in 1e-8 units). */
export const UTXO_CHAINS: Record<UtxoChain, { connector: string; name: string; unit: string; minor: string }> = {
  btc: { connector: "btc-connector.bridge.near", name: "Bitcoin", unit: "BTC", minor: "satoshis" },
  zcash: { connector: "zcash-connector.bridge.near", name: "Zcash", unit: "ZEC", minor: "zatoshis" },
};
export const BTC_CONNECTOR = UTXO_CHAINS.btc.connector;

/** The bridge's `DepositMsg`: the deposit address is derived from it. */
export interface DepositMsg {
  recipient_id: string;
  post_actions?: unknown[];
  extra_msg?: string;
  safe_deposit?: { msg: string };
  refund_address?: string;
}

export interface RefundConfig {
  /** Wait after a request when the deposit named its refund address. */
  refundTimelockSec: number;
  /** Wait when it did not, and the requester named one (gives the bridge time to reject a false claim). */
  unsafeRefundTimelockSec: number;
  minDepositSat: number;
  /** The connector's `max_btc_gas_fee`: a withdrawal fee cap (0.01 ZEC on Zcash), and on Bitcoin the refund fee too. */
  maxGasFeeSat: number;
  /** The fee a new refund request stores and later takes from the coin (`get_refund_gas_fee`); see `refundFeeFor`. */
  refundFeeSat: number;
  requestDepositYocto: bigint;
  executeDepositYocto: bigint;
}

export interface RefundRequestRow {
  refundAddress: string;
  amountSat: number;
  createdAtSec: number;
  executed: boolean;
  msgHasRefundAddress: boolean;
  /** The refund fee stored on the request (`gas_fee`): the refund returns `amountSat - gasFeeSat`. */
  gasFeeSat: number;
}

/** Shielded pools a Zcash transaction can draw value from. */
export type ShieldedPool = "Sprout" | "Sapling" | "Orchard" | "Ironwood";

/**
 * Where the deposit's coins came from. `shielded`: no transparent input at all, so there is no transparent sender
 * (z→t). `mixed`: transparent inputs plus value from a shielded pool. Bitcoin is always `transparent`.
 */
export interface Funding {
  kind: "transparent" | "shielded" | "mixed";
  pools: ShieldedPool[];
}

export interface BtcDepositFacts {
  chain: UtxoChain;
  txid: string;
  vout: number;
  amountSat: number;
  depositAddress: string;
  confirmedAtSec: number | null;
  /** Addresses that funded the transaction. */
  senders: string[];
  /** The bridge's record for the deposit address, already checked against the contract; null: not a deposit address. */
  msg: DepositMsg | null;
  /** The coin is in the bridge's own UTXO set: it was credited. */
  bridgeHolds: boolean;
  spentBy: { txid: string; inputs: number; paysTo: string[] } | null;
  request: RefundRequestRow | null;
  funding: Funding;
}

export type BtcDepositVerdict =
  | { state: "unconfirmed" }
  | { state: "not_a_deposit" }
  | { state: "credited"; orderAccount: string }
  | { state: "refunded"; refundTo: string; refundTx: string }
  | { state: "crediting"; stuckAfterSec: number }
  | {
      state: "refundable";
      refundTo: string | null;
      refundToFromDeposit: boolean;
      lockSec: number;
      belowMinimum: boolean;
      /** The deposit does not exceed the refund fee: the contract refuses the request. */
      tooSmall: boolean;
      /** The fee a refund request would store now. */
      feeSat: number;
      /** Funded from a shielded pool only: there is no transparent sender to fall back on. */
      noTransparentSender: boolean;
    }
  | { state: "requested"; refundTo: string; unlocksAtSec: number }
  | { state: "ready"; refundTo: string; unlockedAtSec: number }
  | { state: "executed"; refundTo: string };

/**
 * ZIP-317 conventional fee: 5,000 zatoshis per logical action, at least 2 (the grace actions). Logical actions:
 * max(ceil(transparent input bytes / 150), ceil(transparent output bytes / 34)) + Orchard (or Ironwood) actions.
 * Standard P2PKH inputs (150 bytes) and outputs (34 bytes), as the connector's `zip317_min_fee` counts them.
 */
export function zip317Fee(t: { transparentInputs: number; transparentOutputs: number; orchardActions: number }): number {
  const logical = Math.max(Math.ceil((t.transparentInputs * 150) / 150), Math.ceil((t.transparentOutputs * 34) / 34)) + t.orchardActions;
  return 5_000 * Math.max(2, logical);
}

/**
 * The Zcash connector's default refund fee (`zcash_utils/refund.rs` `get_refund_gas_fee`, v0.9.7-rc.3): the larger
 * ZIP-317 minimum of a transparent refund (1 input, 1 P2PKH output) and a shielded one (1 input, 1 Orchard/Ironwood
 * action, `EXPECTED_ACTIONS_NUMBER`). Both are 10,000 zatoshis. No view method exposes it, so it is computed here.
 */
export const ZCASH_REFUND_FEE_ZAT = Math.max(
  zip317Fee({ transparentInputs: 1, transparentOutputs: 1, orchardActions: 0 }),
  zip317Fee({ transparentInputs: 1, transparentOutputs: 0, orchardActions: 1 }),
);

/** The fee `request_refund` stores when nobody privileged sets one: Bitcoin `max_btc_gas_fee`, Zcash the ZIP-317 minimum. */
export function refundFeeFor(chain: UtxoChain, maxBtcGasFeeSat: number): number {
  return chain === "zcash" ? ZCASH_REFUND_FEE_ZAT : maxBtcGasFeeSat;
}

/**
 * Which refund the connector can build to an address. Bitcoin: always a transparent output. Zcash: `shielded` when
 * it is a unified address with an Orchard receiver (bridge-cli's default Orchard bundle), `transparent` when it is a
 * t-address, a TEX address or a unified address with only a transparent receiver among those two, `none` otherwise
 * (Sapling, Sprout, a unified address with neither, or not a valid address): such a refund can never be executed.
 */
export function refundPath(chain: UtxoChain, address: string): "transparent" | "shielded" | "none" {
  if (chain === "btc") return "transparent";
  const a = classifyZcashAddress(address);
  if (!a.valid || a.network !== "main") return "none";
  return a.refund.shielded ? "shielded" : a.refund.transparent ? "transparent" : "none";
}

/** The bridge credits within about an hour of the confirmations it needs; after this a deposit counts as stuck. */
export const STUCK_AFTER_SEC = 6 * 3_600;

/** The NEAR account the deposit was for: the order account inside a 1Click `safe_deposit` message, else the recipient. */
export function receiverOf(msg: DepositMsg): string {
  if (msg.safe_deposit) {
    try {
      const inner: unknown = JSON.parse(msg.safe_deposit.msg);
      if (typeof inner === "object" && inner !== null && "receiver_id" in inner && typeof inner.receiver_id === "string") return inner.receiver_id;
    } catch {
      // not JSON: fall through to the recipient
    }
  }
  return msg.recipient_id;
}

/** A refund transaction spends the deposit alone and pays only the refund address. */
const isRefundOf = (spent: NonNullable<BtcDepositFacts["spentBy"]>, refundTo: string | null): boolean =>
  refundTo !== null && spent.inputs === 1 && spent.paysTo.length > 0 && spent.paysTo.every((a) => a === refundTo);

/** Where a refund would go: the request's address, else the deposit's own, else its single sender. */
function refundAddressOf(f: BtcDepositFacts): string | null {
  return f.request?.refundAddress ?? f.msg?.refund_address ?? (f.senders.length === 1 ? (f.senders[0] ?? null) : null);
}

/** The bridge took the deposit in: it holds the coin, or it has spent it in a transaction that is not the refund. */
export function isCredited(f: BtcDepositFacts): boolean {
  if (!f.msg) return false;
  if (f.bridgeHolds) return true;
  return f.spentBy !== null && !isRefundOf(f.spentBy, refundAddressOf(f));
}

export function btcDepositVerdict(f: BtcDepositFacts, c: RefundConfig, nowSec: number): BtcDepositVerdict {
  if (f.confirmedAtSec === null) return { state: "unconfirmed" };
  if (!f.msg) return { state: "not_a_deposit" };
  if (isCredited(f)) return { state: "credited", orderAccount: receiverOf(f.msg) };

  const fromDeposit = f.msg.refund_address ?? null;
  const knownRefundTo = refundAddressOf(f);
  if (f.spentBy && knownRefundTo) return { state: "refunded", refundTo: knownRefundTo, refundTx: f.spentBy.txid };

  if (f.request) {
    if (f.request.executed) return { state: "executed", refundTo: f.request.refundAddress };
    const unlocks = f.request.createdAtSec + (f.request.msgHasRefundAddress ? c.refundTimelockSec : c.unsafeRefundTimelockSec);
    return nowSec >= unlocks
      ? { state: "ready", refundTo: f.request.refundAddress, unlockedAtSec: unlocks }
      : { state: "requested", refundTo: f.request.refundAddress, unlocksAtSec: unlocks };
  }

  const stuckAfter = f.confirmedAtSec + STUCK_AFTER_SEC;
  if (nowSec < stuckAfter) return { state: "crediting", stuckAfterSec: stuckAfter };
  return {
    state: "refundable",
    refundTo: knownRefundTo,
    refundToFromDeposit: fromDeposit !== null,
    lockSec: fromDeposit !== null ? c.refundTimelockSec : c.unsafeRefundTimelockSec,
    belowMinimum: f.amountSat < c.minDepositSat,
    tooSmall: f.amountSat <= c.refundFeeSat,
    feeSat: c.refundFeeSat,
    noTransparentSender: f.funding.kind === "shielded" && f.senders.length === 0,
  };
}

export interface RefundStep {
  title: string;
  command?: string;
  note?: string;
}

const near = (yocto: bigint): string => {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
};
const days = (sec: number): string => `${Math.round(sec / 86_400)} days`;

/**
 * The official commands (Near-One/bridge-sdk-rs bridge-cli README, "Refund a never-finalized BTC deposit") for what is
 * left to do. Empty when nothing is to be done, when the refund address cannot be told from the transaction (we never
 * suggest any address but the deposit's own or its single sender), or when the refund would return nothing.
 */
/** Placeholder for the address a shielded depositor names: we never suggest one. */
export const OWN_UNIFIED_ADDRESS = "<your own unified address (u1…) with an Orchard receiver>";

function executeStep(f: BtcDepositFacts, refundTo: string | null, c: RefundConfig): RefundStep | null {
  const key = `${f.txid}@${f.vout}`;
  const { connector, name } = UTXO_CHAINS[f.chain];
  const deposit = `${near(c.executeDepositYocto)} NEAR`;
  if (f.chain === "btc") {
    return {
      title: `Execute the refund (${deposit})`,
      command: `near contract call-function as-transaction ${connector} execute_refund json-args '{"utxo_storage_key":"${key}"}' prepaid-gas '100.0 Tgas' attached-deposit '${deposit}' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
      note: `Anyone can call this once the lock has passed; the contract builds a ${name} transaction that pays only the refund address.`,
    };
  }
  // Zcash. No address yet (a shielded depositor names theirs in the request): plan for the shielded refund.
  const path = refundTo === null ? "shielded" : refundPath(f.chain, refundTo);
  if (path === "none") return null;
  const base = `bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash ${f.txid} --vout ${f.vout}`;
  if (path === "transparent") {
    return {
      title: `Execute the refund, transparent (${deposit})`,
      command: `${base} --transparent`,
      note: "Anyone can call this once the lock has passed. --transparent: the contract pays the refund address with one transparent output (bridge-cli's shielded default would fail: this address has no Orchard receiver).",
    };
  }
  const alsoTransparent = refundTo !== null && classifyZcashAddress(refundTo).refund.transparent;
  return {
    title: `Execute the refund, shielded (${deposit})`,
    command: base,
    note:
      "Anyone can call this once the lock has passed. bridge-cli builds an Orchard bundle, with its zero-knowledge proof, that pays the deposit minus the fee to the address's Orchard receiver; the contract checks that receiver and that amount before NEAR's MPC network signs the deposit input." +
      (alsoTransparent ? " The address also has a transparent receiver: add --transparent to refund there instead (public)." : ""),
  };
}

export function refundSteps(f: BtcDepositFacts, v: BtcDepositVerdict, c: RefundConfig): RefundStep[] {
  const { name } = UTXO_CHAINS[f.chain];
  const sign: RefundStep = {
    title: `Have the bridge sign the ${name} refund`,
    command: `bridge-cli mainnet near-sign-btc-transaction --chain ${f.chain} --btc-pending-id <btc_pending_id from the execute_refund logs>`,
    note: `The bridge's relayer then broadcasts it to ${name}.`,
  };

  if (v.state === "ready") {
    const execute = executeStep(f, v.refundTo, c);
    return execute ? [execute, sign] : [];
  }
  if (v.state === "executed") return [sign];
  if (v.state !== "refundable" || v.tooSmall) return [];
  const request = `Request the refund (${near(c.requestDepositYocto)} NEAR, not returned)`;
  const requestCmd = `bridge-cli mainnet btc-request-refund --chain ${f.chain} --btc-tx-hash ${f.txid} --vout ${f.vout}`;
  const wait: RefundStep = { title: `Wait ${days(v.lockSec)} for the timelock` };

  if (v.refundTo === null) {
    // Only a Zcash deposit funded from a shielded pool, with no refund address in it, gets steps without an address:
    // the depositor names their own. Several transparent senders: we cannot tell which is the user's.
    if (!(f.chain === "zcash" && v.noTransparentSender)) return [];
    const execute = executeStep(f, null, c);
    return [
      {
        title: `Request the refund to your own address (${near(c.requestDepositYocto)} NEAR, not returned)`,
        command: `${requestCmd} --refund-address ${OWN_UNIFIED_ADDRESS}`,
        note:
          "This deposit came from a shielded pool, so it has no transparent sender and names no refund address. Name an address you control, ideally your own unified address with an Orchard receiver so the refund stays shielded (a Sapling-only zs1 address cannot be refunded by this contract). The contract, and this tool, cannot check that the address is yours: the longer lock gives the bridge's DAO or operator time to reject a false claim.",
      },
      wait,
      ...(execute ? [execute] : []),
      sign,
    ];
  }

  const execute = executeStep(f, v.refundTo, c);
  if (!execute) return [];
  const named = v.refundToFromDeposit ? "" : ` --refund-address ${v.refundTo}`;
  return [
    {
      title: request,
      command: `${requestCmd}${named}`,
      note: v.refundToFromDeposit
        ? "The deposit itself names the refund address, so the refund can only go there."
        : "The deposit names no refund address: the request names your sending wallet, and the bridge may reject a request it finds suspicious during the lock.",
    },
    wait,
    execute,
    sign,
  ];
}

export interface BoardRow {
  chain: UtxoChain;
  txid: string;
  vout: number;
  amountSat: number;
  refundTo: string;
  requestedAtSec: number;
  unlocksAtSec: number;
  state: "locked" | "ready" | "executed";
  /** How long it has sat unlocked with nobody executing it (0 while locked or once executed). */
  readyForSec: number;
}

/** Every open refund request on the connectors: ready and unexecuted first, longest wait first; then locked; then executed. */
export function refundBoard(rows: { chain: UtxoChain; key: string; request: RefundRequestRow }[], configs: Record<UtxoChain, RefundConfig>, nowSec: number): BoardRow[] {
  const order = { ready: 0, locked: 1, executed: 2 } as const;
  return rows
    .map(({ chain, key, request: q }): BoardRow => {
      const c = configs[chain];
      const unlocks = q.createdAtSec + (q.msgHasRefundAddress ? c.refundTimelockSec : c.unsafeRefundTimelockSec);
      const state = q.executed ? "executed" : nowSec >= unlocks ? "ready" : "locked";
      const [txid = "", vout = "0"] = key.split("@");
      return { chain, txid, vout: Number(vout), amountSat: q.amountSat, refundTo: q.refundAddress, requestedAtSec: q.createdAtSec, unlocksAtSec: unlocks, state, readyForSec: state === "ready" ? nowSec - unlocks : 0 };
    })
    .sort((a, b) => order[a.state] - order[b.state] || b.readyForSec - a.readyForSec || a.unlocksAtSec - b.unlocksAtSec);
}
