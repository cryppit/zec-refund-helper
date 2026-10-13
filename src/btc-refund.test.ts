// The BTC deposit check against payloads recorded on 2026-10-13 from the real keyless sources: mempool.space, the Omni
// bridge indexer's deposit-message lookup and the btc-connector.bridge.near contract (FastNEAR RPC). Two real deposits:
// one credited to an order account, and one stuck since 2026-08-19 whose refund was requested and never executed.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { checkBtcDeposit, checkRefundBoard, publicBtcRefundClient, publicUtxoRefundClients } from "./btc-refund.js";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/btc-refund/${name}`, import.meta.url), "utf8");
const json = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
const viewResult = (value: unknown): Response => json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } }));

const STUCK = "9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39";
const CREDITED = "82d074e17c7a697181a87e4b78ec0811743e7578011904ae5eb0eb2a05e9f4cb";
const CREDITED_SPEND = (JSON.parse(fx("outspend-credited.json")) as { txid: string }).txid;
const ZEC = "6de202d64d2b7c04154ed73f892c7dd7f288d440bde80d39059d2341fd9abadc";
/** A real 50 ZEC deposit of 2026-10-13 funded from the Ironwood pool: no transparent input, a unified refund address. */
const ZEC_SHIELDED = "04dc643f8a1d19baf476178d01eac8fc553700e36f849df91e46924fa3f2cae6";
/** A real 0.0004 ZEC deposit of 2026-10-09, below the 0.001 ZEC minimum: verified into unavailable_utxos, nothing minted. */
const ZEC_ABSORBED = "a2d0906efe45369db596bc83cf270426a471942d9af45bf20bbb96aa633e3320";
const BLOCKCHAIR_RAW = "https://api.blockchair.com/zcash/raw/transaction/";
const M = "https://mempool.space/api";
const BLOCKCHAIR = "https://api.blockchair.com/zcash/dashboards/transaction/";
const INDEXER = "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=btc&address=";

/** Serves the recorded payloads; any other request fails the test. */
function recordedFetch(calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === `${M}/tx/${STUCK}`) return json(fx("tx-stuck.json"));
    if (url === `${M}/tx/${STUCK}/outspend/0`) return json(fx("outspend-stuck.json"));
    if (url === `${M}/tx/${CREDITED}`) return json(fx("tx-credited.json"));
    if (url === `${M}/tx/${CREDITED}/outspend/0`) return json(fx("outspend-credited.json"));
    if (url === `${M}/tx/${CREDITED_SPEND}`) return json(fx("tx-credited-spend.json"));
    if (url === `${INDEXER}bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62`) return json(fx("msg-stuck.json"));
    if (url === `${INDEXER}bc1qmnpagp77fuw8kjqa7z63epf5gzwy00kn0nn4wf`) return json(fx("msg-credited.json"));
    if (url.startsWith(`${M}/tx/`)) return new Response("Transaction not found", { status: 404 });
    if (url === `${BLOCKCHAIR}${ZEC}`) return json(fx("zec-tx.json"));
    if (url === `${BLOCKCHAIR_RAW}${ZEC}`) return json(fx("zec-raw.json"));
    if (url === `${BLOCKCHAIR}${ZEC_SHIELDED}`) return json(fx("zec-shielded-tx.json"));
    if (url === `${BLOCKCHAIR_RAW}${ZEC_SHIELDED}`) return json(fx("zec-shielded-raw.json"));
    if (url === `${BLOCKCHAIR}${ZEC_ABSORBED}`) return json(fx("zec-absorbed-tx.json"));
    if (url === `${BLOCKCHAIR_RAW}${ZEC_ABSORBED}`) return json(fx("zec-absorbed-raw.json"));
    if (url.startsWith(BLOCKCHAIR)) return json('{"data":[],"context":{"code":200}}');
    if (url === "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=zcash&address=t1VSSVw7j6H3DnL49Quagf1UZVFY6hxiX6n") return json(fx("zec-absorbed-msg.json"));
    if (url === "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=zcash&address=t1c4LrfuWHBmL86JZcohcdt5gWZTJfTYtte") return json(fx("zec-msg.json"));
    if (url === "https://mainnet.api.bridge.nearone.org/api/v3/utxo/get_deposit_message?chain=zcash&address=t1RTEogVdgA8cWY8zm1uomj5ThPZnbp8BB4") return json(fx("zec-shielded-msg.json"));
    if (url.startsWith(INDEXER)) return new Response("", { status: 404 });
    if (url === "https://rpc.mainnet.fastnear.com") {
      const { params } = JSON.parse(String(init?.body)) as { params: { account_id: string; method_name: string; args_base64: string } };
      const args = JSON.parse(atob(params.args_base64)) as { utxo_storage_keys?: string[]; deposit_msg?: { refund_address?: string } };
      calls.push(params.method_name);
      if (params.account_id === "zcash-connector.bridge.near") {
        switch (params.method_name) {
          case "get_config":
            return json(fx("zec-rpc-config.json"));
          case "get_user_deposit_address":
            if (args.deposit_msg?.refund_address === "t1Kxq1ACfjM1SkGyG4Q5hoFrRE66vDPGsrT") return json(fx("zec-absorbed-rpc-addr.json"));
            return json(fx(args.deposit_msg?.refund_address?.startsWith("u1") ? "zec-shielded-rpc-addr.json" : "zec-rpc-addr.json"));
          case "list_unavailable_utxos":
            if (args.utxo_storage_keys?.[0] === `${ZEC_ABSORBED}@0`) return json(fx("zec-absorbed-rpc-unavail.json"));
            return viewResult(Object.fromEntries((args.utxo_storage_keys ?? []).map((k) => [k, null])));
          case "list_utxos":
            if (args.utxo_storage_keys?.[0] === `${ZEC_ABSORBED}@0`) return viewResult({ [`${ZEC_ABSORBED}@0`]: null });
            if (args.utxo_storage_keys?.[0] === `${ZEC_SHIELDED}@0`) return json(fx("zec-shielded-rpc-utxos.json"));
            return viewResult({ [`${ZEC}@0`]: { vout: 0, balance: "41000000" } });
          case "get_refund_requests_paged":
            return viewResult({});
        }
      }
      switch (params.method_name) {
        case "get_config":
          return json(fx("rpc-config.json"));
        case "required_balance_for_request_refund":
          return json(fx("rpc-req-bal.json"));
        case "required_balance_for_execute_refund":
          return json(fx("rpc-exec-bal.json"));
        case "get_refund_requests_paged":
          return json(fx("rpc-requests.json"));
        case "list_utxos":
        case "list_unavailable_utxos":
          return viewResult(Object.fromEntries((args.utxo_storage_keys ?? []).map((k) => [k, null])));
        case "get_user_deposit_address":
          return json(fx(args.deposit_msg?.refund_address ? "rpc-addr-credited.json" : "rpc-addr-stuck.json"));
      }
    }
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;
}

const NOW = 1_791_900_000; // 2026-10-13

describe("checkBtcDeposit", () => {
  it("finds the stuck deposit's refund request, past its 14-day lock and never executed", async () => {
    const r = await checkBtcDeposit(STUCK, publicBtcRefundClient(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({
      txid: STUCK,
      vout: 0,
      amountSat: 9_997_900,
      depositAddress: "bc1quqzcjgj4v25ty8g9s49tkl45r7qruhecglax62",
      senders: ["bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t"],
      bridgeHolds: false,
      spentBy: null,
      request: { refundAddress: "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t", amountSat: 9_997_900, createdAtSec: 1_787_161_227, executed: false, msgHasRefundAddress: false, gasFeeSat: 5_000 },
      funding: { kind: "transparent", pools: [] },
    });
    expect(r.verdict).toEqual({ state: "ready", refundTo: "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t", unlockedAtSec: 1_787_161_227 + 1_209_600 });
    expect(r.orderAccount).toBe("f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807");
    expect(r.config).toMatchObject({ refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600, minDepositSat: 2_500, maxGasFeeSat: 5_000, refundFeeSat: 5_000, requestDepositYocto: 2n * 10n ** 24n, executeDepositYocto: 10n ** 24n });
    expect(r.steps.map((s) => s.title)).toEqual(["Execute the refund (1 NEAR)", "Have the bridge sign the Bitcoin refund"]);
  });

  it("calls a deposit credited once the bridge has spent the coin in its own transaction", async () => {
    const r = await checkBtcDeposit(CREDITED, publicBtcRefundClient(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.facts.msg?.refund_address).toBe("bc1qrr4quakwzsl8x625acvw0z70rpyy06kh24s0s2");
    expect(r.facts.spentBy?.txid).toBe(CREDITED_SPEND);
    expect(r.verdict).toEqual({ state: "credited", orderAccount: "f78dc0414931c3868bbc236445c8831338394785b2459f379152e873723a6e21" });
    expect(r.steps).toEqual([]);
  });

  it("checks the indexer's deposit message against the contract before trusting it", async () => {
    const calls: string[] = [];
    await checkBtcDeposit(STUCK, publicBtcRefundClient(recordedFetch(calls)), NOW);
    expect(calls).toContain("get_user_deposit_address");
  });

  it("a Zcash deposit: not on Bitcoin, found on Zcash, held by the Zcash connector, so credited", async () => {
    const r = await checkBtcDeposit(ZEC, publicUtxoRefundClients(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({
      chain: "zcash",
      vout: 0,
      amountSat: 41_000_000,
      depositAddress: "t1c4LrfuWHBmL86JZcohcdt5gWZTJfTYtte",
      senders: ["t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1"],
      bridgeHolds: true,
      funding: { kind: "transparent", pools: [] },
    });
    expect(r.facts.confirmedAtSec).toBe(Date.parse("2026-10-13T10:23:19Z") / 1000);
    expect(r.verdict).toEqual({ state: "credited", orderAccount: "957d6bdac944b4d9877892977a76a22f05af2ff01d414b7379553ac6d6cf0c3d" });
  });

  it("the Zcash connector's live config: a 0.01 ZEC max_btc_gas_fee, but a 10,000-zatoshi refund fee (ZIP-317)", async () => {
    const r = await checkBtcDeposit(ZEC, publicUtxoRefundClients(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.config).toMatchObject({ minDepositSat: 100_000, maxGasFeeSat: 1_000_000, refundFeeSat: 10_000, refundTimelockSec: 172_800, unsafeRefundTimelockSec: 1_209_600 });
  });

  it("a real Zcash deposit funded from the Ironwood pool: no transparent sender, its own unified refund address, credited", async () => {
    const r = await checkBtcDeposit(ZEC_SHIELDED, publicUtxoRefundClients(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({
      chain: "zcash",
      amountSat: 5_000_000_000,
      depositAddress: "t1RTEogVdgA8cWY8zm1uomj5ThPZnbp8BB4",
      senders: [],
      bridgeHolds: true,
      funding: { kind: "shielded", pools: ["Ironwood"] },
    });
    expect(r.facts.msg?.refund_address).toMatch(/^u1egfcnx/);
    expect(r.verdict).toEqual({ state: "credited", orderAccount: "9652b32cea0982dd04435e1b43903cf5618566ee3bde6fca59a1c056dacf6ad9" });
  });

  it("the same deposit if it had never been credited (synthetic: the bridge's UTXO set answer removed): refundable shielded, to its own unified address", async () => {
    const real = recordedFetch();
    const notHeld = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://rpc.mainnet.fastnear.com" && String(init?.body).includes('"list_utxos"')) return viewResult({ [`${ZEC_SHIELDED}@0`]: null });
      return real(input, init);
    }) as typeof fetch;
    const r = await checkBtcDeposit(ZEC_SHIELDED, publicUtxoRefundClients(notHeld), NOW + 86_400);
    if ("error" in r) throw new Error(r.error);
    expect(r.verdict).toMatchObject({ state: "refundable", refundToFromDeposit: true, noTransparentSender: true, tooSmall: false, feeSat: 10_000 });
    expect(r.steps.map((s) => s.title)).toEqual(["Request the refund (2 NEAR, not returned)", "Wait 2 days for the timelock", "Execute the refund, shielded (1 NEAR)", "Have the bridge sign the Zcash refund"]);
    expect(r.steps[2]?.command).toBe(`bridge-cli mainnet btc-execute-refund --chain zcash --btc-tx-hash ${ZEC_SHIELDED} --vout 0`);
  });

  it("a real Zcash deposit below the minimum: the bridge verified it into unavailable_utxos and minted nothing, so it is absorbed, not credited", async () => {
    const r = await checkBtcDeposit(ZEC_ABSORBED, publicUtxoRefundClients(recordedFetch()), NOW);
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({ chain: "zcash", amountSat: 40_000, depositAddress: "t1VSSVw7j6H3DnL49Quagf1UZVFY6hxiX6n", bridgeHolds: false, absorbed: true, spentBy: null });
    expect(r.verdict).toEqual({ state: "absorbed", minDepositSat: 100_000 });
    expect(r.steps).toEqual([]);
  });

  it("a hash neither chain knows", async () => {
    expect(await checkBtcDeposit("ab".repeat(32), publicUtxoRefundClients(recordedFetch()), NOW)).toEqual({ error: "no Bitcoin or Zcash transaction with this hash" });
  });

  it("reports a hash that is not a Bitcoin transaction", async () => {
    const r = await checkBtcDeposit("ab".repeat(32), publicBtcRefundClient(recordedFetch()), NOW);
    expect(r).toEqual({ error: "no Bitcoin transaction with this hash" });
    expect(await checkBtcDeposit("nope", publicBtcRefundClient(recordedFetch()), NOW)).toEqual({ error: "not a Bitcoin transaction hash (64 hex characters)" });
  });

  it("the board lists every refund request on both connectors: today the one Bitcoin request, ready for 41 days", async () => {
    const rows = await checkRefundBoard(publicUtxoRefundClients(recordedFetch()), NOW);
    expect(rows).toEqual([
      {
        chain: "btc",
        txid: STUCK,
        vout: 0,
        amountSat: 9_997_900,
        refundTo: "bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t",
        requestedAtSec: 1_787_161_227,
        unlocksAtSec: 1_787_161_227 + 1_209_600,
        state: "ready",
        readyForSec: NOW - 1_787_161_227 - 1_209_600,
      },
    ]);
  });
});
