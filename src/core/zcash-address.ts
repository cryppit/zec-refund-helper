// Zcash address classification, with no dependencies: which kind of address a refund would go to, and which of the
// Zcash connector's two refund paths can pay it.
//
// - Transparent t1/t3 (and testnet tm/t2): Base58Check, verified with our own SHA-256.
// - TEX (ZIP-320): Bech32m, a 20-byte P2PKH hash.
// - Unified addresses (ZIP-316): Bech32m without the 90-character limit, then F4Jumble⁻¹ (BLAKE2b, personalised
//   "UA_F4Jumble_H"/"UA_F4Jumble_G"), then typecode-length-value items: 0x00 P2PKH, 0x01 P2SH, 0x02 Sapling,
//   0x03 Orchard, ending in the HRP padded to 16 bytes. Tested against the zcash-test-vectors.
// - Sapling zs1 (Bech32) and Sprout zc (Base58Check).
//
// What the deployed connector (Near-One/btc-bridge v0.9.7-rc.3, zcash_utils + network.rs) can pay:
// - a transparent refund (`execute_refund` with no Orchard bundle) needs a scriptPubKey: a t-address, a TEX address
//   or a unified address with a P2PKH/P2SH receiver;
// - a shielded refund (`execute_refund` with an Orchard bundle) needs a unified address with an Orchard receiver;
// - a Sapling or Sprout address, or a unified address with neither, cannot be refunded at all: the contract's address
//   parser has no Sapling/Sprout conversion, and it reads only transparent and Orchard receivers.

// ---------- BLAKE2b (RFC 7693), BigInt words: inputs here are a few hundred bytes ----------

const MASK64 = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr64 = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK64;
const le64 = (b: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i] ?? 0);
  return v;
};

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m = Array.from({ length: 16 }, (_, i) => le64(block, i * 8));
  const v = [...h, ...IV];
  v[12] = (v[12] as bigint) ^ (t & MASK64);
  v[13] = (v[13] as bigint) ^ (t >> 64n);
  if (last) v[14] = (v[14] as bigint) ^ MASK64;
  const g = (a: number, b: number, c: number, d: number, x: bigint, y: bigint): void => {
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + x) & MASK64;
    v[d] = rotr64((v[d] as bigint) ^ (v[a] as bigint), 32n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK64;
    v[b] = rotr64((v[b] as bigint) ^ (v[c] as bigint), 24n);
    v[a] = ((v[a] as bigint) + (v[b] as bigint) + y) & MASK64;
    v[d] = rotr64((v[d] as bigint) ^ (v[a] as bigint), 16n);
    v[c] = ((v[c] as bigint) + (v[d] as bigint)) & MASK64;
    v[b] = rotr64((v[b] as bigint) ^ (v[c] as bigint), 63n);
  };
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10] as number[];
    const mm = (i: number): bigint => m[s[i] as number] as bigint;
    g(0, 4, 8, 12, mm(0), mm(1));
    g(1, 5, 9, 13, mm(2), mm(3));
    g(2, 6, 10, 14, mm(4), mm(5));
    g(3, 7, 11, 15, mm(6), mm(7));
    g(0, 5, 10, 15, mm(8), mm(9));
    g(1, 6, 11, 12, mm(10), mm(11));
    g(2, 7, 8, 13, mm(12), mm(13));
    g(3, 4, 9, 14, mm(14), mm(15));
  }
  for (let i = 0; i < 8; i++) h[i] = (h[i] as bigint) ^ (v[i] as bigint) ^ (v[i + 8] as bigint);
}

/** Unkeyed BLAKE2b with an `outLen`-byte digest (1–64) and an optional 16-byte personalization. */
export function blake2b(msg: Uint8Array, outLen: number, personal?: Uint8Array): Uint8Array {
  if (outLen < 1 || outLen > 64) throw new Error("BLAKE2b output length must be 1 to 64 bytes");
  const h = [...IV];
  h[0] = (h[0] as bigint) ^ BigInt(0x01010000 ^ outLen);
  if (personal) {
    const p = new Uint8Array(16);
    p.set(personal.subarray(0, 16));
    h[6] = (h[6] as bigint) ^ le64(p, 0);
    h[7] = (h[7] as bigint) ^ le64(p, 8);
  }
  const blocks = Math.max(1, Math.ceil(msg.length / 128));
  for (let i = 0; i < blocks; i++) {
    const block = new Uint8Array(128);
    block.set(msg.subarray(i * 128, i * 128 + 128));
    const last = i === blocks - 1;
    compress(h, block, BigInt(last ? msg.length : (i + 1) * 128), last);
  }
  const out = new Uint8Array(64);
  h.forEach((w, i) => {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((w >> BigInt(8 * j)) & 0xffn);
  });
  return out.slice(0, outLen);
}

// ---------- SHA-256 (FIPS 180-4), for Base58Check ----------

const K256 = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(msg: Uint8Array): Uint8Array {
  const len = msg.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(msg);
  padded[len] = 0x80;
  const bitLen = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) padded[padded.length - 1 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = ((padded[off + 4 * i] ?? 0) << 24) | ((padded[off + 4 * i + 1] ?? 0) << 16) | ((padded[off + 4 * i + 2] ?? 0) << 8) | (padded[off + 4 * i + 3] ?? 0);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] ?? 0;
      const b = w[i - 2] ?? 0;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (K256[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => {
      h[i] = ((h[i] ?? 0) + x) >>> 0;
    });
  }
  const out = new Uint8Array(32);
  h.forEach((x, i) => {
    out[4 * i] = x >>> 24;
    out[4 * i + 1] = (x >>> 16) & 0xff;
    out[4 * i + 2] = (x >>> 8) & 0xff;
    out[4 * i + 3] = x & 0xff;
  });
  return out;
}

// ---------- F4Jumble (ZIP-316) ----------

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array => a.map((x, i) => x ^ (b[i] ?? 0));
const PERSONAL_H = new TextEncoder().encode("UA_F4Jumble_H");
const PERSONAL_G = new TextEncoder().encode("UA_F4Jumble_G");

function f4H(i: number, u: Uint8Array, lenL: number): Uint8Array {
  return blake2b(u, lenL, Uint8Array.from([...PERSONAL_H, i, 0, 0]));
}
function f4G(i: number, u: Uint8Array, lenR: number): Uint8Array {
  const out = new Uint8Array(lenR);
  for (let j = 0; j * 64 < lenR; j++) {
    const block = blake2b(u, 64, Uint8Array.from([...PERSONAL_G, i, j & 0xff, j >> 8]));
    out.set(block.subarray(0, Math.min(64, lenR - j * 64)), j * 64);
  }
  return out;
}
// ZIP-316 (and librustzcash's VALID_LENGTH) take 38..4194368 bytes; 38 fits a transparent-only Revision 2 `tu` address.
const f4Split = (m: Uint8Array): number => {
  if (m.length < 38 || m.length > 4_194_368) throw new Error("F4Jumble input must be 38 to 4194368 bytes");
  return Math.min(64, Math.floor(m.length / 2));
};

export function f4jumble(m: Uint8Array): Uint8Array {
  const lenL = f4Split(m);
  const lenR = m.length - lenL;
  const a = m.subarray(0, lenL);
  const b = m.subarray(lenL);
  const x = xor(b, f4G(0, a, lenR));
  const y = xor(a, f4H(0, x, lenL));
  const d = xor(x, f4G(1, y, lenR));
  const c = xor(y, f4H(1, d, lenL));
  return Uint8Array.from([...c, ...d]);
}

export function f4jumbleInv(m: Uint8Array): Uint8Array {
  const lenL = f4Split(m);
  const lenR = m.length - lenL;
  const c = m.subarray(0, lenL);
  const d = m.subarray(lenL);
  const y = xor(c, f4H(1, d, lenL));
  const x = xor(d, f4G(1, y, lenR));
  const a = xor(y, f4H(0, x, lenL));
  const b = xor(x, f4G(0, a, lenR));
  return Uint8Array.from([...a, ...b]);
}

// ---------- Bech32 / Bech32m (BIP-173 / BIP-350), no length limit (ZIP-316) ----------

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i] ?? 0;
  }
  return chk >>> 0;
}

export function bech32Decode(s: string): { hrp: string; bytes: Uint8Array; variant: "bech32" | "bech32m" } | { error: string } {
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return { error: "mixed case" };
  const str = s.toLowerCase();
  const sep = str.lastIndexOf("1");
  if (sep < 1 || sep + 7 > str.length) return { error: "not Bech32" };
  const hrp = str.slice(0, sep);
  const words: number[] = [];
  for (const ch of str.slice(sep + 1)) {
    const w = CHARSET.indexOf(ch);
    if (w === -1) return { error: "not Bech32" };
    words.push(w);
  }
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const check = polymod([...expand, ...words]);
  const variant = check === BECH32M_CONST ? "bech32m" : check === BECH32_CONST ? "bech32" : null;
  if (!variant) return { error: "bad checksum" };
  const data = words.slice(0, -6);
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const w of data) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (bits >= 5 || (acc & ((1 << bits) - 1)) !== 0) return { error: "bad padding" };
  return { hrp, bytes: Uint8Array.from(out), variant };
}

// ---------- Base58Check ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58CheckDecode(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const d = B58.indexOf(ch);
    if (d === -1) return null;
    n = n * 58n + BigInt(d);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== "1") break;
    body.unshift(0);
  }
  if (body.length < 5) return null;
  const raw = Uint8Array.from(body);
  const payload = raw.subarray(0, -4);
  const sum = sha256(sha256(payload));
  return raw.subarray(-4).every((b, i) => b === sum[i]) ? payload : null;
}

// ---------- Unified addresses ----------

export interface UnifiedItem {
  typecode: number;
  data: Uint8Array;
}

const UA_HRP: Record<string, "main" | "test"> = { u: "main", utest: "test" };
const RECEIVER_LEN: Record<number, number> = { 0: 20, 1: 20, 2: 43, 3: 43 };

function compactSize(b: Uint8Array, at: number): { value: number; next: number } | null {
  const first = b[at];
  if (first === undefined) return null;
  if (first < 0xfd) return { value: first, next: at + 1 };
  const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (at + 1 + width > b.length) return null;
  let v = 0;
  for (let i = width - 1; i >= 0; i--) v = v * 256 + (b[at + 1 + i] ?? 0);
  return { value: v, next: at + 1 + width };
}

/** ZIP-316 decoding: Bech32m, F4Jumble⁻¹, the HRP padding check, then the typecode-length-value items. */
export function decodeUnifiedAddress(s: string): { network: "main" | "test"; items: UnifiedItem[] } | { error: string } {
  const d = bech32Decode(s);
  if ("error" in d) return { error: d.error === "bad checksum" ? "bad Bech32m checksum" : d.error };
  const network = UA_HRP[d.hrp];
  if (!network) return { error: `not a unified address (HRP ${d.hrp})` };
  if (d.variant !== "bech32m") return { error: "a unified address uses Bech32m" };
  if (d.bytes.length < 38) return { error: "too short for a unified address" };
  const raw = f4jumbleInv(d.bytes);
  const pad = new Uint8Array(16);
  pad.set(new TextEncoder().encode(d.hrp));
  const tail = raw.subarray(raw.length - 16);
  if (!tail.every((b, i) => b === pad[i])) return { error: "bad unified address padding" };
  const body = raw.subarray(0, raw.length - 16);
  const items: UnifiedItem[] = [];
  for (let at = 0; at < body.length; ) {
    const t = compactSize(body, at);
    const l = t && compactSize(body, t.next);
    if (!t || !l || l.next + l.value > body.length) return { error: "truncated unified address item" };
    const last = items[items.length - 1];
    if (last && last.typecode >= t.value) return { error: "unified address items out of order" };
    const want = RECEIVER_LEN[t.value];
    if (want !== undefined && want !== l.value) return { error: `wrong length for typecode ${t.value}` };
    items.push({ typecode: t.value, data: body.slice(l.next, l.next + l.value) });
    at = l.next + l.value;
  }
  const codes = items.map((i) => i.typecode);
  if (codes.includes(0) && codes.includes(1)) return { error: "a unified address cannot hold both P2PKH and P2SH" };
  if (!items.some((i) => i.typecode !== 0 && i.typecode !== 1)) return { error: "a unified address needs a non-transparent item" };
  return { network, items };
}

// ---------- Classification ----------

export type ZcashAddressKind = "p2pkh" | "p2sh" | "tex" | "unified" | "sapling" | "sprout" | "unknown";

export interface ZcashAddressInfo {
  address: string;
  kind: ZcashAddressKind;
  network: "main" | "test" | null;
  /** The checksum and structure verify. */
  valid: boolean;
  receivers: { p2pkh: boolean; p2sh: boolean; sapling: boolean; orchard: boolean; unknown: number[] };
  /** Which refund the Zcash connector can build to this address: a transparent output, or an Orchard bundle. */
  refund: { transparent: boolean; shielded: boolean };
  error?: string;
}

const T_PREFIX: Record<string, { kind: "p2pkh" | "p2sh" | "sprout"; network: "main" | "test" }> = {
  "1cb8": { kind: "p2pkh", network: "main" },
  "1cbd": { kind: "p2sh", network: "main" },
  "1d25": { kind: "p2pkh", network: "test" },
  "1cba": { kind: "p2sh", network: "test" },
  "169a": { kind: "sprout", network: "main" },
  "16b6": { kind: "sprout", network: "test" },
};
const NONE = { p2pkh: false, p2sh: false, sapling: false, orchard: false, unknown: [] as number[] };
const NO_REFUND = { transparent: false, shielded: false };

export function classifyZcashAddress(raw: string): ZcashAddressInfo {
  const address = raw.trim();
  const base = { address, receivers: { ...NONE, unknown: [] as number[] } };
  const lower = address.toLowerCase();

  if (lower.startsWith("u1") || lower.startsWith("utest1")) {
    const ua = decodeUnifiedAddress(address);
    if ("error" in ua) return { ...base, kind: "unified", network: lower.startsWith("u1") ? "main" : "test", valid: false, refund: NO_REFUND, error: ua.error };
    const has = (t: number): boolean => ua.items.some((i) => i.typecode === t);
    const receivers = { p2pkh: has(0), p2sh: has(1), sapling: has(2), orchard: has(3), unknown: ua.items.map((i) => i.typecode).filter((t) => t > 3) };
    return { address, kind: "unified", network: ua.network, valid: true, receivers, refund: { transparent: receivers.p2pkh || receivers.p2sh, shielded: receivers.orchard } };
  }

  if (lower.startsWith("zs1") || lower.startsWith("ztestsapling1") || lower.startsWith("tex1") || lower.startsWith("textest1")) {
    const d = bech32Decode(address);
    const isTex = lower.startsWith("tex");
    const network = lower.startsWith("zs1") || lower.startsWith("tex1") ? "main" : "test";
    const valid = !("error" in d) && d.bytes.length === (isTex ? 20 : 43) && d.variant === (isTex ? "bech32m" : "bech32");
    if (isTex) return { ...base, kind: "tex", network, valid, receivers: { ...NONE, unknown: [], p2pkh: valid }, refund: { transparent: valid, shielded: false } };
    return { ...base, kind: "sapling", network, valid, receivers: { ...NONE, unknown: [], sapling: valid }, refund: NO_REFUND };
  }

  if (/^(t1|t3|tm|t2|zc|zt)/.test(address)) {
    const payload = base58CheckDecode(address);
    const prefix = payload ? [...payload.subarray(0, 2)].map((b) => b.toString(16).padStart(2, "0")).join("") : null;
    const t = prefix ? T_PREFIX[prefix] : undefined;
    const guess: ZcashAddressKind = address.startsWith("t3") || address.startsWith("t2") ? "p2sh" : address.startsWith("z") ? "sprout" : "p2pkh";
    if (!payload || !t || (t.kind !== "sprout" && payload.length !== 22)) {
      return { ...base, kind: guess, network: address.startsWith("t1") || address.startsWith("t3") || address.startsWith("zc") ? "main" : "test", valid: false, refund: NO_REFUND, error: "bad Base58Check checksum or length" };
    }
    const transparent = t.kind !== "sprout";
    return { ...base, kind: t.kind, network: t.network, valid: true, receivers: { ...NONE, unknown: [], p2pkh: t.kind === "p2pkh", p2sh: t.kind === "p2sh" }, refund: { transparent, shielded: false } };
  }

  return { ...base, kind: "unknown", network: null, valid: false, refund: NO_REFUND, error: "not a Zcash address" };
}

/** A short plain-English name for the address and its receivers. */
export function describeZcashAddress(a: ZcashAddressInfo): string {
  if (!a.valid) return a.kind === "unknown" ? "not a Zcash address" : `an invalid ${a.kind === "unified" ? "unified" : a.kind} address (${a.error ?? "checksum"})`;
  switch (a.kind) {
    case "p2pkh":
      return "a transparent t-address";
    case "p2sh":
      return "a transparent P2SH t-address";
    case "tex":
      return "a TEX address (ZIP-320, transparent-only)";
    case "sapling":
      return "a Sapling z-address";
    case "sprout":
      return "a Sprout z-address";
    case "unknown":
      return "not a Zcash address";
    case "unified": {
      const r = a.receivers;
      const names = [r.orchard && "Orchard", r.sapling && "Sapling", r.p2pkh && "transparent", r.p2sh && "transparent P2SH"].filter((x): x is string => typeof x === "string");
      return `a unified address (${names.join(" + ") || "no known"} receiver${names.length === 1 ? "" : "s"})`;
    }
  }
}
