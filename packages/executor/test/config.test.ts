import { describe, it, expect } from "vitest";
import { Config } from "../src/config.js";

describe("Config.explorerEnabled", () => {
  it("is false unless the explorer option is set", () => {
    const off = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    const on = new Config({
      config: null,
      unsafeMode: false,
      redirectRpc: false,
      explorer: true,
    });
    expect(off.explorerEnabled).toBe(false);
    expect(on.explorerEnabled).toBe(true);
  });
});

describe("Config.getNetworkConfig stakingRegistryAddress", () => {
  it("defaults to the zero address when SKANDHA_STAKING_REGISTRY_ADDRESS is unset", () => {
    const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
    expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
      "0x0000000000000000000000000000000000000000"
    );
  });

  it("picks up SKANDHA_STAKING_REGISTRY_ADDRESS from the environment", () => {
    const previous = process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
    process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = "0x1111111111111111111111111111111111111111";
    try {
      const config = new Config({ config: null, unsafeMode: false, redirectRpc: false });
      expect(config.getNetworkConfig().stakingRegistryAddress).toBe(
        "0x1111111111111111111111111111111111111111"
      );
    } finally {
      if (previous === undefined) delete process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
      else process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = previous;
    }
  });

  it("throws immediately on a malformed SKANDHA_STAKING_REGISTRY_ADDRESS, instead of silently failing every admission later", () => {
    const previous = process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
    process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = "0xnotanaddress";
    try {
      expect(() => new Config({ config: null, unsafeMode: false, redirectRpc: false })).toThrow();
    } finally {
      if (previous === undefined) delete process.env.SKANDHA_STAKING_REGISTRY_ADDRESS;
      else process.env.SKANDHA_STAKING_REGISTRY_ADDRESS = previous;
    }
  });
});

describe("Config.getNetworkConfig BUDGET-010 budgets", () => {
  const withEnv = (env: Record<string, string>, fn: () => void) => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(env)) {
      prev[k] = process.env[k];
      process.env[k] = env[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(env)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };

  it("defaults to ERC-8421's MAX_VERIFY_GAS_PER_ENTITY 100000 / MAX_VERIFY_GAS_STAKED_ENTITY 1000000", () => {
    const nc = new Config({ config: null, unsafeMode: false, redirectRpc: false }).getNetworkConfig();
    expect(nc.maxVerifyGasPerEntity).toBe(100_000);
    expect(nc.maxVerifyGasStakedEntity).toBe(1_000_000);
  });

  it("reads SKANDHA_MAX_VERIFY_GAS_PER_ENTITY / SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY", () => {
    withEnv({ SKANDHA_MAX_VERIFY_GAS_PER_ENTITY: "250000", SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY: "2500000" }, () => {
      const nc = new Config({ config: null, unsafeMode: false, redirectRpc: false }).getNetworkConfig();
      expect(nc.maxVerifyGasPerEntity).toBe(250_000);
      expect(nc.maxVerifyGasStakedEntity).toBe(2_500_000);
    });
  });

  it("rejects a staked budget below the unstaked one, and non-positive values", () => {
    withEnv({ SKANDHA_MAX_VERIFY_GAS_PER_ENTITY: "500000", SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY: "400000" }, () => {
      expect(() => new Config({ config: null, unsafeMode: false, redirectRpc: false })).toThrow(/maxVerifyGasStakedEntity/);
    });
    withEnv({ SKANDHA_MAX_VERIFY_GAS_PER_ENTITY: "0" }, () => {
      expect(() => new Config({ config: null, unsafeMode: false, redirectRpc: false })).toThrow(/maxVerifyGasPerEntity/);
    });
  });
});
