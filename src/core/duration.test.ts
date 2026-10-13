import { describe, expect, it } from "vitest";

import { describeDuration } from "./duration.js";

describe("describeDuration", () => {
  it("seconds, minutes, hours, then days", () => {
    expect(describeDuration(45)).toBe("45 s");
    expect(describeDuration(600)).toBe("10 min");
    expect(describeDuration(7_200)).toBe("2 h");
    expect(describeDuration(41 * 86_400)).toBe("41 days");
  });
});
