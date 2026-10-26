import { describe, expect, it } from "vitest";
import { ethers } from "ethers";

// Tooling smoke test: proves the spike-tests runner resolves both a workspace
// devDependency (vitest) and a package-level dependency (ethers) without
// touching any existing suite.
describe("spike harness", () => {
  it("runs vitest with the repo's installed deps", () => {
    expect(typeof ethers.utils.hexlify).toBe("function");
    expect(ethers.utils.hexlify(1)).toBe("0x01");
  });
});
