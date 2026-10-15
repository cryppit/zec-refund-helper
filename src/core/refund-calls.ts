// The exact NEAR calls that finish a stuck Bitcoin or Zcash refund once its request exists: `execute_refund` after the
// lock, then `sign_btc_transaction` (Near-One/btc-bridge's connector; both open to anyone for a refund). Pure: no I/O.
// core/btc-refund.ts prints its near-cli commands from these same calls, so the printed steps and a wallet button
// cannot drift apart. The request itself stays with bridge-cli, which builds the deposit's inclusion proof.
//
// A wallet button (the site's /refund page) hands a call to NEAR Connect (`@hot-labs/near-connect`, not
// near-connect-hooks, which defaults to testnet):
//
//   const connector = new NearConnector({ network: "mainnet", features: { signAndSendTransaction: true } });
//   const wallet = await connector.connect();
//   const [call] = refundCalls(facts, verdict, config);   // verdict "ready": execute_refund
//   if (call) await wallet.signAndSendTransaction(walletTransaction(call));
//   // = { receiverId, actions: [{ type: "FunctionCall", params: { methodName, args, gas, deposit } }] }
//
// Before opening the wallet: re-read the config (the deposit must be the live one) and keep {chain, txid, vout, step}
// so a redirecting wallet can resume. After it returns, confirm on chain rather than trusting the wallet: look the hash
// up with EXPERIMENTAL_tx_status and wait_until "FINAL" (core/rpc.ts's nearRpc), decode its NEP-297 event logs
// (the EVENT_JSON: lines in the receipts' logs), and take `pendingIdOf(events, chain)`: the btc_pending_id that the
// sign call needs, from the execute's generate_btc_pending_info event. Then re-run checkBtcDeposit (src/btc-refund.ts):
// it shows REFUND EXECUTED, so `refundCalls(facts, verdict, config, pendingId)` gives sign_btc_transaction, and
// REFUNDED once the refund transaction is on the chain. After a wallet error or a timeout never send again blindly:
// re-check first, the first call may have gone through.

import { classifyZcashAddress } from "./zcash-address.js";

/** The UTXO chains of the Omni bridge's two connectors. */
export type UtxoChain = "btc" | "zcash";

/** Each chain's connector contract on NEAR mainnet: the same Near-One/btc-bridge contract. */
export const CONNECTOR: Record<UtxoChain, string> = { btc: "btc-connector.bridge.near", zcash: "zcash-connector.bridge.near" };

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

/**
 * Gas for both calls: 250 Tgas fits every NEAR Connect wallet, including Ethereum wallets, which cap a call at 270 Tgas,
 * and is far more than the contracts need (at most about 90 Tgas: the sign's MPC call 50 plus its callback 30; a Zcash
 * execute 3 plus a 60 Tgas callback; a Bitcoin execute burns 4 to 6). What is not used comes back.
 */
export const REFUND_CALL_GAS = 250_000_000_000_000n;
/** The gas bridge-cli attaches to its request, execute and sign calls (bridge-sdk-rs `btc.rs`). */
export const BRIDGE_CLI_GAS = 300_000_000_000_000n;
/**
 * yoctoNEAR per gas unit that a call's gas costs upfront: the protocol's minimum gas purchase price, 0.001 NEAR per Tgas
 * (NEP-642, protocol 85; docs.near.org /protocol/transactions/gas: the buy price is "deducted from your account upfront
 * for the gas attached to the transaction"). The unused part comes back when the call finishes.
 */
export const GAS_BUY_PRICE_YOCTO = 1_000_000_000n;
/** sign_btc_transaction attaches 1 yoctoNEAR, which the connector passes on to NEAR's MPC signer (as bridge-cli does). */
export const SIGN_DEPOSIT_YOCTO = 1n;
export const PENDING_ID_PLACEHOLDER = "<btc_pending_id from the execute_refund logs>";
export const SIGNER_PLACEHOLDER = "<your-account.near>";
/** Lets near-cli sign as the user's own account: "import existing account (a.k.a. 'sign in')" (docs.near.org /tools/cli). */
export const NEAR_CLI_SIGN_IN = "near account import-account using-web-wallet network-config mainnet";

/** `chain_specific_data` null: Bitcoin ignores it; on Zcash it means a transparent refund (no Orchard bundle). */
export interface ExecuteRefundArgs {
  utxo_storage_key: string;
  chain_specific_data: null;
}
/** A refund spends one input, so `sign_index` 0; `key_version` 0 as bridge-cli sends it. */
export interface SignBtcTransactionArgs {
  btc_pending_sign_id: string;
  sign_index: number;
  key_version: number;
}
/** One function call, as a wallet signs it: gas in gas units and the deposit in yoctoNEAR, both as strings. */
export type NearCall =
  | { receiverId: string; methodName: "execute_refund"; args: ExecuteRefundArgs; gas: string; deposit: string }
  | { receiverId: string; methodName: "sign_btc_transaction"; args: SignBtcTransactionArgs; gas: string; deposit: string };

/** `execute_refund` for a request whose lock has passed, attaching the connector's `required_balance_for_execute_refund`. */
export function executeRefundCall(chain: UtxoChain, utxoStorageKey: string, executeDepositYocto: bigint): NearCall {
  return {
    receiverId: CONNECTOR[chain],
    methodName: "execute_refund",
    args: { utxo_storage_key: utxoStorageKey, chain_specific_data: null },
    gas: REFUND_CALL_GAS.toString(),
    deposit: executeDepositYocto.toString(),
  };
}

/** `sign_btc_transaction` for an executed refund: NEAR's MPC network signs its one input, then the bridge's relayer broadcasts it. */
export function signRefundCall(chain: UtxoChain, btcPendingId: string): NearCall {
  return {
    receiverId: CONNECTOR[chain],
    methodName: "sign_btc_transaction",
    args: { btc_pending_sign_id: btcPendingId, sign_index: 0, key_version: 0 },
    gas: REFUND_CALL_GAS.toString(),
    deposit: SIGN_DEPOSIT_YOCTO.toString(),
  };
}

/** What `refundCalls` reads: core/btc-refund.ts's BtcDepositFacts, BtcDepositVerdict and RefundConfig fit these. */
export interface CallFacts {
  chain: UtxoChain;
  txid: string;
  vout: number;
}
export interface CallVerdict {
  state: string;
  refundTo?: string | null;
}
export interface CallConfig {
  executeDepositYocto: bigint;
}

/**
 * The calls a wallet can sign for this deposit now: `execute_refund` when the verdict is `ready` (on Zcash only for a
 * transparent refund: a shielded one needs bridge-cli's Orchard bundle), `sign_btc_transaction` when it is `executed`
 * and the execute's btc_pending_id is known (`pendingIdOf`). Nothing otherwise: a request needs bridge-cli's proof.
 */
export function refundCalls(f: CallFacts, v: CallVerdict, c: CallConfig, btcPendingId?: string): NearCall[] {
  if (v.state === "ready" && v.refundTo) {
    return refundPath(f.chain, v.refundTo) === "transparent" ? [executeRefundCall(f.chain, `${f.txid}@${f.vout}`, c.executeDepositYocto)] : [];
  }
  if (v.state === "executed" && btcPendingId) return [signRefundCall(f.chain, btcPendingId)];
  return [];
}

/** The parameter of NEAR Connect's `wallet.signAndSendTransaction`: one transaction with one FunctionCall action. */
export function walletTransaction(call: NearCall): {
  receiverId: string;
  actions: [{ type: "FunctionCall"; params: { methodName: string; args: NearCall["args"]; gas: string; deposit: string } }];
} {
  return { receiverId: call.receiverId, actions: [{ type: "FunctionCall", params: { methodName: call.methodName, args: call.args, gas: call.gas, deposit: call.deposit } }] };
}

/** yoctoNEAR as a NEAR amount: 10^24 is "1", 1.5 * 10^24 is "1.5". */
export function formatNear(yocto: bigint): string {
  const whole = yocto / 10n ** 24n;
  const frac = (yocto % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

const cliGas = (gas: string): string => {
  const g = BigInt(gas);
  return g % 10n ** 12n === 0n ? `${g / 10n ** 12n}.0 Tgas` : `${Number(g) / 1e12} Tgas`;
};
/** near-cli's deposit: whole or few-decimal amounts in NEAR, anything finer (the sign's 1 yocto) in yoctoNEAR. */
const cliDeposit = (deposit: string): string => {
  const d = BigInt(deposit);
  return d % 10n ** 18n === 0n ? `${formatNear(d)} NEAR` : `${d} yoctoNEAR`;
};

/** The call as near-cli's full-form command (docs.near.org /tools/cli), signed by the account near-cli was given. */
export function nearCliCommand(call: NearCall): string {
  return `near contract call-function as-transaction ${call.receiverId} ${call.methodName} json-args '${JSON.stringify(call.args)}' prepaid-gas '${cliGas(call.gas)}' attached-deposit '${cliDeposit(call.deposit)}' sign-as ${SIGNER_PLACEHOLDER} network-config mainnet sign-with-keychain send`;
}

/** What the signing account must hold while a call runs: its deposit plus the attached gas bought upfront (`GAS_BUY_PRICE_YOCTO`). */
export function upfrontYocto(gas: bigint, depositYocto: bigint): bigint {
  return depositYocto + gas * GAS_BUY_PRICE_YOCTO;
}

/** A NEP-297 event as a decoder gives it, from an `EVENT_JSON:` log line. */
export interface BridgeEvent {
  standard: string;
  event: string;
  data: readonly Record<string, unknown>[];
  executor: string;
  failed: boolean;
}

/**
 * The btc_pending_id an execute_refund created: its `generate_btc_pending_info` event (NEP-297 standard "bridge"),
 * printed by the chain's own connector in a receipt that succeeded. Null when the transaction has none.
 */
export function pendingIdOf(events: readonly BridgeEvent[], chain: UtxoChain): string | null {
  for (const e of events) {
    if (e.standard !== "bridge" || e.event !== "generate_btc_pending_info" || e.executor !== CONNECTOR[chain] || e.failed) continue;
    const id = e.data[0]?.["btc_pending_id"];
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}
