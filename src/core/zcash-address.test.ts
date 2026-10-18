// Zcash address parsing (ZIP-316 unified addresses: Bech32m, F4Jumble, typecodes) checked against the official
// zcash-test-vectors (src/fixtures/zip316/vectors.json, a subset of test-vectors/json/{unified_address,f4jumble}.json),
// RFC 7693 / hashlib for BLAKE2b, and real refund addresses from mainnet deposit messages (2026-10).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { blake2b, classifyZcashAddress, decodeUnifiedAddress, f4jumble, f4jumbleInv, sha256 } from "./zcash-address.js";

interface Vectors {
  unified: { p2pkh: string | null; p2sh: string | null; sapling: string | null; orchard: string | null; unknown_typecode: number | null; unknown: string | null; address: string }[];
  f4jumble: { normal: string; jumbled: string }[];
}
const vectors = JSON.parse(readFileSync(new URL("../fixtures/zip316/vectors.json", import.meta.url), "utf8")) as Vectors;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const bytes = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("hash primitives", () => {
  it("BLAKE2b-512 of 'abc' (RFC 7693 appendix A)", () => {
    expect(hex(blake2b(ascii("abc"), 64))).toBe("ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");
  });

  it("BLAKE2b with a shorter output and with a personalization (as Python's hashlib computes them)", () => {
    expect(hex(blake2b(new Uint8Array(0), 32))).toBe("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8");
    const person = (s: string, tail: number[]): Uint8Array => Uint8Array.from([...ascii(s), ...tail]);
    expect(hex(blake2b(Uint8Array.from({ length: 200 }, (_, i) => i), 24, person("UA_F4Jumble_H", [1, 0, 0])))).toBe("277589f3d5b6e52d36148612974a00737872cd66b0282934");
    expect(hex(blake2b(Uint8Array.from({ length: 128 }, (_, i) => i), 64, person("UA_F4Jumble_G", [0, 1, 0])))).toBe(
      "5dd781a7b69a86e78daec1cf510d1440f431aa3de539360e74cf07f277b033929be786a87675e6724a32a5ca4fe2301a32c3ff25f1f84b1858a282b90bee8a1c",
    );
  });

  it("SHA-256 (for Base58Check)", () => {
    expect(hex(sha256(ascii("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(Uint8Array.from({ length: 100 }, (_, i) => i)))).toBe("bce0aff19cf5aa6a7469a30d61d04e4376e4bbf6381052ee9e7f33925c954d52");
  });
});

describe("F4Jumble (ZIP-316 test vectors)", () => {
  it.each(vectors.f4jumble.map((v) => [v.normal.length / 2, v] as const))("%i bytes: jumbles and unjumbles", (_n, v) => {
    expect(hex(f4jumble(bytes(v.normal)))).toBe(v.jumbled);
    expect(hex(f4jumbleInv(bytes(v.jumbled)))).toBe(v.normal);
  });

  // The official vectors start at 48 bytes, but ZIP-316 and librustzcash now accept 38 (`VALID_LENGTH = 38..=4194368`:
  // a transparent-only Revision 2 `tu` address). This vector comes from an independent Python F4Jumble written from the
  // ZIP-316 text, which reproduces every official vector above.
  it("38 bytes, the current minimum: jumbles and unjumbles", () => {
    const normal = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425";
    const jumbled = "a2337d4890be24f7a6b5d8687c56676503f4a0e8fb025907e2229b47e25ecc12e76995a4ca2c";
    expect(hex(f4jumble(bytes(normal)))).toBe(jumbled);
    expect(hex(f4jumbleInv(bytes(jumbled)))).toBe(normal);
  });

  it("rejects an input shorter than 38 bytes", () => {
    expect(() => f4jumble(new Uint8Array(37))).toThrow("F4Jumble input must be 38 to 4194368 bytes");
    expect(() => f4jumbleInv(new Uint8Array(37))).toThrow("F4Jumble input must be 38 to 4194368 bytes");
  });
});

describe("decodeUnifiedAddress (ZIP-316 test vectors)", () => {
  it.each(vectors.unified.map((v) => [v.address.slice(0, 16), v] as const))("%s…: every receiver and typecode", (_a, v) => {
    const ua = decodeUnifiedAddress(v.address);
    if ("error" in ua) throw new Error(ua.error);
    expect(ua.network).toBe("main");
    const item = (t: number): string | null => {
      const it = ua.items.find((i) => i.typecode === t);
      return it ? hex(it.data) : null;
    };
    expect(item(0)).toBe(v.p2pkh);
    expect(item(1)).toBe(v.p2sh);
    expect(item(2)).toBe(v.sapling);
    expect(item(3)).toBe(v.orchard);
    if (v.unknown_typecode !== null) expect(item(v.unknown_typecode)).toBe(v.unknown);
  });

  it("rejects a corrupted checksum and a non-unified string", () => {
    const good = vectors.unified[0]?.address ?? "";
    const bad = good.slice(0, -1) + (good.endsWith("q") ? "p" : "q");
    expect(decodeUnifiedAddress(bad)).toEqual({ error: "bad Bech32m checksum" });
    expect("error" in decodeUnifiedAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1")).toBe(true);
  });

  it("rejects a 69-character u1 address for holding only a transparent receiver, not for its length", () => {
    // 38 bytes before Bech32m: one P2PKH item (typecode 0, 20 bytes) plus the HRP padding, jumbled and encoded by an
    // independent Python implementation that re-encodes every official vector byte for byte. A Revision 0 (`u`) address
    // MUST contain a shielded item (ZIP-316), so this is invalid whatever its length.
    const transparentOnly = "u148mzm4a9fwtn9jf2u2sq8zpzhgkdkj7k05fk3jh2vtzdxjzsue9nq3pap6k5jka40wl";
    expect(transparentOnly).toHaveLength(69);
    expect(decodeUnifiedAddress(transparentOnly)).toEqual({ error: "a unified address needs a non-transparent item" });
  });
});

describe("classifyZcashAddress", () => {
  it("a real transparent t1 refund address (deposit 6de202d6…, 2026-10-13): transparent refund only", () => {
    expect(classifyZcashAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1")).toMatchObject({
      kind: "p2pkh",
      network: "main",
      valid: true,
      refund: { transparent: true, shielded: false },
    });
  });

  it("a real unified refund address with an Orchard receiver (deposit 04dc643f…, funded from the Ironwood pool)", () => {
    const a = classifyZcashAddress(
      "u1egfcnx27m4406w892hrp96n8akl66juj8pn0agqa2w2zrylpmq5yurssz0tlq3k4rmhag7y6kljezxp6me4j3h03ezs0tzrqynz2tdcnwenqqepl85f6qcxekcjv60wheqyyt5lk560t0m3tx7y2zqzwr56wr9fg76dumq08jspxmncv",
    );
    // Orchard + Sapling and no transparent receiver: the bundle-less execute_refund cannot pay it.
    expect(a).toMatchObject({ kind: "unified", network: "main", valid: true, receivers: { p2pkh: false, p2sh: false, sapling: true, orchard: true }, refund: { transparent: false, shielded: true } });
  });

  it("a real Orchard-only unified address (deposit 477f3d00…): shielded refund only, the transparent path cannot pay it", () => {
    const a = classifyZcashAddress("u1r9ffm4hq7q2xcv4mwfhd0mpe0aw22klu9zxzsyr7shkx5rh77s0u3vpuc0vjchh7hvczldd8mwxgcydzyluhtd4h0zejlc5p5qzn5wn0");
    expect(a).toMatchObject({ kind: "unified", valid: true, receivers: { p2pkh: false, p2sh: false, sapling: false, orchard: true }, refund: { transparent: false, shielded: true } });
  });

  it("ZIP-316 vectors: a UA with a transparent receiver can take either refund; a Sapling-only UA neither", () => {
    const tAndOrchard = vectors.unified.find((v) => v.p2pkh && v.orchard && !v.sapling && !v.unknown);
    const saplingOnly = vectors.unified.find((v) => v.sapling && !v.p2pkh && !v.orchard && !v.unknown);
    expect(classifyZcashAddress(tAndOrchard?.address ?? "").refund).toEqual({ transparent: true, shielded: true });
    expect(classifyZcashAddress(saplingOnly?.address ?? "")).toMatchObject({ kind: "unified", receivers: { sapling: true, orchard: false }, refund: { transparent: false, shielded: false } });
  });

  it("a Sapling zs1 address (synthetic: the Sapling payload of a ZIP-316 vector, Bech32-encoded): the connector cannot refund to it", () => {
    const sapling = vectors.unified.find((v) => v.sapling)?.sapling ?? "";
    const a = classifyZcashAddress(encodeBech32ForTest("zs", bytes(sapling)));
    expect(a).toMatchObject({ kind: "sapling", network: "main", valid: true, refund: { transparent: false, shielded: false } });
  });

  it("a mistyped t-address fails its Base58Check checksum", () => {
    expect(classifyZcashAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU2")).toMatchObject({ kind: "p2pkh", valid: false, refund: { transparent: false, shielded: false } });
    expect(classifyZcashAddress("hello")).toMatchObject({ kind: "unknown", valid: false });
  });
});

// A minimal Bech32 (not m) encoder, only to build the synthetic Sapling address above.
function encodeBech32ForTest(hrp: string, data: Uint8Array): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of data) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const polymod = (values: number[]): number => {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i] ?? 0;
    }
    return chk;
  };
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}
