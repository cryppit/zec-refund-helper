// The stuck-money scan: every Bitcoin and Zcash deposit the Omni bridge indexer has seen, which of them were never
// credited on NEAR, why, and whether they can be refunded now; plus every refund request on both connectors.
//
// Enumeration: the indexer's public transfer list (`/api/v4/transfers`, cursor-paged, read in parallel time segments)
// is the only public list of deposits to the bridge's per-user deposit addresses. Each deposit that is not
// `Finalised` there, and each deposit with a refund request on a connector, is then checked against the chain and the
// connector contract itself with the same code as `zec-refund <txid>`. Read-only: public GET requests and NEAR view calls.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { btcDepositFacts, publicBtcRefundClient, type BtcRefundClient } from "./btc-refund.js";
import { btcDepositVerdict, UTXO_CHAINS, type BtcDepositFacts, type RefundConfig, type RefundRequestRow, type UtxoChain } from "./core/btc-refund.js";
import { cursorAt, cursorTime, isCreditedStatus, parseTransfersPage, scanRow, segments, summarize, type ChainSummary, type IndexedDeposit, type ScanRow, type Segment } from "./core/scan.js";

export const INDEXER_API = "https://mainnet.api.bridge.nearone.org";
export const NEAR_RPC = "https://rpc.mainnet.fastnear.com";
export const PRICE_API = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,zcash&vs_currencies=usd&include_last_updated_at=true";
/** The first record in the indexer's v4 transfer list (cursor 0): 2026-06-25 14:37 UTC. Nothing older is listed. */
export const INDEX_FIRST_RECORD_SEC = 1_782_395_865;

const CHAIN_PARAM: Record<UtxoChain, string> = { btc: "Btc", zcash: "Zcash" };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PacingOptions {
  /** Minimum gap between two requests to the same host, in ms. */
  intervalMs?: Record<string, number>;
  defaultIntervalMs?: number;
  retries?: number;
  /** Keep each response for the rest of the run (GET by URL, POST by URL and body). */
  cache?: boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (url: string, attempt: number, why: string) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A polite fetch: requests to one host are spaced out, 429 / 5xx / network errors are retried with exponential
 * backoff (or the server's Retry-After), and with `cache` each answer is reused within the run.
 */
export function pacedFetch(base: typeof fetch, o: PacingOptions = {}): typeof fetch {
  const sleep = o.sleep ?? realSleep;
  const retries = o.retries ?? 5;
  const nextSlot = new Map<string, number>();
  const cache = new Map<string, Promise<{ status: number; body: string; type: string }>>();
  let clock = 0;
  const now = (): number => (o.sleep ? clock : Date.now());

  async function slot(host: string): Promise<void> {
    const gap = o.intervalMs?.[host] ?? o.defaultIntervalMs ?? 0;
    const at = Math.max(now(), nextSlot.get(host) ?? 0);
    nextSlot.set(host, at + gap);
    const wait = at - now();
    if (wait > 0) {
      await sleep(wait);
      if (o.sleep) clock += wait;
    }
  }

  async function once(input: string, init?: RequestInit): Promise<{ status: number; body: string; type: string }> {
    const host = new URL(input).host;
    for (let attempt = 0; ; attempt++) {
      await slot(host);
      let why: string;
      let retryAfterMs: number | null = null;
      try {
        const res = await base(input, init);
        if (res.status !== 429 && res.status < 500) return { status: res.status, body: await res.text(), type: res.headers.get("content-type") ?? "application/json" };
        why = `HTTP ${res.status}`;
        const ra = Number(res.headers.get("retry-after"));
        if (Number.isFinite(ra) && ra > 0) retryAfterMs = ra * 1000;
        await res.text().catch(() => "");
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      if (attempt >= retries) throw new Error(`${host}: ${why} after ${retries + 1} attempts`);
      o.onRetry?.(input, attempt + 1, why);
      const backoff = retryAfterMs ?? 2_000 * 2 ** attempt;
      await sleep(backoff);
      if (o.sleep) clock += backoff;
    }
  }

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = `${init?.method ?? "GET"} ${url} ${typeof init?.body === "string" ? init.body : ""}`;
    let p = o.cache ? cache.get(key) : undefined;
    if (!p) {
      p = once(url, init);
      if (o.cache) {
        cache.set(key, p);
        p.catch(() => cache.delete(key));
      }
    }
    const r = await p;
    return new Response(r.body, { status: r.status, headers: { "content-type": r.type } });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------------
// Phase 1: the indexer walk.

export interface ChainCounts {
  deposits: number;
  /** Credited on NEAR per the indexer: `Finalised` or `FinalisedOnNear`. */
  finalised: number;
  sat: number;
}

/** One time segment of the walk. Pages inside it are counted; its first and last page are kept whole so that the one
 *  page two neighbouring segments share is counted once. */
export interface SegmentResult {
  segment: Segment;
  pages: number;
  records: number;
  middle: Record<UtxoChain, ChainCounts>;
  /** Deposits on middle pages that are not credited (see `isCreditedStatus`). */
  open: IndexedDeposit[];
  edges: IndexedDeposit[];
}

export interface WalkResult {
  fromSec: number;
  toSec: number;
  pages: number;
  records: number;
  seen: Record<UtxoChain, ChainCounts>;
  /** Every deposit the indexer lists as not credited (neither `Finalised` nor `FinalisedOnNear`). */
  open: IndexedDeposit[];
}

const zero = (): Record<UtxoChain, ChainCounts> => ({ btc: { deposits: 0, finalised: 0, sat: 0 }, zcash: { deposits: 0, finalised: 0, sat: 0 } });
const keyOf = (d: { chain: UtxoChain; txid: string; vout: number }): string => `${d.chain}:${d.txid}@${d.vout}`;

export async function walkSegment(f: typeof fetch, seg: Segment, onPage?: () => void): Promise<SegmentResult> {
  const r: SegmentResult = { segment: seg, pages: 0, records: 0, middle: zero(), open: [], edges: [] };
  let cursor = cursorAt(seg.fromSec);
  for (;;) {
    const res = await f(`${INDEXER_API}/api/v4/transfers?limit=50&cursor=${cursor}`);
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      // an error message, handled below
    }
    const page = parseTransfersPage(body);
    if (!page) throw new Error(`indexer: ${text.slice(0, 120)}`);
    r.pages += 1;
    r.records += page.records;
    onPage?.();
    const last = page.nextCursor === null || cursorTime(page.nextCursor) >= seg.toSec;
    if (r.pages === 1 || last) r.edges.push(...page.deposits);
    else {
      for (const d of page.deposits) {
        const c = r.middle[d.chain];
        c.deposits += 1;
        c.sat += d.amountSat;
        if (isCreditedStatus(d.status)) c.finalised += 1;
        else r.open.push(d);
      }
    }
    if (last || page.nextCursor === null) return r;
    cursor = page.nextCursor;
  }
}

export function mergeSegments(results: SegmentResult[]): WalkResult {
  const seen = zero();
  const open = new Map<string, IndexedDeposit>();
  const edges = new Map<string, IndexedDeposit>();
  let pages = 0;
  let records = 0;
  for (const r of results) {
    pages += r.pages;
    records += r.records;
    for (const chain of ["btc", "zcash"] as const) {
      seen[chain].deposits += r.middle[chain].deposits;
      seen[chain].finalised += r.middle[chain].finalised;
      seen[chain].sat += r.middle[chain].sat;
    }
    for (const d of r.open) {
      // A segment cached before `FinalisedOnNear` counted as credited keeps those deposits here.
      if (isCreditedStatus(d.status)) seen[d.chain].finalised += 1;
      else open.set(keyOf(d), d);
    }
    for (const d of r.edges) edges.set(keyOf(d), d);
  }
  for (const [k, d] of edges) {
    if (open.has(k)) continue;
    const c = seen[d.chain];
    c.deposits += 1;
    c.sat += d.amountSat;
    if (isCreditedStatus(d.status)) c.finalised += 1;
    else open.set(k, d);
  }
  const from = Math.min(...results.map((r) => r.segment.fromSec));
  const to = Math.max(...results.map((r) => r.segment.toSec));
  return { fromSec: from, toSec: to, pages, records, seen, open: [...open.values()].sort((a, b) => (a.seenAtSec ?? 0) - (b.seenAtSec ?? 0)) };
}

export interface WalkOptions {
  fromSec: number;
  toSec: number;
  stepSec?: number;
  concurrency?: number;
  /** Closed segments (ending an hour or more before `toSec`) are saved here and reused by the next run. */
  cacheDir?: string;
  onProgress?: (msg: string) => void;
}

export async function walkIndexer(f: typeof fetch, o: WalkOptions): Promise<WalkResult> {
  const segs = segments(o.fromSec, o.toSec, o.stepSec ?? 86_400);
  const results: SegmentResult[] = new Array<SegmentResult>(segs.length);
  let next = 0;
  let done = 0;
  let pages = 0;
  const dir = o.cacheDir ? join(o.cacheDir, "walk") : null;
  if (dir) mkdirSync(dir, { recursive: true });
  const file = (s: Segment): string => join(dir ?? "", `${s.fromSec}-${s.toSec}.json`);

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const seg = segs[i];
      if (!seg) return;
      let r: SegmentResult | null = null;
      if (dir) {
        try {
          r = JSON.parse(readFileSync(file(seg), "utf8")) as SegmentResult;
        } catch {
          r = null;
        }
      }
      if (!r) {
        r = await walkSegment(f, seg, () => {
          pages += 1;
          if (pages % 200 === 0) o.onProgress?.(`walk: ${pages} pages read, ${done}/${segs.length} segments done`);
        });
        if (dir && seg.toSec <= o.toSec - 3_600) writeFileSync(file(seg), JSON.stringify(r));
      }
      results[i] = r;
      done += 1;
      o.onProgress?.(`walk: segment ${new Date(seg.fromSec * 1000).toISOString().slice(0, 10)} done (${r.pages} pages); ${done}/${segs.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));
  return mergeSegments(results);
}

// ---------------------------------------------------------------------------------------------------------------------
// Phase 2: check each uncredited deposit and each refund request.

export interface ScanReport {
  snapshotAtSec: number;
  coverage: {
    indexFromSec: number;
    indexToSec: number;
    pages: number;
    records: number;
    /** Deposits the indexer lists in the window, and how many it shows as credited (`Finalised` or `FinalisedOnNear`). */
    seen: Record<UtxoChain, ChainCounts>;
    /** Listed as not `Finalised` when walked, but credited on a fresh look-up. */
    creditedSinceWalk: number;
    refundRequests: Record<UtxoChain, number>;
    /** Coins in each connector's `unavailable_utxos`, all time. */
    unavailableUtxos: Record<UtxoChain, number>;
  };
  minDepositSat: Record<UtxoChain, number>;
  prices: { usd: Record<UtxoChain, number>; source: string; asOfSec: Record<UtxoChain, number> };
  rows: ScanRow[];
  /** Candidates the scan could not check (an API error): listed, not counted. */
  unchecked: { chain: UtxoChain; txid: string; vout: number; amountSat: number; error: string }[];
  summary: Record<UtxoChain, ChainSummary>;
}

/** Whether a NEAR account exists (view_account); null if the RPC could not tell. */
export async function accountExists(f: typeof fetch, accountId: string, rpc: string = NEAR_RPC): Promise<boolean | null> {
  const res = await f(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: accountId } }),
  });
  const body: unknown = await res.json().catch(() => null);
  if (isObj(body) && isObj(body["result"]) && body["result"]["amount"] !== undefined) return true;
  const text = JSON.stringify(body);
  if (/UNKNOWN_ACCOUNT|does not exist/.test(text)) return false;
  return null;
}

/** The indexer's current status for one deposit; null if it does not list it. */
export async function indexerStatus(f: typeof fetch, chain: UtxoChain, txid: string, vout: number): Promise<string | null> {
  const res = await f(`${INDEXER_API}/api/v4/transfers/transfer?utxo_chain=${CHAIN_PARAM[chain]}&utxo_tx_hash=${txid}&utxo_vout=${vout}`);
  if (res.status === 404) return null;
  const body: unknown = await res.json().catch(() => null);
  const t = isObj(body) && Array.isArray(body["transfers"]) ? body["transfers"][0] : null;
  return isObj(t) && typeof t["status"] === "string" ? t["status"] : null;
}

export async function usdPrices(f: typeof fetch): Promise<ScanReport["prices"]> {
  const res = await f(PRICE_API);
  const body: unknown = await res.json();
  const get = (id: string): { usd: number; at: number } => {
    const e = isObj(body) ? body[id] : null;
    if (!isObj(e) || typeof e["usd"] !== "number") throw new Error(`price: no USD price for ${id}`);
    return { usd: e["usd"], at: Number(e["last_updated_at"] ?? 0) };
  };
  const b = get("bitcoin");
  const z = get("zcash");
  return { usd: { btc: b.usd, zcash: z.usd }, source: "CoinGecko simple/price (keyless)", asOfSec: { btc: b.at, zcash: z.at } };
}

interface Candidate {
  chain: UtxoChain;
  txid: string;
  vout: number;
  amountSat: number;
  seenAtSec: number | null;
  source: ScanRow["source"];
  indexerStatus: string | null;
}

export interface ScanOptions {
  nowSec: number;
  walk: WalkResult;
  onProgress?: (msg: string) => void;
  rpc?: string;
}

/** Phase 2: from the walk's open deposits and the connectors' refund requests to checked rows and totals. */
export async function scanCandidates(f: typeof fetch, o: ScanOptions): Promise<ScanReport> {
  const chains: UtxoChain[] = ["btc", "zcash"];
  const clients: Record<UtxoChain, BtcRefundClient> = { btc: publicBtcRefundClient(f, o.rpc, "btc"), zcash: publicBtcRefundClient(f, o.rpc, "zcash") };
  const configs = {} as Record<UtxoChain, RefundConfig>;
  const requests = {} as Record<UtxoChain, Map<string, RefundRequestRow>>;
  const unavailable = {} as Record<UtxoChain, Map<string, number>>;
  for (const c of chains) {
    configs[c] = await clients[c].config();
    requests[c] = new Map((await clients[c].refundRequests()).map((r) => [r.key, r.request]));
    unavailable[c] = new Map((await clients[c].unavailableUtxos()).map((u) => [u.key, u.balanceSat]));
  }
  const prices = await usdPrices(f);

  const candidates = new Map<string, Candidate>();
  for (const d of o.walk.open) candidates.set(keyOf(d), { chain: d.chain, txid: d.txid, vout: d.vout, amountSat: d.amountSat, seenAtSec: d.seenAtSec, source: "indexer", indexerStatus: d.status });
  for (const c of chains) {
    for (const [key, q] of requests[c]) {
      const [txid = "", vout = "0"] = key.split("@");
      const k = keyOf({ chain: c, txid, vout: Number(vout) });
      if (!candidates.has(k)) candidates.set(k, { chain: c, txid, vout: Number(vout), amountSat: q.amountSat, seenAtSec: null, source: "refund_request", indexerStatus: null });
    }
  }

  for (const c of chains) {
    for (const [key, balanceSat] of unavailable[c]) {
      const [txid = "", vout = "0"] = key.split("@");
      const k = keyOf({ chain: c, txid, vout: Number(vout) });
      if (!candidates.has(k)) candidates.set(k, { chain: c, txid, vout: Number(vout), amountSat: balanceSat, seenAtSec: null, source: "unavailable_utxos", indexerStatus: null });
    }
  }

  const rows: ScanRow[] = [];
  const unchecked: ScanReport["unchecked"] = [];
  let creditedSinceWalk = 0;
  const total = candidates.size;
  let done = 0;

  /**
   * A coin in `unavailable_utxos`: the contract verified it below the minimum and minted nothing. Its amount comes from
   * the contract; the chain gives its time, address and funding; the indexer's message (checked against the contract)
   * gives its refund address. The contract never spends such a coin, so no spend check is needed.
   */
  async function absorbed(c: Candidate, balanceSat: number): Promise<void> {
    const client = clients[c.chain];
    const tx = await client.depositTx(c.txid);
    if (!tx) throw new Error(`no ${UTXO_CHAINS[c.chain].name} transaction ${c.txid}`);
    const address = tx.outputs[c.vout]?.address ?? "";
    const msg = address ? await client.depositMsg(address) : null;
    const verified = msg && (await client.depositAddress(msg)) === address ? msg : null;
    const facts: BtcDepositFacts = {
      chain: c.chain,
      txid: c.txid,
      vout: c.vout,
      amountSat: balanceSat,
      depositAddress: address,
      confirmedAtSec: tx.confirmedAtSec,
      senders: tx.senders,
      msg: verified,
      bridgeHolds: false,
      absorbed: true,
      spentBy: null,
      request: requests[c.chain].get(`${c.txid}@${c.vout}`) ?? null,
      funding: tx.funding,
    };
    const row = scanRow(facts, btcDepositVerdict(facts, configs[c.chain], o.nowSec), configs[c.chain], o.nowSec, { recipientExists: null, source: c.source, indexerStatus: c.indexerStatus, seenAtSec: c.seenAtSec });
    if (row) rows.push(row);
  }

  async function check(c: Candidate): Promise<void> {
    const absorbedSat = unavailable[c.chain].get(`${c.txid}@${c.vout}`);
    if (absorbedSat !== undefined) return absorbed(c, absorbedSat);
    const status = c.source === "indexer" ? await indexerStatus(f, c.chain, c.txid, c.vout) : c.indexerStatus;
    if (c.source === "indexer" && status !== null && isCreditedStatus(status)) {
      creditedSinceWalk += 1;
      return;
    }
    const client: BtcRefundClient = { ...clients[c.chain], refundRequest: async (k) => requests[c.chain].get(k) ?? null };
    const r = await btcDepositFacts(c.txid, client, c.vout);
    if ("error" in r) throw new Error(r.error);
    if (!r.facts.msg) {
      // No deposit message derives this address, so the check skipped the bridge's own records: look anyway, so a
      // coin the bridge holds or has spent is never counted as stuck.
      const key = `${c.txid}@${c.vout}`;
      if ((await client.bridgeHolds(key)) || (await client.spentBy(c.txid, c.vout)) !== null) return;
    }
    const verdict = btcDepositVerdict(r.facts, configs[c.chain], o.nowSec);
    const recipient = r.facts.msg?.recipient_id;
    const exists = recipient ? await accountExists(f, recipient, o.rpc).catch(() => null) : null;
    const row = scanRow(r.facts, verdict, configs[c.chain], o.nowSec, { recipientExists: exists, source: c.source, indexerStatus: status ?? c.indexerStatus, seenAtSec: c.seenAtSec });
    if (row) rows.push(row);
  }

  // One queue per chain: Bitcoin reads mempool.space, Zcash reads Blockchair; the two run side by side.
  await Promise.all(
    chains.map(async (chain) => {
      for (const c of [...candidates.values()].filter((x) => x.chain === chain)) {
        try {
          await check(c);
        } catch (e) {
          unchecked.push({ chain: c.chain, txid: c.txid, vout: c.vout, amountSat: c.amountSat, error: e instanceof Error ? e.message : String(e) });
        }
        done += 1;
        if (done % 10 === 0 || done === total) o.onProgress?.(`check: ${done}/${total} candidates (${UTXO_CHAINS[chain].unit})`);
      }
    }),
  );

  rows.sort((a, b) => (a.chain === b.chain ? b.amountSat - a.amountSat : a.chain === "zcash" ? -1 : 1));
  return {
    snapshotAtSec: o.nowSec,
    coverage: {
      indexFromSec: o.walk.fromSec,
      indexToSec: o.walk.toSec,
      pages: o.walk.pages,
      records: o.walk.records,
      seen: o.walk.seen,
      creditedSinceWalk,
      refundRequests: { btc: requests.btc.size, zcash: requests.zcash.size },
      unavailableUtxos: { btc: unavailable.btc.size, zcash: unavailable.zcash.size },
    },
    minDepositSat: { btc: configs.btc.minDepositSat, zcash: configs.zcash.minDepositSat },
    prices,
    rows,
    unchecked,
    summary: summarize(rows, prices.usd),
  };
}

/** Request spacing per host for a full run: gentle on the free tiers (Blockchair allows about 30 requests a minute). */
export const SCAN_INTERVALS_MS: Record<string, number> = {
  "mainnet.api.bridge.nearone.org": 60,
  "mempool.space": 300,
  "api.blockchair.com": 2_100,
  "rpc.mainnet.fastnear.com": 250,
  "api.coingecko.com": 1_000,
};
