import { describe, expect, it } from "vitest";
import { invokeTimeoutMs } from "./invoke-timeout";

describe("AI matching transport deadline", () => {
  it("leaves a margin beyond the ten-minute local backend deadline in both adapters", () => {
    expect(invokeTimeoutMs("suggest_import_matches")).toBeGreaterThan(600_000);
    expect(invokeTimeoutMs("suggest_import_matches")).toBe(660_000);
    expect(invokeTimeoutMs("unrelated_command")).toBe(300_000);
  });
});
