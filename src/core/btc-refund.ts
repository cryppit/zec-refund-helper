// A Bitcoin (or Zcash) deposit into NEAR Intents through the Omni UTXO bridge (`btc-connector.bridge.near`,
// `zcash-connector.bridge.near`: the same Near-One/btc-bridge contract):
// credited, still crediting, or stuck; and for a stuck one, the bridge's own refund (request_refund, a timelock,
// execute_refund, MPC signing) that sends the coin back to the deposit's refund address. Anyone may pay for these
// calls; the contract only ever pays the refund address, so we never need, see or hold a key.

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
  /** The Bitcoin fee a refund pays by default, taken from the coin. */
  maxGasFeeSat: number;
  requestDepositYocto: bigint;
  executeDepositYocto: bigint;
}

export interface RefundRequestRow {
  refundAddress: string;
  amountSat: number;
  createdAtSec: number;
  executed: boolean;
  msgHasRefundAddress: boolean;
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
}

export type BtcDepositVerdict =
  | { state: "unconfirmed" }
  | { state: "not_a_deposit" }
  | { state: "credited"; orderAccount: string }
  | { state: "refunded"; refundTo: string; refundTx: string }
  | { state: "crediting"; stuckAfterSec: number }
  | { state: "refundable"; refundTo: string | null; refundToFromDeposit: boolean; lockSec: number; belowMinimum: boolean; tooSmall: boolean }
  | { state: "requested"; refundTo: string; unlocksAtSec: number }
  | { state: "ready"; refundTo: string; unlockedAtSec: number }
  | { state: "executed"; refundTo: string };

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
    tooSmall: f.amountSat <= c.maxGasFeeSat,
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
export function refundSteps(f: BtcDepositFacts, v: BtcDepositVerdict, c: RefundConfig): RefundStep[] {
  const key = `${f.txid}@${f.vout}`;
  const { connector, name } = UTXO_CHAINS[f.chain];
  const execute: RefundStep = {
    title: `Execute the refund (${near(c.executeDepositYocto)} NEAR)`,
    command: `near contract call-function as-transaction ${connector} execute_refund json-args '{"utxo_storage_key":"${key}"}' prepaid-gas '100.0 Tgas' attached-deposit '${near(c.executeDepositYocto)} NEAR' sign-as <your-account.near> network-config mainnet sign-with-keychain send`,
    note: `Anyone can call this once the lock has passed; the contract builds a ${name} transaction that pays only the refund address.`,
  };
  const sign: RefundStep = {
    title: `Have the bridge sign the ${name} refund`,
    command: `bridge-cli mainnet near-sign-btc-transaction --chain ${f.chain} --btc-pending-id <btc_pending_id from the execute_refund logs>`,
    note: `The bridge's relayer then broadcasts it to ${name}.`,
  };

  if (v.state === "ready") return [execute, sign];
  if (v.state === "executed") return [sign];
  if (v.state !== "refundable" || v.refundTo === null || v.tooSmall) return [];

  const named = v.refundToFromDeposit ? "" : ` --refund-address ${v.refundTo}`;
  return [
    {
      title: `Request the refund (${near(c.requestDepositYocto)} NEAR, not returned)`,
      command: `bridge-cli mainnet btc-request-refund --chain ${f.chain} --btc-tx-hash ${f.txid} --vout ${f.vout}${named}`,
      note: v.refundToFromDeposit
        ? "The deposit itself names the refund address, so the refund can only go there."
        : "The deposit names no refund address: the request names your sending wallet, and the bridge may reject a request it finds suspicious during the lock.",
    },
    { title: `Wait ${days(v.lockSec)} for the timelock` },
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
