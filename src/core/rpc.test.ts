// NEAR JSON-RPC with retries and fallback providers: a busy provider (429, 5xx, network error) is retried with backoff,
// then the next provider is tried; a contract error is an answer, never retried. Clock, sleep and fetch are injected.
import { describe, expect, it } from "vitest";

import { NEAR_RPC_PROVIDERS, NearRpcUnavailable, nearRpc, type RpcEvent } from "./rpc.js";

const OK = { jsonrpc: "2.0", id: 1, result: { result: [123], block_height: 1 } };
const CONTRACT_ERROR = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, message: "x" } };
const BODY = { jsonrpc: "2.0", id: 1, method: "status", params: [] };

type Reply = number | "network" | { status?: number; body: unknown; headers?: Record<string, string> };

/** A fetch that answers each provider from its own queue of replies, recording every call. */
function fakeFetch(replies: Record<string, Reply[]>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const next = replies[url]?.shift();
    if (next === undefined) throw new Error(`unexpected call to ${url}`);
    if (next === "network") throw new TypeError("fetch failed");
    if (typeof next === "number") return new Response("busy", { status: next });
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  }) as typeof fetch;
}

/** A fake clock: sleep advances it, so the wait budget is checked without real time passing. */
function fakeTime() {
  let t = 0;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { waits.push(ms); t += ms; }, waits };
}

const A = "https://a.example";
const B = "https://b.example";

describe("nearRpc", () => {
  it("keeps FastNEAR first and only providers that answer view calls with open CORS", () => {
    expect(NEAR_RPC_PROVIDERS[0]).toBe("https://rpc.mainnet.fastnear.com");
    expect(NEAR_RPC_PROVIDERS).toEqual([
      "https://rpc.mainnet.fastnear.com",
      "https://free.rpc.fastnear.com",
      "https://near.drpc.org",
      "https://rpc.mainnet.near.org",
    ]);
  });

  it("retries a 429 on the same provider and returns the answer", async () => {
    const calls: string[] = [];
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, { body: OK }] }, calls), ...time, random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A]);
    expect(time.waits).toHaveLength(1);
  });

  it("honours Retry-After when it fits the budget", async () => {
    const time = fakeTime();
    const rpc = nearRpc({
      providers: [A],
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "2" } }, { body: OK }] }),
      ...time,
      random: () => 0.5,
    });
    expect(await rpc(BODY)).toEqual(OK);
    expect(time.waits).toEqual([2000]);
  });

  it("falls back to the next provider after a provider's retries run out", async () => {
    const calls: string[] = [];
    const events: RpcEvent[] = [];
    const rpc = nearRpc({
      providers: [A, B],
      fetch: fakeFetch({ [A]: [429, 503, "network"], [B]: [{ body: OK }] }, calls),
      ...fakeTime(),
      random: () => 0.5,
      onEvent: (e) => events.push(e),
    });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A, A, B]);
    expect(events.some((e) => e.kind === "retry")).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "fallback", provider: B });
  });

  it("returns a contract error as the answer, without retrying or falling back", async () => {
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ body: CONTRACT_ERROR }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(CONTRACT_ERROR);
    expect(calls).toEqual([A]);
  });

  it("moves to the next provider at once when one refuses for good (HTTP 410)", async () => {
    const calls: string[] = [];
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [410], [B]: [{ body: OK }] }, calls), ...time, random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, B]);
    expect(time.waits).toEqual([]);
  });

  it("treats a provider-side timeout error as busy and tries again", async () => {
    const timeout = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR" } } };
    const rpc = nearRpc({ providers: [A], fetch: fakeFetch({ [A]: [{ body: timeout }, { body: OK }] }), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
  });

  it("a node that does not track the shard (UNAVAILABLE_SHARD) is busy: another try or provider can answer", async () => {
    const shard = { jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD", info: {} } } };
    const calls: string[] = [];
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ body: shard }, { body: shard }, { body: shard }], [B]: [{ body: OK }] }, calls), ...fakeTime(), random: () => 0.5 });
    expect(await rpc(BODY)).toEqual(OK);
    expect(calls).toEqual([A, A, A, B]);
  });

  it("an HTTP 400 or 422 carrying a JSON-RPC error is the answer (a bad request is not a busy NEAR)", async () => {
    const invalid = { jsonrpc: "2.0", id: 1, error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "PARSE_ERROR" }, message: "x" } };
    for (const status of [400, 422]) {
      const calls: string[] = [];
      const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [{ status, body: invalid }] }, calls), ...fakeTime(), random: () => 0.5 });
      expect(await rpc(BODY)).toEqual(invalid);
      expect(calls).toEqual([A]);
    }
  });

  it("throws a typed NearRpcUnavailable when every provider is busy", async () => {
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, 429, 429], [B]: [500, "network", 502] }), ...fakeTime(), random: () => 0.5 });
    const err = await rpc(BODY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NearRpcUnavailable);
    expect((err as NearRpcUnavailable).attempts).toBe(6);
    expect((err as NearRpcUnavailable).message).toMatch(/NEAR is busy/);
  });

  it("stops waiting once the time budget is spent", async () => {
    const time = fakeTime();
    const rpc = nearRpc({
      providers: [A, B],
      fetch: fakeFetch({ [A]: [{ status: 429, body: {}, headers: { "retry-after": "60" } }], [B]: [{ body: OK }] }),
      ...time,
      random: () => 0.5,
      budgetMs: 8000,
    });
    // a 60 s Retry-After does not fit an 8 s budget: skip straight to the next provider
    expect(await rpc(BODY)).toEqual(OK);
    expect(time.now()).toBeLessThanOrEqual(8000);
  });

  it("never sleeps past the budget across providers", async () => {
    const time = fakeTime();
    const rpc = nearRpc({ providers: [A, B], fetch: fakeFetch({ [A]: [429, 429, 429], [B]: [429, 429, 429] }), ...time, random: () => 1, budgetMs: 1000 });
    await expect(rpc(BODY)).rejects.toBeInstanceOf(NearRpcUnavailable);
    expect(time.now()).toBeLessThanOrEqual(1000);
  });
});
