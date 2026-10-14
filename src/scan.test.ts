// The stuck-money scan against payloads recorded on 2026-10-13: trimmed pages of the Omni bridge indexer's transfer
// list (real records; the test sets the cursors so two segments share a page), the indexer's look-up of the stuck
// Bitcoin deposit 9deffb31…@0, CoinGecko prices, NEAR view_account, and the payloads the deposit check already uses.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { cursorAt } from "./core/scan.js";
import { renderScanText } from "./render-scan.js";
import { accountExists, indexerLookup, indexerStatus, mergeSegments, pacedFetch, scanCandidates, walkSegment, type WalkResult } from "./scan.js";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/btc-refund/${name}`, import.meta.url), "utf8");
const json = (body: string, status = 200): Response => new Response(body, { status, headers: { "content-type": "application/json" } });
const viewResult = (value: unknown): Response => json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }));

const STUCK = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
/** A real 0.0004 ZEC deposit below the minimum, in zcash-connector's unavailable_utxos (fixtures shared with btc-refund.test.ts). */
const ABSORBED = "a2d0906efe45369db596bc83cf270426a471942d9af45bf20bbb96aa633e3320";
const CREDITED = "c1e3acff9638f650659926de4797431d79495bb4319c436522e24d2899a0c662";
/** A bridge payout to a NEAR→BTC withdrawal that landed on another bridge deposit address: one Bitcoin transaction, two indexer records. */
const SHARED = "4b58625fac892c047ffe1ee06dd8a612703349b9d4b6c76ce784a682ed0daeb1";
const T0 = 0x6aca0000;
const T1 = 0x6acb0000;
const T2 = 0x6acc0000;
const NOW = 1_791_900_000;
/** The open deposit c1e3acff… is answered as `FinalisedOnNear` on the fresh look-up (synthetic status). */
const API = "https://mainnet.api.bridge.nearone.org/api/v4";

/** Serves the recorded payloads; any other request fails the test. */
function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${API}/transfers?limit=50&cursor=${cursorAt(T0)}`) return json(fx("scan-page-1.json"));
    if (url === `${API}/transfers?limit=50&cursor=${(JSON.parse(fx("scan-page-1.json")) as { next_cursor: string }).next_cursor}`) return json(fx("scan-page-2.json"));
    if (url === `${API}/transfers?limit=50&cursor=${cursorAt(T1)}`) return json(fx("scan-page-3.json"));
    if (url === `${API}/transfers/transfer?utxo_chain=Btc&utxo_tx_hash=${STUCK}&utxo_vout=0`) return json(fx("scan-status-stuck.json"));
    if (url === `${API}/transfers/transfer?utxo_chain=Btc&utxo_tx_hash=${SHARED}&utxo_vout=0`) return json(fx("scan-status-shared-tx.json"));
    if (url === `${API}/transfers/transfer?utxo_chain=Btc&utxo_tx_hash=${CREDITED}&utxo_vout=0`) return json(JSON.stringify({ transfers: [{ transfer_id: { type: "utxo", chain: "Btc", tx_hash: CREDITED, vout: 0 }, origin_chain: "Btc", destination_chain: "Near", status: "FinalisedOnNear" }] }));
    if (url.startsWith("https://api.coingecko.com/")) return json(fx("scan-prices.json"));
    if (url === `https://api.blockchair.com/zcash/dashboards/transaction/${ABSORBED}`) return json(fx("zec-absorbed-tx.json"));
    if (url === `https://api.blockchair.com/zcash/raw/transaction/${ABSORBED}`) return json(fx("zec-absorbed-raw.json"));
    if (url === "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=zcash&address=t1VSSVw7j6H3DnL49Quagf1UZVFY6hxiX6n") return json(fx("zec-absorbed-msg.json"));
    if (url === `https://mempool.space/api/tx/${STUCK}`) return json(fx("tx-stuck.json"));
    if (url === `https://mempool.space/api/tx/${STUCK}/outspend/0`) return json(fx("outspend-stuck.json"));
    if (url === "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=btc&address=bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62") return json(fx("msg-stuck.json"));
    if (url === "https://rpc.mainnet.fastnear.com") {
      const { params } = JSON.parse(String(init?.body)) as { params: { request_type: string; account_id: string; method_name?: string; args_base64?: string } };
      if (params.request_type === "view_account") return json(fx(params.account_id === "intents.near" ? "scan-account-intents.json" : "scan-account-missing.json"));
      const args = JSON.parse(atob(params.args_base64 ?? "")) as { utxo_storage_keys?: string[] };
      calls.push(`${params.account_id} ${params.method_name ?? ""}`);
      const zcash = params.account_id === "zcash-connector.bridge.near";
      switch (params.method_name) {
        case "get_config":
          return json(fx(zcash ? "zec-rpc-config.json" : "rpc-config.json"));
        case "required_balance_for_request_refund":
          return json(fx("rpc-req-bal.json"));
        case "required_balance_for_execute_refund":
          return json(fx("rpc-exec-bal.json"));
        case "get_refund_requests_paged":
          return zcash ? viewResult({}) : json(fx("rpc-requests.json"));
        case "get_unavailable_utxos_paged":
          return viewResult(zcash ? { [`${ABSORBED}@0`]: { path: "0d0e2112d17b7d6d63df00aeefa476f247ec30f2b3432d39b639de0aa05b7051", tx_bytes: [], vout: 0, balance: "40000" } } : {});
        case "list_utxos":
        case "list_unavailable_utxos":
          return viewResult(Object.fromEntries((args.utxo_storage_keys ?? []).map((k) => [k, null])));
        case "get_user_deposit_address":
          return json(fx(zcash ? "zec-absorbed-rpc-addr.json" : "rpc-addr-stuck.json"));
      }
    }
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;
}

describe("pacedFetch", () => {
  it("retries a 429 with backoff, then answers", async () => {
    let n = 0;
    const slept: number[] = [];
    const f = pacedFetch((async () => (++n < 3 ? new Response("slow down", { status: 429 }) : json('{"ok":true}'))) as typeof fetch, { sleep: async (ms) => void slept.push(ms) });
    expect(await (await f("https://example.org/a")).json()).toEqual({ ok: true });
    expect(n).toBe(3);
    expect(slept).toEqual([2_000, 4_000]);
  });

  it("gives up after the retries and says why", async () => {
    const f = pacedFetch((async () => new Response("", { status: 503 })) as typeof fetch, { retries: 1, sleep: async () => undefined });
    await expect(f("https://example.org/a")).rejects.toThrow("example.org: HTTP 503 after 2 attempts");
  });

  it("spaces requests to one host and caches answers within the run", async () => {
    let n = 0;
    const slept: number[] = [];
    const f = pacedFetch((async () => json(String(++n))) as typeof fetch, { intervalMs: { "example.org": 500 }, cache: true, sleep: async (ms) => void slept.push(ms) });
    expect(await (await f("https://example.org/a")).text()).toBe("1");
    expect(await (await f("https://example.org/b")).text()).toBe("2");
    expect(await (await f("https://example.org/a")).text()).toBe("1");
    expect(n).toBe(2);
    expect(slept).toEqual([500]);
  });
});

describe("the indexer walk", () => {
  it("walks two segments that share a page and counts each deposit once", async () => {
    const f = recordedFetch();
    const a = await walkSegment(f, { fromSec: T0, toSec: T1 });
    const b = await walkSegment(f, { fromSec: T1, toSec: T2 });
    expect([a.pages, b.pages]).toEqual([2, 1]);
    const w = mergeSegments([a, b]);
    expect(w).toMatchObject({ fromSec: T0, toSec: T2, pages: 3, records: 7 });
    expect(w.seen).toEqual({ btc: { deposits: 3, finalised: 2, sat: 9_997_900 + 24_068_130 + 175_319 }, zcash: { deposits: 2, finalised: 2, sat: 423_078 + 8_398_842 } });
    expect(w.open).toEqual([{ chain: "btc", txid: STUCK, vout: 0, amountSat: 9_997_900, status: "Initialised", seenAtSec: 1_787_159_956, recipient: "near:intents.near" }]);
  });
});

describe("scanCandidates", () => {
  const walk: WalkResult = {
    fromSec: T0,
    toSec: T2,
    pages: 3,
    records: 7,
    seen: { btc: { deposits: 3, finalised: 2, sat: 0 }, zcash: { deposits: 2, finalised: 2, sat: 0 } },
    open: [
      { chain: "btc", txid: STUCK, vout: 0, amountSat: 9_997_900, status: "Initialised", seenAtSec: 1_787_159_956, recipient: "near:intents.near" },
      { chain: "btc", txid: CREDITED, vout: 0, amountSat: 24_068_130, status: "Initialised", seenAtSec: null, recipient: null },
    ],
  };

  it("checks each open deposit against the chain and the connector: the 0.1 BTC deposit is stuck with a ready, unexecuted refund", async () => {
    const r = await scanCandidates(recordedFetch(), { nowSec: NOW, walk });
    expect(r.rows).toHaveLength(2);
    expect(r.rows.find((x) => x.chain === "btc")).toMatchObject({
      chain: "btc",
      txid: STUCK,
      vout: 0,
      amountSat: 9_997_900,
      depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
      cause: "unknown",
      verdict: "ready",
      refund: { status: "ready", refundTo: "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t", gasFeeSat: 5_000 },
      refundableNow: "execute",
      source: "indexer",
      indexerStatus: "Initialised",
    });
    expect(r.coverage).toMatchObject({ creditedSinceWalk: 1, refundRequests: { btc: 1, zcash: 0 }, unavailableUtxos: { btc: 0, zcash: 1 } });
    expect(r.prices).toEqual({ usd: { btc: 83_445, zcash: 1_188.01 }, source: "CoinGecko simple/price (keyless)", asOfSec: { btc: 1_791_905_809, zcash: 1_791_905_797 } });
    expect(r.summary.btc).toMatchObject({ stuckCount: 1, stuckSat: 9_997_900, readyUnexecuted: 1, refundableNowCount: 1 });
    expect(r.summary.btc.stuckUsd).toBeCloseTo(0.099979 * 83_445, 6);
    expect(r.summary.zcash).toMatchObject({ stuckCount: 1, stuckSat: 40_000, absorbedCount: 1, refundableNowCount: 0 });
    expect(r.unchecked).toEqual([]);
  });

  it("finds what the walk did not list through the connectors: a refund request, and a coin absorbed below the minimum", async () => {
    const r = await scanCandidates(recordedFetch(), { nowSec: NOW, walk: { ...walk, open: [] } });
    expect(r.rows.map((x) => [x.txid, x.source, x.indexerStatus])).toEqual([
      [ABSORBED, "unavailable_utxos", null],
      [STUCK, "refund_request", null],
    ]);
    expect(r.rows[0]).toMatchObject({
      chain: "zcash",
      amountSat: 40_000,
      depositAddress: "t1VSSVw7j6H3DnL49Quagf1UZVFY6hxiX6n",
      confirmedAtSec: Date.parse("2026-10-09T07:12:17Z") / 1000,
      cause: "below_minimum",
      verdict: "absorbed",
      refundableNow: "no",
      refundAddress: "transparent",
      funding: { kind: "transparent", pools: [] },
    });
  });

  it("renders the totals and every stuck deposit's hash", async () => {
    const text = renderScanText(await scanCandidates(recordedFetch(), { nowSec: NOW, walk }));
    expect(text).toContain("Bitcoin: 1 stuck deposits, 0.09997900 BTC ($8,343 at $83445)");
    expect(text).toContain(`EXECUTE now  ${STUCK}@0`);
    expect(text).toContain("Zcash: 1 stuck deposits, 0.00040000 ZEC");
    expect(text).toContain("absorbed below the minimum (verified into unavailable UTXOs, nothing minted, no refund path): 1 (0.00040000 ZEC)");
    expect(text).toContain(`absorbed          no           ${ABSORBED}@0`);
  });
});

describe("accountExists", () => {
  it("tells an existing NEAR account from a missing one", async () => {
    expect(await accountExists(recordedFetch(), "intents.near")).toBe(true);
    expect(await accountExists(recordedFetch(), "no-such-account-zzz.near")).toBe(false);
  });
});

describe("indexerStatus", () => {
  it("reads the deposit's own record when the Bitcoin transaction also finalised a withdrawal (4b58625f…@0, recorded 2026-10-14)", async () => {
    // The indexer lists the NEAR→BTC withdrawal (Settled) first and the BTC→NEAR deposit (Initialised) second.
    expect(await indexerStatus(recordedFetch(), "btc", SHARED, 0)).toBe("Initialised");
  });
});

describe("indexerLookup", () => {
  it("knows a deposit that is the bridge's own payout: a NEAR→BTC withdrawal paid into a deposit address (4b58625f…@0)", async () => {
    expect(await indexerLookup(recordedFetch(), "btc", SHARED, 0)).toEqual({ status: "Initialised", bridgePayout: true });
  });

  it("an ordinary deposit is not a bridge payout", async () => {
    expect(await indexerLookup(recordedFetch(), "btc", STUCK, 0)).toEqual({ status: "Initialised", bridgePayout: false });
  });
});
