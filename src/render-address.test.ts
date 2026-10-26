// The address check's words, shared by the CLI and the page.
import { describe, expect, it } from "vitest";

import { asZcashAddress, renderAddressText } from "./render-address.js";

describe("asZcashAddress", () => {
  it("takes any Zcash address, even a mistyped one, and nothing else", () => {
    expect(asZcashAddress(" t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU1 ")?.valid).toBe(true);
    expect(asZcashAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU2")?.valid).toBe(false);
    expect(asZcashAddress("9deffb31135e3cdf6a62088d8639166673fe91c0e150fd9c80f6e61bba2bec39")).toBeNull();
    expect(asZcashAddress("bc1qyp0a54gjhej46zdztq5w0ux2waqg3kacls7q2t")).toBeNull();
  });
});

describe("renderAddressText", () => {
  it("a TEX address: the plain next step, both wallets, and the refund it can take", () => {
    const a = asZcashAddress("tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte");
    expect(a).not.toBeNull();
    const text = renderAddressText(a!);
    expect(text).toContain("What this means for you: This is a TEX address, so send from a transparent balance.");
    expect(text).toContain("✓ From a transparent-only wallet: Yes, if your wallet accepts TEX addresses (ZIP 320)");
    expect(text).toContain("✕ From a shielded wallet: No.");
    expect(text).toContain("As a refund address on the Omni bridge: it can take a transparent refund");
    expect(text).toContain("nothing is looked up or sent anywhere");
  });

  it("a mistyped address gets no refund line", () => {
    const text = renderAddressText(asZcashAddress("t1LSvEjCZBHAedhmQtqY9V4BBfP3xkqHXU2")!);
    expect(text).toContain("Don't send: a character in this address is wrong");
    expect(text).not.toContain("As a refund address");
  });
});
