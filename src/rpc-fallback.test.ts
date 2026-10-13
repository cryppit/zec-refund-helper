// The helper reads the bridge connectors through every public NEAR RPC in turn: FastNEAR first, then the others in
// core/rpc.ts. Recorded connector payloads (2026-10-13) answer whichever provider is asked.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { publicBtcRefundClient } from "./btc-refund.js";
import { accountExists } from "./scan.js";

const fx = (name: string): string => readFileSync(new URL(`./fixtures/btc-refund/${name}`, import.meta.url), "utf8");
const json = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "application/json" } });

/** FastNEAR refuses for good (403); the second provider answers from the recorded payloads. */
function fastnearDown(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url === "https://rpc.mainnet.fastnear.com") return new Response("forbidden", { status: 403 });
    if (url === "https://free.rpc.fastnear.com") {
      const { params } = JSON.parse(String(init?.body)) as { params: { request_type: string; method_name?: string } };
      if (params.request_type === "view_account") return json(fx("scan-account-intents.json"));
      if (params.method_name === "get_config") return json(fx("rpc-config.json"));
      if (params.method_name === "required_balance_for_request_refund") return json(fx("rpc-req-bal.json"));
      if (params.method_name === "required_balance_for_execute_refund") return json(fx("rpc-exec-bal.json"));
    }
    return new Response("not recorded", { status: 404 });
  }) as typeof fetch;
}

describe("NEAR RPC fallback", () => {
  it("reads the Bitcoin connector's config through the next provider when FastNEAR refuses", async () => {
    const calls: string[] = [];
    const config = await publicBtcRefundClient(fastnearDown(calls), undefined, "btc").config();
    expect(config.refundTimelockSec).toBeGreaterThan(0);
    expect(calls).toContain("https://free.rpc.fastnear.com");
    expect(calls.filter((c) => c === "https://rpc.mainnet.fastnear.com").length).toBeGreaterThan(0);
  });

  it("checks that a NEAR account exists through the next provider too", async () => {
    const calls: string[] = [];
    expect(await accountExists(fastnearDown(calls), "intents.near")).toBe(true);
    expect(calls).toEqual(["https://rpc.mainnet.fastnear.com", "https://free.rpc.fastnear.com"]);
  });
});
