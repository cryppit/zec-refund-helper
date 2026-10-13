// Live: the deposit check against the real keyless sources (mempool.space, Blockchair, the Omni bridge indexer,
// btc-connector.bridge.near and zcash-connector.bridge.near over FastNEAR). Run on demand: pnpm test:live
import { describe, expect, it } from "vitest";

import { checkBtcDeposit, checkRefundBoard, publicBtcRefundClient, publicUtxoRefundClients } from "./btc-refund.js";

const now = () => Math.floor(Date.now() / 1000);

describe("live: Bitcoin and Zcash deposits through the Omni bridge", () => {
  it("a Zcash deposit from 2026-10-13: found on Zcash and credited to its order account", async () => {
    const r = await checkBtcDeposit("6de202d64d2b7c04154ed73f892c7dd7f288d440bde80d39059d2341fd9abadc", publicUtxoRefundClients(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.facts.chain).toBe("zcash");
    expect(r.orderAccount).toBe("957d6bdac944b4d9877892977a76a22f05af2ff01d414b7379553ac6d6cf0c3d");
    expect(r.verdict.state).toBe("credited");
  });

  it("a Zcash deposit from 2026-10-13 funded from the Ironwood pool: no transparent sender, a unified refund address", async () => {
    const r = await checkBtcDeposit("04dc643f8a1d19baf476178d01eac8fc553700e36f849df91e46924fa3f2cae6", publicUtxoRefundClients(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.facts).toMatchObject({ chain: "zcash", senders: [], funding: { kind: "shielded", pools: ["Ironwood"] } });
    expect(r.facts.msg?.refund_address).toMatch(/^u1/);
    expect(r.config.refundFeeSat).toBe(10_000);
    // Credited on 2026-10-13; the bridge may since have spent the coin in its own transaction (still credited).
    expect(r.verdict.state).toBe("credited");
  });

  it("the Bitcoin deposit stuck since 2026-08-19: never credited, its refund requested for the sending wallet", async () => {
    const r = await checkBtcDeposit("9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39", publicBtcRefundClient(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.orderAccount).toBe("f3de655c605a4ca01e000e7961a969687678efaf3bd6c6dff13cea3cb50ab807");
    // Anyone may execute it, so it can move on from "ready".
    expect(["ready", "executed", "refunded"]).toContain(r.verdict.state);
    expect(r.facts.request?.refundAddress ?? r.facts.senders[0]).toBe("bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t");
  });

  it("a Bitcoin deposit that was credited", async () => {
    const r = await checkBtcDeposit("82d074e17c7a697181a87e4b78ec0811743e7578011904ae5eb0eb2a05e9f4cb", publicBtcRefundClient(), now());
    if ("error" in r) throw new Error(r.error);
    expect(r.verdict).toEqual({ state: "credited", orderAccount: "f78dc0414931c3868bbc236445c8831338394785b2459f379152e873723a6e21" });
  });

  it("the board reads both connectors", async () => {
    const rows = await checkRefundBoard(publicUtxoRefundClients(), now());
    expect(Array.isArray(rows)).toBe(true);
  });
});
