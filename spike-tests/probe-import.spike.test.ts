import { describe, expect, it } from "vitest";

describe("workspace src resolution", () => {
  it("imports executor Eth without a build", async () => {
    const mod = await import("../packages/executor/src/modules/eth");
    expect(typeof mod.Eth).toBe("function");
  });
});
