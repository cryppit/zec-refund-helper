// NEAR JSON-RPC with retries and fallback providers. Public RPCs rate-limit shared IPs (a Cloudflare Worker, an office
// NAT, one person with many tabs), so a single 429 must not reach the user as "HTTP 429". A busy provider (HTTP 408,
// 425, 429, 5xx, a network error, a body that is not JSON, or a provider-side timeout) is retried with exponential
// backoff and jitter, honouring Retry-After, then the next provider is tried. Any other JSON-RPC answer, contract
// errors included, is returned as is: every provider serves the same chain, so the answer does not depend on which one
// replied. The clock, sleep, randomness and fetch are injected so tests are deterministic.

/** Mainnet providers that answer `query` view calls and `block`, with CORS open to browsers (checked 2026-10-13).
 *  Dropped: near.lava.build (410, discontinued), 1rpc.io/near (no `query` method), dRPC (its terms, §1.3,
 *  rule out our use). */
export const NEAR_RPC_PROVIDERS: readonly string[] = [
  "https://rpc.mainnet.fastnear.com",
  "https://free.rpc.fastnear.com",
  "https://rpc.mainnet.near.org",
];

export type RpcEvent =
  | { kind: "retry"; provider: string; attempt: number; waitMs: number; reason: string }
  | { kind: "fallback"; provider: string };

export interface NearRpcOptions {
  providers?: readonly string[];
  fetch?: typeof fetch;
  /** Milliseconds since some origin; only differences are used. */
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** In [0, 1): the jitter source. */
  random: () => number;
  /** Attempts per provider (default 3). */
  attempts?: number;
  /** Total time a call may spend waiting between attempts (default 8000 ms). */
  budgetMs?: number;
  onEvent?: (e: RpcEvent) => void;
}

/** Every provider was busy or unreachable. The message is safe to show to users. */
export class NearRpcUnavailable extends Error {
  constructor(
    readonly attempts: number,
    readonly lastReason: string,
  ) {
    super("NEAR is busy right now: every public NEAR RPC we use is rate-limiting or unreachable. Try again in a minute.");
    this.name = "NearRpcUnavailable";
  }
}

const BUSY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/**
 * JSON-RPC error causes that describe the provider, not the chain: another try (or provider) can answer.
 * UNAVAILABLE_SHARD: that node does not track the shard the account lives on.
 */
const BUSY_CAUSES = new Set(["TIMEOUT_ERROR", "INTERNAL_ERROR", "NO_SYNCED_BLOCKS", "NOT_SYNCED_YET", "UNAVAILABLE_SHARD"]);
/** Statuses some providers put on a JSON-RPC error about the request itself: the body is the answer. */
const REQUEST_ERROR_STATUS = new Set([400, 422]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why this body is a busy-provider answer rather than a chain answer, or null when it is a real answer. */
function busyBody(body: unknown): string | null {
  if (!isObj(body)) return "not a JSON-RPC object";
  if ("result" in body) return null;
  const err = body["error"];
  if (typeof err === "string") return err; // a gateway's own error, not NEAR's
  if (!isObj(err)) return "no result";
  const cause = isObj(err["cause"]) ? err["cause"]["name"] : null;
  if (typeof cause === "string" && BUSY_CAUSES.has(cause)) return cause;
  if (err["code"] === 429 || err["code"] === -32005) return "rate limited";
  return null;
}

function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (v === null) return null;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : null;
}

/** A JSON-RPC caller: posts `body` and returns the parsed response object (result or a chain error). */
export function nearRpc(opts: NearRpcOptions): (body: unknown) => Promise<unknown> {
  const providers = opts.providers ?? NEAR_RPC_PROVIDERS;
  const fetchImpl = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 3;
  const budgetMs = opts.budgetMs ?? 8000;

  return async (body: unknown) => {
    const start = opts.now();
    let tried = 0;
    let lastReason = "no provider";
    for (const [p, provider] of providers.entries()) {
      if (p > 0) opts.onEvent?.({ kind: "fallback", provider });
      for (let attempt = 1; attempt <= attempts; attempt++) {
        tried++;
        let hint: number | null = null;
        try {
          const res = await fetchImpl(provider, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          if (BUSY_STATUS.has(res.status)) {
            lastReason = `HTTP ${res.status}`;
            hint = retryAfterMs(res);
          } else if (REQUEST_ERROR_STATUS.has(res.status)) {
            // A JSON-RPC error about our request is the answer from any provider; anything else, try the next one.
            let parsed: unknown;
            try {
              parsed = await res.json();
            } catch {
              parsed = undefined;
            }
            if (isObj(parsed) && isObj(parsed["error"]) && busyBody(parsed) === null) return parsed;
            lastReason = `HTTP ${res.status}`;
            break;
          } else if (!res.ok) {
            // refused for good by this provider (403, 404, 410…): retrying it is pointless, try the next one
            lastReason = `HTTP ${res.status}`;
            break;
          } else {
            let parsed: unknown;
            try {
              parsed = await res.json();
            } catch {
              parsed = undefined;
            }
            const busy = busyBody(parsed);
            if (busy === null) return parsed;
            lastReason = busy;
          }
        } catch (e) {
          lastReason = e instanceof Error ? e.message : "network error";
        }
        if (attempt === attempts) break;
        const backoff = 250 * 2 ** (attempt - 1) * (0.5 + opts.random());
        const waitMs = Math.round(hint ?? backoff);
        const left = budgetMs - (opts.now() - start);
        if (waitMs > left) break; // this provider cannot answer in time: try the next one now
        opts.onEvent?.({ kind: "retry", provider, attempt, waitMs, reason: lastReason });
        await opts.sleep(waitMs);
      }
    }
    throw new NearRpcUnavailable(tried, lastReason);
  };
}
