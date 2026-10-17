// A Bitcoin (or Zcash) deposit into NEAR Intents through the Omni UTXO bridge (`btc-connector.bridge.near`,
// `zcash-connector.bridge.near`: the same Near-One/btc-bridge contract):
// credited, still crediting, or stuck; and for a stuck one, the bridge's own refund (request_refund, a timelock,
// execute_refund, MPC signing) that sends the coin back to the deposit's refund address. Anyone may pay for these
// calls; the contract only ever pays the refund address, so we never need, see or hold a key.

import {
  BRIDGE_CLI_GAS,
  CONNECTOR,
  executeRefundCall,
  formatNear,
  GAS_BUY_PRICE_YOCTO,
  NEAR_CLI_SIGN_IN,
  nearCliCommand,
  PENDING_ID_PLACEHOLDER,
  REFUND_CALL_GAS,
  refundPath,
  SIGNER_PLACEHOLDER,
  signRefundCall,
  upfrontYocto,
  type UtxoChain,
} from "./refund-calls.js";
import { classifyZcashAddress } from "./zcash-address.js";

export { refundPath, type UtxoChain };

/** Each UTXO chain's connector contract and how to name its coin (both count in 1e-8 units). */
export const UTXO_CHAINS: Record<UtxoChain, { connector: string; name: string; unit: string; minor: string }> = {
  btc: { connector: CONNECTOR.btc, name: "Bitcoin", unit: "BTC", minor: "satoshis" },
  zcash: { connector: CONNECTOR.zcash, name: "Zcash", unit: "ZEC", minor: "zatoshis" },
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
  /**
   * Wait when it did not, and the requester named one (gives the bridge time to reject a false claim). 14 days until
   * mid-October 2026, 100 years since: see `unreachableLock`.
   */
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
  /** How many outputs the deposit transaction has: many means a batch payout (an exchange or service paying customers). */
  outputs?: number;
  /** The bridge's record for the deposit address, already checked against the contract; null: not a deposit address. */
  msg: DepositMsg | null;
  /** The coin is in the bridge's own UTXO set (`list_utxos`): it was credited. */
  bridgeHolds: boolean;
  /**
   * The coin is in the bridge's `unavailable_utxos`: the contract verified the deposit but it was below
   * `min_deposit_amount`, so nothing was minted. It is marked verified, which `request_refund` refuses, and no method
   * ever spends or removes it: the deposit is absorbed, with no refund path (btc-bridge v0.9.7-rc3 `deposit.rs`).
   */
  absorbed?: boolean;
  spentBy: { txid: string; inputs: number; paysTo: string[] } | null;
  request: RefundRequestRow | null;
  funding: Funding;
}

export type BtcDepositVerdict =
  | { state: "unconfirmed" }
  | { state: "not_a_deposit" }
  | { state: "credited"; orderAccount: string }
  | { state: "absorbed"; minDepositSat: number }
  /** The deposit message pins the refund to a public example address: the bridge can only refund there. */
  | { state: "placeholder_refund"; refundTo: string }
  /** The chain's light client on NEAR no longer has the deposit's block, so `request_refund` fails (`REQUEST_WINDOW`). */
  | { state: "too_old"; requestBySec: number }
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
      /** The single sender paid a batch of outputs: an exchange's or service's wallet, so the user names their own. */
      batchSender: boolean;
      /** Request before this time, while the chain's light client still has the deposit's block (`REQUEST_WINDOW`). */
      requestBySec: number | null;
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

/** The bridge credits within about an hour of the confirmations it needs; after this a deposit counts as stuck. */
export const STUCK_AFTER_SEC = 6 * 3_600;

/**
 * A NEAR account id the protocol accepts (docs.near.org /web3-apps/tutorials/account-validation, the near-account-id
 * crate): 2 to 64 characters of `a-z`, `0-9` and the separators `.` `-` `_`, never a separator at either end or two in a
 * row. Implicit (64 hex), `0x`/`0s` (40 hex) and `0u` accounts are special cases of the same rule.
 */
export function isNearAccountId(id: string): boolean {
  return /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

/**
 * The NEAR account the deposit was for: the order account inside a 1Click `safe_deposit` message, else the recipient.
 * intents.near reads the message as JSON when it starts with `{` and otherwise as a bare account id
 * (`DepositMessage::from_str`); a message that names no valid account id names nobody.
 */
export function receiverOf(msg: DepositMsg): string {
  const inner = msg.safe_deposit?.msg;
  if (inner !== undefined) {
    let id: unknown = inner;
    if (inner.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(inner);
        id = typeof parsed === "object" && parsed !== null && "receiver_id" in parsed ? parsed.receiver_id : null;
      } catch {
        id = null;
      }
    }
    if (typeof id === "string" && isNearAccountId(id)) return id;
  }
  return msg.recipient_id;
}

/** A refund transaction spends the deposit alone and pays only the refund address. */
const isRefundOf = (spent: NonNullable<BtcDepositFacts["spentBy"]>, refundTo: string | null): boolean =>
  refundTo !== null && spent.inputs === 1 && spent.paysTo.length > 0 && spent.paysTo.every((a) => a === refundTo);

/**
 * A spend of the deposit alone to one address. The bridge spends coins together, with change back to itself; a refund
 * spends one coin to one address. Once a refund finishes the contract deletes its request, so for an address the
 * requester named this shape is all that is left to tell it from a credit.
 */
const loneSpendTo = (spent: NonNullable<BtcDepositFacts["spentBy"]>): string | null => {
  const to = new Set(spent.paysTo);
  return spent.inputs === 1 && to.size === 1 ? (spent.paysTo[0] ?? null) : null;
};

/** A transaction paying more outputs than a payment and its change is a batch: its sender is not the depositor. */
const BATCH_OUTPUTS = 3;
const isBatch = (f: BtcDepositFacts): boolean => f.outputs !== undefined && f.outputs >= BATCH_OUTPUTS;

/**
 * Example addresses from documentation and tutorials. A deposit message that pins its refund to one sends the refund
 * to an address the depositor does not control (bc1qxy2…: 1,142 transactions from unrelated payers, found 2026-10-14).
 */
const PLACEHOLDER_REFUND_ADDRESSES: ReadonlySet<string> = new Set([
  "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
  "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
]);

/**
 * How long a refund can still be requested. `request_refund` proves the deposit against the chain's light client on
 * NEAR (the connector's `btc_light_client_account_id`), which keeps only its last `gc_threshold` blocks and prunes the
 * rest; a request for a deposit whose block is gone fails. btc-client.bridge.near keeps 52,704 blocks (about 366 days
 * at 10 minutes a block); zcash-client.bridge.near keeps 103,680 (90 days at Zcash's 75-second blocks: on 2026-10-14
 * `get_mainchain_size` was 103,680 and `get_block_hash_by_height` had block 3,413,659 and not 3,413,658, with
 * 3,517,338 the newest). A time estimate: `span` is how the reports word it.
 */
export const REQUEST_WINDOW: Record<UtxoChain, { blocks: number; blockSec: number; span: string }> = {
  btc: { blocks: 52_704, blockSec: 600, span: "about a year" },
  zcash: { blocks: 103_680, blockSec: 75, span: "about 90 days" },
};
export const requestWindowSec = (chain: UtxoChain): number => REQUEST_WINDOW[chain].blocks * REQUEST_WINDOW[chain].blockSec;
/** The Bitcoin window alone (kept for existing callers): `requestWindowSec("btc")`. */
export const BTC_REQUEST_WINDOW_SEC = requestWindowSec("btc");

/** Where a refund would go: the request's address, else the deposit's own, else its single sender unless it paid a batch. */
function refundAddressOf(f: BtcDepositFacts): string | null {
  return f.request?.refundAddress ?? f.msg?.refund_address ?? (f.senders.length === 1 && !isBatch(f) ? (f.senders[0] ?? null) : null);
}

/** The bridge took the deposit in: it holds the coin, or it has spent it in a transaction that is not a refund. */
export function isCredited(f: BtcDepositFacts): boolean {
  if (!f.msg || f.absorbed) return false;
  if (f.bridgeHolds) return true;
  return f.spentBy !== null && !isRefundOf(f.spentBy, refundAddressOf(f)) && loneSpendTo(f.spentBy) === null;
}

export function btcDepositVerdict(f: BtcDepositFacts, c: RefundConfig, nowSec: number): BtcDepositVerdict {
  if (f.confirmedAtSec === null) return { state: "unconfirmed" };
  if (f.absorbed) return { state: "absorbed", minDepositSat: c.minDepositSat };
  if (!f.msg) return { state: "not_a_deposit" };
  if (isCredited(f)) return { state: "credited", orderAccount: receiverOf(f.msg) };

  const fromDeposit = f.msg.refund_address ?? null;
  const knownRefundTo = refundAddressOf(f);
  if (f.spentBy) {
    const to = knownRefundTo !== null && isRefundOf(f.spentBy, knownRefundTo) ? knownRefundTo : (loneSpendTo(f.spentBy) ?? knownRefundTo);
    if (to) return { state: "refunded", refundTo: to, refundTx: f.spentBy.txid };
  }
  if (fromDeposit !== null && PLACEHOLDER_REFUND_ADDRESSES.has(fromDeposit) && !f.request) return { state: "placeholder_refund", refundTo: fromDeposit };

  if (f.request) {
    if (f.request.executed) return { state: "executed", refundTo: f.request.refundAddress };
    const unlocks = f.request.createdAtSec + (f.request.msgHasRefundAddress ? c.refundTimelockSec : c.unsafeRefundTimelockSec);
    return nowSec >= unlocks
      ? { state: "ready", refundTo: f.request.refundAddress, unlockedAtSec: unlocks }
      : { state: "requested", refundTo: f.request.refundAddress, unlocksAtSec: unlocks };
  }

  const stuckAfter = f.confirmedAtSec + STUCK_AFTER_SEC;
  if (nowSec < stuckAfter) return { state: "crediting", stuckAfterSec: stuckAfter };
  const requestBySec = f.confirmedAtSec + requestWindowSec(f.chain);
  if (nowSec > requestBySec) return { state: "too_old", requestBySec };
  return {
    state: "refundable",
    refundTo: knownRefundTo,
    refundToFromDeposit: fromDeposit !== null,
    lockSec: fromDeposit !== null ? c.refundTimelockSec : c.unsafeRefundTimelockSec,
    belowMinimum: f.amountSat < c.minDepositSat,
    tooSmall: f.amountSat <= c.refundFeeSat,
    feeSat: c.refundFeeSat,
    noTransparentSender: f.funding.kind === "shielded" && f.senders.length === 0,
    batchSender: fromDeposit === null && f.senders.length === 1 && isBatch(f),
    requestBySec,
  };
}

/**
 * A refund lock nobody can wait out. The connectors lock a refund requested for a deposit that named no refund address
 * for `unsafe_refund_timelock_sec`: 14 days until mid-October 2026, then 3,153,600,000 s, 100 years
 * (btc-connector.bridge.near since 2026-10-16, block 220,227,834; zcash-connector.bridge.near by 2026-10-17). The
 * contract reads the lock from its current config when a refund is executed, and nobody can skip it (Near-One/btc-bridge
 * `satoshi-bridge/src/refund.rs`, `resolve_execute_refund_timelock`), so it holds earlier requests too. A request on
 * such a lock costs its deposit and can never be executed, so no steps are given for it.
 */
export const UNREACHABLE_LOCK_SEC = 10 * 365 * 86_400;
export const unreachableLock = (lockSec: number): boolean => lockSec >= UNREACHABLE_LOCK_SEC;
/** A lock in whole years, for the reports. */
export const lockYears = (lockSec: number): number => Math.round(lockSec / 31_557_600);

export interface RefundStep {
  title: string;
  command?: string;
  note?: string;
}

const days = (sec: number): string => `${Math.round(sec / 86_400)} days`;
const dateOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
/** The request-by sentence (the light client's window). */
const requestBy = (v: Extract<BtcDepositVerdict, { state: "refundable" }>): string =>
  v.requestBySec === null ? "" : ` Request it before about ${dateOf(v.requestBySec)}: after that the bridge's light client no longer has the deposit's block and the request fails.`;

const tgasOf = (gas: bigint): string => `${gas / 10n ** 12n} Tgas`;
/** NEAR to two decimals, for "a little over 1.25 NEAR". */
const aboutNear = (yocto: bigint): string => String(Number((Number(yocto) / 1e24).toFixed(2)));
const gasHeld = (gas: bigint, by: string): string =>
  `${aboutNear(gas * GAS_BUY_PRICE_YOCTO)} NEAR held for ${by}${tgasOf(gas)} of gas (the unused gas comes back when the call finishes)`;
/**
 * What the signing account must hold for a call: the deposit plus the attached gas, which NEAR buys upfront at 0.001
 * NEAR per Tgas (`upfrontYocto`). "A little over": the transaction's own small fees and the account's storage come on top.
 */
const needs = (depositYocto: bigint, gas: bigint, by = ""): string =>
  ` The signing account needs a little over ${aboutNear(upfrontYocto(gas, depositYocto))} NEAR: the ${formatNear(depositYocto)} NEAR and ${gasHeld(gas, by)}.`;
/** The contract checks `attached_deposit >= required` and keeps all of it (3 of 8 recent mainnet executes attached 2 NEAR). */
const attachExactly = (depositYocto: bigint): string =>
  ` Attach exactly ${formatNear(depositYocto)} NEAR, as this command does: the contract keeps all it is given, so anything more is lost.`;
/** Zcash's execute_refund checks in a callback (it needs the light client's height first), after the deposit is taken. */
const zcashChecksLater = (depositYocto: bigint): string =>
  ` On Zcash the contract takes the ${formatNear(depositYocto)} NEAR before it checks the lock and the request, so a call that fails there still costs it: send it once, after the lock has passed.`;
/** The connector's `pending_tx_limits` default: an account holds one refund awaiting its signature at a time. */
const ONE_PENDING = " An account can have only one executed refund waiting for its signature: sign this one (next step) before executing another.";

/** Placeholder for the address a shielded depositor names: we never suggest one. */
export const OWN_UNIFIED_ADDRESS = "<your own unified address (u1…) with an Orchard receiver>";

function executeStep(f: BtcDepositFacts, refundTo: string | null, c: RefundConfig): RefundStep | null {
  const key = `${f.txid}@${f.vout}`;
  const { name } = UTXO_CHAINS[f.chain];
  const fee = c.executeDepositYocto;
  const kept = `${formatNear(fee)} NEAR, not returned`;
  // near-cli sends the same call a wallet would (core/refund-calls.ts): Bitcoin, and a transparent Zcash refund.
  const nearCli = nearCliCommand(executeRefundCall(f.chain, key, fee));
  const afterTaking = f.chain === "zcash" ? zcashChecksLater(fee) : "";
  if (f.chain === "btc") {
    return {
      title: `Execute the refund (${kept})`,
      command: nearCli,
      note: `Anyone can call this once the lock has passed; the contract builds a ${name} transaction that pays only the refund address.${attachExactly(fee)}${needs(fee, REFUND_CALL_GAS)}${ONE_PENDING}`,
    };
  }
  // Zcash. No address yet (a shielded depositor names theirs in the request): plan for the shielded refund.
  const path = refundTo === null ? "shielded" : refundPath(f.chain, refundTo);
  if (path === "none") return null;
  if (path === "transparent") {
    return {
      title: `Execute the refund, transparent (${kept})`,
      command: nearCli,
      note: `Anyone can call this once the lock has passed. It sends no shielded bundle (chain_specific_data null), so the contract pays the refund address one transparent output.${attachExactly(fee)}${afterTaking}${needs(fee, REFUND_CALL_GAS)}${ONE_PENDING}`,
    };
  }
  // A shielded refund needs bridge-cli (btc-execute-refund ships from v0.3.69, already building Ironwood outputs): it
  // builds the bundle, and it attaches the live deposit itself.
  const alsoTransparent = refundTo !== null && classifyZcashAddress(refundTo).refund.transparent;
  return {
    title: `Execute the refund, shielded (${kept})`,
    command: `bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash ${f.txid} --vout ${f.vout}`,
    note:
      "Anyone can call this once the lock has passed. bridge-cli (v0.3.69 or later) builds the shielded bundle, with its zero-knowledge proof, that pays the deposit minus the fee to the address's Orchard receiver; since NU6.3 the refund lands in the Ironwood pool. The contract checks that receiver and that amount before NEAR's MPC network signs the deposit input." +
      (alsoTransparent ? " The address also has a transparent receiver: add --transparent to refund there instead (public)." : "") +
      `${afterTaking}${needs(fee, BRIDGE_CLI_GAS, "bridge-cli's ")}${ONE_PENDING}`,
  };
}

/** The first step whenever there are steps: near-cli signs the execute and the sign as the user's own account. */
function signInStep(steps: RefundStep[]): RefundStep[] {
  if (steps.length === 0) return [];
  const bridgeCli = steps.some((s) => s.command?.startsWith("bridge-cli "));
  return [
    {
      title: "Let near-cli sign as your NEAR account (once)",
      command: NEAR_CLI_SIGN_IN,
      note:
        `Or using-seed-phrase or using-private-key in place of using-web-wallet. Then put your account in place of ${SIGNER_PLACEHOLDER} in the near commands below.` +
        (bridgeCli ? " bridge-cli reads the account and its private key from NEAR_SIGNER and NEAR_PRIVATE_KEY." : ""),
    },
    ...steps,
  ];
}

/**
 * What is left to do, as commands (Near-One/bridge-sdk-rs bridge-cli README, "Refund a never-finalized BTC deposit"):
 * bridge-cli for the request, which needs the deposit's inclusion proof, and for a shielded Zcash execute, which needs
 * the shielded bundle; near-cli for the rest, printed from the calls a wallet would sign (core/refund-calls.ts). Empty
 * when nothing is to be done, when the refund address cannot be told from the transaction (we never suggest any
 * address but the deposit's own or its single sender), when the refund would return nothing, or when its lock is one
 * nobody can wait out (`unreachableLock`).
 */
export function refundSteps(f: BtcDepositFacts, v: BtcDepositVerdict, c: RefundConfig): RefundStep[] {
  return signInStep(stepsLeft(f, v, c));
}

function stepsLeft(f: BtcDepositFacts, v: BtcDepositVerdict, c: RefundConfig): RefundStep[] {
  const { name } = UTXO_CHAINS[f.chain];
  const sign: RefundStep = {
    title: `Have the bridge sign the ${name} refund`,
    command: nearCliCommand(signRefundCall(f.chain, PENDING_ID_PLACEHOLDER)),
    note:
      `Anyone can ask for a refund's signature: NEAR's MPC network signs it and the bridge's relayer then broadcasts it to ${name}. The btc_pending_id is in the execute_refund transaction's logs (its generate_btc_pending_info event, on nearblocks.io).` +
      ` The signing account needs a little over ${aboutNear(upfrontYocto(REFUND_CALL_GAS, 1n))} NEAR, held for ${tgasOf(REFUND_CALL_GAS)} of gas (the unused gas comes back when the call finishes); the 1 yoctoNEAR it attaches goes to NEAR's MPC signer.` +
      ` Or with bridge-cli: bridge-cli mainnet near-sign-btc-transaction --chain ${f.chain} --btc-pending-id ${PENDING_ID_PLACEHOLDER}`,
  };

  if (v.state === "ready") {
    const execute = executeStep(f, v.refundTo, c);
    return execute ? [execute, sign] : [];
  }
  if (v.state === "executed") return [sign];
  if (v.state !== "refundable" || v.tooSmall || unreachableLock(v.lockSec)) return [];
  const fee = c.requestDepositYocto;
  const request = `Request the refund (${formatNear(fee)} NEAR, not returned)`;
  const requestCmd = `bridge-cli mainnet btc-request-refund --chain ${f.chain} --btc-tx-hash ${f.txid} --vout ${f.vout}`;
  // The proof is checked in a callback, against the light client, after the deposit is taken.
  const requestCosts = `${needs(fee, BRIDGE_CLI_GAS, "bridge-cli's ")} The contract takes the ${formatNear(fee)} NEAR before it checks the deposit against its light client, so a request that fails there still costs it.`;
  const wait: RefundStep = { title: `Wait ${days(v.lockSec)} for the timelock` };

  if (v.refundTo === null && v.batchSender) {
    // An exchange or service paid this deposit in a batch: its wallet is not the user's, so the user names their own.
    const own = f.chain === "btc" ? "<your own Bitcoin address>" : "<your own Zcash address>";
    const execute = executeStep(f, null, c);
    return [
      {
        title: `Request the refund to your own address (${formatNear(fee)} NEAR, not returned)`,
        command: `${requestCmd} --refund-address ${own}`,
        note: `This deposit came in a batch payout of ${f.outputs ?? "many"} outputs, so its sender is the wallet of the exchange or service that paid it out, not yours, and the deposit names no refund address. Name an address you control. The contract, and this tool, cannot check that the address is yours: the ${days(v.lockSec)} lock gives the bridge's DAO or operator time to reject a false claim.${requestBy(v)}${requestCosts}`,
      },
      wait,
      ...(execute ? [execute] : []),
      sign,
    ];
  }

  if (v.refundTo === null) {
    // Only a Zcash deposit funded from a shielded pool, with no refund address in it, gets steps without an address:
    // the depositor names their own. Several transparent senders: we cannot tell which is the user's.
    if (!(f.chain === "zcash" && v.noTransparentSender)) return [];
    const execute = executeStep(f, null, c);
    return [
      {
        title: `Request the refund to your own address (${formatNear(fee)} NEAR, not returned)`,
        command: `${requestCmd} --refund-address ${OWN_UNIFIED_ADDRESS}`,
        note:
          "This deposit came from a shielded pool, so it has no transparent sender and names no refund address. Name an address you control, ideally your own unified address with an Orchard receiver so the refund stays shielded (a Sapling-only zs1 address cannot be refunded by this contract). The contract, and this tool, cannot check that the address is yours: the longer lock gives the bridge's DAO or operator time to reject a false claim." +
          requestBy(v) +
          requestCosts,
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
      note:
        (v.refundToFromDeposit
          ? "The deposit itself names the refund address, so the refund can only go there."
          : "The deposit names no refund address: the request names your sending wallet, and the bridge may reject a request it finds suspicious during the lock.") +
        requestBy(v) +
        requestCosts,
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
