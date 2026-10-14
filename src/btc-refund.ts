// Check a Bitcoin or Zcash deposit into NEAR Intents (Omni UTXO bridge) from the user's own transaction hash, and for a
// stuck one the bridge's refund steps. Keyless sources: mempool.space (Bitcoin) or Blockchair (Zcash) for the transaction
// and whether its coin was spent; the Omni bridge indexer for the deposit message behind the deposit address (what
// bridge-cli's `btc-request-refund` asks); the chain's connector contract over FastNEAR RPC for the deposit address that
// message really derives, the refund request, whether the bridge holds the coin, and the live timelocks and fees.
// Blockchair's and the indexer's terms are not yet reviewed. We only read; we never sign.

import {
  type BoardRow,
  btcDepositVerdict,
  refundBoard,
  receiverOf,
  refundSteps,
  type BtcDepositFacts,
  type BtcDepositVerdict,
  type DepositMsg,
  type Funding,
  refundFeeFor,
  type RefundConfig,
  type RefundRequestRow,
  type RefundStep,
  type ShieldedPool,
  UTXO_CHAINS,
  type UtxoChain,
} from "./core/btc-refund.js";
import { nearRpc, type RpcEvent } from "./core/rpc.js";

export interface BtcTx {
  confirmedAtSec: number | null;
  outputs: { address: string | null; valueSat: number }[];
  senders: string[];
  inputs: number;
  /** Where the coins came from (Zcash: transparent inputs and/or a shielded pool). */
  funding: Funding;
}

export interface BtcRefundClient {
  readonly chain: UtxoChain;
  tx(txid: string): Promise<BtcTx | null>;
  /** The same, plus where its coins came from (Zcash: one more read, for the shielded pools). */
  depositTx(txid: string): Promise<BtcTx | null>;
  /** The transaction that spent this output, if any. */
  spentBy(txid: string, vout: number): Promise<string | null>;
  /** The bridge indexer's deposit message for a deposit address; null: not a deposit address it tracks. */
  depositMsg(address: string): Promise<DepositMsg | null>;
  /** The deposit address the contract derives from a message. */
  depositAddress(msg: DepositMsg): Promise<string>;
  /** The coin is in the bridge's UTXO set (credited). */
  bridgeHolds(utxoKey: string): Promise<boolean>;
  /** The coin is in the bridge's `unavailable_utxos` (verified below the minimum: nothing minted, no refund path). */
  bridgeAbsorbed(utxoKey: string): Promise<boolean>;
  refundRequest(utxoKey: string): Promise<RefundRequestRow | null>;
  /** Every refund request the connector holds. */
  refundRequests(): Promise<{ key: string; request: RefundRequestRow }[]>;
  /** Every coin in the connector's `unavailable_utxos` (deposits verified below the minimum), all time. */
  unavailableUtxos(): Promise<{ key: string; balanceSat: number }[]>;
  config(): Promise<RefundConfig>;
}

const MEMPOOL = "https://mempool.space/api";
const BLOCKCHAIR = "https://api.blockchair.com/zcash/dashboards/transaction/";
const BLOCKCHAIR_RAW = "https://api.blockchair.com/zcash/raw/transaction/";
const INDEXER = "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN);

/** A stored request keeps its deposit message as a JSON string; the lock it gets depends on this field. */
function hasRefundAddress(depositMsgJson: unknown): boolean {
  try {
    const m: unknown = JSON.parse(String(depositMsgJson));
    return isObj(m) && typeof m["refund_address"] === "string";
  } catch {
    return false;
  }
}

/** A JSON-RPC caller: posts a request body, returns the parsed response (see core/rpc.ts). */
export type RpcCall = (body: unknown) => Promise<unknown>;

/** The live NEAR RPC: every provider in NEAR_RPC_PROVIDERS, retried with backoff on the wall clock, at most ~8 s of waiting. */
export function liveNearRpc(fetchImpl: typeof fetch = fetch, onEvent?: (e: RpcEvent) => void, providers?: readonly string[]): RpcCall {
  return nearRpc({ providers, fetch: fetchImpl, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random, onEvent });
}

/** Every UTXO chain we check, Bitcoin first: a hash is looked up on each in turn. */
export const publicUtxoRefundClients = (fetchImpl: typeof fetch = fetch, rpc: RpcCall | string = liveNearRpc(fetchImpl)): BtcRefundClient[] => [
  publicBtcRefundClient(fetchImpl, rpc, "btc"),
  publicBtcRefundClient(fetchImpl, rpc, "zcash"),
];

/** `rpc` is a caller, or one provider URL (still retried, no fallback). */
export function publicBtcRefundClient(fetchImpl: typeof fetch = fetch, rpc: RpcCall | string = liveNearRpc(fetchImpl), chain: UtxoChain = "btc"): BtcRefundClient {
  const connector = UTXO_CHAINS[chain].connector;
  const call: RpcCall = typeof rpc === "string" ? liveNearRpc(fetchImpl, undefined, [rpc]) : rpc;
  async function getJson(url: string): Promise<unknown | null> {
    const res = await fetchImpl(url);
    if (res.status === 404 || res.status === 400) return null;
    if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
    return res.json() as Promise<unknown>;
  }

  async function view(method: string, args: unknown): Promise<unknown> {
    const body = await call({
      jsonrpc: "2.0",
      id: 1,
      method: "query",
      params: { request_type: "call_function", finality: "final", account_id: connector, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    });
    const result = isObj(body) && isObj(body["result"]) ? body["result"]["result"] : null;
    if (!Array.isArray(result)) throw new Error(`NEAR RPC: ${method} failed`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(result as number[])));
  }

  async function mempoolTx(txid: string): Promise<BtcTx | null> {
    const tx = await getJson(`${MEMPOOL}/tx/${txid}`);
    if (!isObj(tx)) return null;
    const status = isObj(tx["status"]) ? tx["status"] : {};
    const senders: string[] = [];
    for (const i of arr(tx["vin"])) {
      const a = isObj(i) && isObj(i["prevout"]) ? str(i["prevout"]["scriptpubkey_address"]) : null;
      if (a && !senders.includes(a)) senders.push(a);
    }
    return {
      confirmedAtSec: status["confirmed"] === true && typeof status["block_time"] === "number" ? status["block_time"] : null,
      outputs: arr(tx["vout"]).map((o) => ({ address: isObj(o) ? str(o["scriptpubkey_address"]) : null, valueSat: isObj(o) ? num(o["value"]) : 0 })),
      senders,
      inputs: arr(tx["vin"]).length,
      funding: { kind: "transparent", pools: [] },
    };
  }

  /** Blockchair's transaction dashboard: inputs with their addresses, outputs with who spent them. */
  async function blockchairDashboard(txid: string): Promise<Record<string, unknown> | null> {
    const body = await getJson(`${BLOCKCHAIR}${txid}`);
    const data = isObj(body) ? body["data"] : null;
    return isObj(data) && isObj(data[txid]) ? (data[txid] as Record<string, unknown>) : null;
  }

  /**
   * Which shielded pools paid into the transaction. Blockchair's dashboard has Sprout (`join_split_raw`) and Sapling
   * (`shielded_value_delta`, `shielded_input_raw`) but no Orchard or Ironwood fields (a v5/v6 transaction funded from
   * Orchard or Ironwood shows 0 inputs, 0 fee and a 0 delta there), so we read the node's decoded transaction too: the
   * value balance of each pool (positive: value leaving that pool into the transparent outputs) and Sprout's vpub_new.
   */
  async function shieldedPools(txid: string, dashboard: Record<string, unknown>): Promise<ShieldedPool[]> {
    const pools = new Set<ShieldedPool>();
    const body = await getJson(`${BLOCKCHAIR_RAW}${txid}`).catch(() => null);
    const data = isObj(body) && isObj(body["data"]) ? body["data"][txid] : null;
    const raw = isObj(data) && isObj(data["decoded_raw_transaction"]) ? data["decoded_raw_transaction"] : null;
    if (raw) {
      if (arr(raw["vjoinsplit"]).some((j) => isObj(j) && num(j["vpub_newZat"] ?? j["vpub_new"]) > 0)) pools.add("Sprout");
      if (num(raw["valueBalanceZat"]) > 0) pools.add("Sapling");
      for (const [key, pool] of [["orchard", "Orchard"], ["ironwood", "Ironwood"]] as const) {
        const b = raw[key];
        if (isObj(b) && num(b["valueBalanceZat"]) > 0) pools.add(pool);
      }
    }
    const t = isObj(dashboard["transaction"]) ? dashboard["transaction"] : {};
    if (arr(t["join_split_raw"]).length > 0) pools.add("Sprout");
    if (num(t["shielded_value_delta"]) > 0 || arr(t["shielded_input_raw"]).length > 0) pools.add("Sapling");
    const order: ShieldedPool[] = ["Sprout", "Sapling", "Orchard", "Ironwood"];
    return order.filter((p) => pools.has(p));
  }

  async function blockchairTx(txid: string, withFunding = false): Promise<BtcTx | null> {
    const d = await blockchairDashboard(txid);
    const t = d && isObj(d["transaction"]) ? d["transaction"] : null;
    if (!d || !t) return null;
    const senders: string[] = [];
    for (const i of arr(d["inputs"])) {
      const a = isObj(i) ? str(i["recipient"]) : null;
      if (a && !senders.includes(a)) senders.push(a);
    }
    const outputs = arr(d["outputs"])
      .filter(isObj)
      .sort((a, b) => num(a["index"]) - num(b["index"]))
      .map((o) => ({ address: str(o["recipient"]), valueSat: num(o["value"]) }));
    const time = str(t["time"]);
    const inputs = num(t["input_count"]);
    let funding: Funding = { kind: "transparent", pools: [] };
    if (withFunding && t["is_coinbase"] !== true) {
      const pools = await shieldedPools(txid, d);
      // No transparent input and not a coinbase: the value can only have come out of a shielded pool.
      if (inputs === 0) funding = { kind: "shielded", pools };
      else if (pools.length > 0) funding = { kind: "mixed", pools };
    }
    return {
      confirmedAtSec: num(t["block_id"]) > 0 && time ? Date.parse(`${time.replace(" ", "T")}Z`) / 1000 : null,
      outputs,
      senders,
      inputs,
      funding,
    };
  }

  async function blockchairSpentBy(txid: string, vout: number): Promise<string | null> {
    const d = await blockchairDashboard(txid);
    const o = arr(d?.["outputs"]).find((x) => isObj(x) && num(x["index"]) === vout);
    return isObj(o) && o["is_spent"] === true ? str(o["spending_transaction_hash"]) : null;
  }

  async function allRequests(): Promise<{ key: string; request: RefundRequestRow }[]> {
    const PAGE = 100;
    const out: { key: string; request: RefundRequestRow }[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await view("get_refund_requests_paged", { from_index: from, limit: PAGE });
      if (!isObj(page)) return out;
      for (const [key, r] of Object.entries(page)) {
        if (!isObj(r)) continue;
        out.push({
          key,
          request: {
            refundAddress: String(r["refund_address"]),
            amountSat: num(r["amount"]),
            createdAtSec: num(r["created_at_sec"]),
            executed: r["executed"] === true,
            msgHasRefundAddress: hasRefundAddress(r["deposit_msg_json"]),
            gasFeeSat: num(r["gas_fee"]),
          },
        });
      }
      if (Object.keys(page).length < PAGE) return out;
    }
  }

  async function allUnavailable(): Promise<{ key: string; balanceSat: number }[]> {
    const PAGE = 200;
    const out: { key: string; balanceSat: number }[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = await view("get_unavailable_utxos_paged", { from_index: from, limit: PAGE });
      if (!isObj(page)) return out;
      for (const [key, u] of Object.entries(page)) if (isObj(u)) out.push({ key, balanceSat: num(u["balance"]) });
      if (Object.keys(page).length < PAGE) return out;
    }
  }

  return {
    chain,
    unavailableUtxos: allUnavailable,
    tx: chain === "btc" ? mempoolTx : (txid) => blockchairTx(txid),
    depositTx: chain === "btc" ? mempoolTx : (txid) => blockchairTx(txid, true),
    async spentBy(txid, vout) {
      if (chain === "zcash") return blockchairSpentBy(txid, vout);
      const o = await getJson(`${MEMPOOL}/tx/${txid}/outspend/${vout}`);
      return isObj(o) && o["spent"] === true ? str(o["txid"]) : null;
    },
    async depositMsg(address) {
      const m = await getJson(`${INDEXER}?chain=${chain}&address=${encodeURIComponent(address)}`);
      return isObj(m) && typeof m["recipient_id"] === "string" ? (m as unknown as DepositMsg) : null;
    },
    async depositAddress(msg) {
      return String(await view("get_user_deposit_address", { deposit_msg: msg }));
    },
    async bridgeHolds(key) {
      const held = await view("list_utxos", { utxo_storage_keys: [key] });
      return isObj(held) && held[key] != null;
    },
    async bridgeAbsorbed(key) {
      const unavailable = await view("list_unavailable_utxos", { utxo_storage_keys: [key] });
      return isObj(unavailable) && unavailable[key] != null;
    },
    refundRequests: allRequests,
    async refundRequest(key) {
      return (await allRequests()).find((r) => r.key === key)?.request ?? null;
    },
    async config() {
      const [c, request, execute] = await Promise.all([view("get_config", {}), view("required_balance_for_request_refund", {}), view("required_balance_for_execute_refund", {})]);
      if (!isObj(c)) throw new Error("NEAR RPC: get_config returned nothing");
      return {
        refundTimelockSec: num(c["refund_timelock_sec"]),
        unsafeRefundTimelockSec: num(c["unsafe_refund_timelock_sec"]),
        minDepositSat: num(c["min_deposit_amount"]),
        maxGasFeeSat: num(c["max_btc_gas_fee"]),
        refundFeeSat: refundFeeFor(chain, num(c["max_btc_gas_fee"])),
        requestDepositYocto: BigInt(String(request)),
        executeDepositYocto: BigInt(String(execute)),
      };
    },
  };
}

export type BtcDepositReport =
  | { facts: BtcDepositFacts; verdict: BtcDepositVerdict; steps: RefundStep[]; config: RefundConfig; orderAccount: string | null }
  | { error: string };

/** Which output is the bridge deposit: the one whose address the indexer knows and the contract confirms. */
async function findDeposit(tx: BtcTx, client: BtcRefundClient, vout?: number): Promise<{ vout: number; msg: DepositMsg | null }> {
  const candidates = vout !== undefined ? [vout] : tx.outputs.map((_, i) => i);
  for (const i of candidates) {
    const address = tx.outputs[i]?.address;
    if (!address) continue;
    const msg = await client.depositMsg(address);
    if (msg && (await client.depositAddress(msg)) === address) return { vout: i, msg };
  }
  return { vout: vout ?? 0, msg: null };
}

/** The first chain that knows the hash, with its transaction. */
async function locate(txid: string, clients: BtcRefundClient[]): Promise<{ client: BtcRefundClient; tx: BtcTx } | null> {
  for (const client of clients) {
    const tx = await client.depositTx(txid).catch(() => null);
    if (tx) return { client, tx };
  }
  return null;
}

const chainNames = (clients: BtcRefundClient[]): string => clients.map((c) => UTXO_CHAINS[c.chain].name).join(" or ");

/** What the chain, the bridge indexer and the connector say about a Bitcoin or Zcash deposit; no verdict yet. */
export async function btcDepositFacts(raw: string, clients: BtcRefundClient | BtcRefundClient[], vout?: number): Promise<{ facts: BtcDepositFacts; client: BtcRefundClient } | { error: string }> {
  const list = Array.isArray(clients) ? clients : [clients];
  const txid = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) return { error: `not a ${chainNames(list)} transaction hash (64 hex characters)` };
  const found0 = await locate(txid, list);
  if (!found0) return { error: `no ${chainNames(list)} transaction with this hash` };
  const { client, tx } = found0;
  if (vout !== undefined && !tx.outputs[vout]) return { error: `the transaction has no output ${vout}` };

  const found = await findDeposit(tx, client, vout);
  const key = `${txid}@${found.vout}`;
  const out = tx.outputs[found.vout];
  const [held, absorbed, spender, request] = await Promise.all([
    found.msg ? client.bridgeHolds(key) : Promise.resolve(false),
    found.msg ? client.bridgeAbsorbed(key) : Promise.resolve(false),
    found.msg ? client.spentBy(txid, found.vout) : Promise.resolve(null),
    found.msg ? client.refundRequest(key) : Promise.resolve(null),
  ]);
  const spendTx = spender ? await client.tx(spender) : null;

  const facts: BtcDepositFacts = {
    chain: client.chain,
    txid,
    vout: found.vout,
    amountSat: out?.valueSat ?? 0,
    depositAddress: out?.address ?? "",
    confirmedAtSec: tx.confirmedAtSec,
    senders: tx.senders,
    outputs: tx.outputs.length,
    msg: found.msg,
    bridgeHolds: held,
    absorbed,
    spentBy: spender ? { txid: spender, inputs: spendTx?.inputs ?? 0, paysTo: (spendTx?.outputs ?? []).flatMap((o) => (o.address ? [o.address] : [])) } : null,
    request,
    funding: tx.funding,
  };
  return { facts, client };
}

export async function checkBtcDeposit(raw: string, clients: BtcRefundClient | BtcRefundClient[], nowSec: number, vout?: number): Promise<BtcDepositReport> {
  const r = await btcDepositFacts(raw, clients, vout);
  if ("error" in r) return r;
  const { facts } = r;
  const config = await r.client.config();
  const verdict = btcDepositVerdict(facts, config, nowSec);
  return { facts, verdict, steps: refundSteps(facts, verdict, config), config, orderAccount: facts.msg ? receiverOf(facts.msg) : null };
}

/** The public stuck-money board: every refund request on every connector, from the contracts alone. */
export async function checkRefundBoard(clients: BtcRefundClient[], nowSec: number): Promise<BoardRow[]> {
  const per = await Promise.all(clients.map(async (c) => ({ chain: c.chain, config: await c.config(), requests: await c.refundRequests() })));
  const configs = Object.fromEntries(per.map((p) => [p.chain, p.config])) as Record<UtxoChain, RefundConfig>;
  return refundBoard(
    per.flatMap((p) => p.requests.map((r) => ({ chain: p.chain, ...r }))),
    configs,
    nowSec,
  );
}
