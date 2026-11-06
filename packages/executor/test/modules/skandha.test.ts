import { describe, it, expect, vi } from "vitest";
import { Skandha } from "../../src/modules/skandha.js";
import { MempoolService } from "../../src/services/MempoolService/service.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";

/**
 * `Skandha`'s constructor: (mempoolService, chainId, publicClient, config,
 * logger, getNodeAPI). There is no `entryPointService` - no EntryPoint
 * concept exists for an EIP-8141 frame transaction.
 */
function buildSkandha(overrides: Partial<{
  mempoolService: Partial<MempoolService>;
  networkConfig: Record<string, unknown>;
}> = {}): Skandha {
  const mempoolService = {
    getEntryByHash: vi.fn().mockResolvedValue(null),
    ...overrides.mempoolService,
  } as unknown as MempoolService;

  const config = {
    getNetworkConfig: vi.fn().mockReturnValue(overrides.networkConfig ?? ({} as any)),
    getRelayers: vi.fn().mockReturnValue([]),
    testingMode: false,
    redirectRpc: false,
  } as any;

  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as any;

  return new Skandha(
    mempoolService,
    1337,
    {} as any, // publicClient
    config,
    logger,
    () => null
  );
}

describe("Skandha.getFrameTransactionStatus", () => {
  it("returns tx/sender/payer/factory/status resolved from the mempool entry", async () => {
    const entry = {
      tx: { sender: "0x1111111111111111111111111111111111111111" },
      sender: "0x1111111111111111111111111111111111111111",
      payer: "0x2222222222222222222222222222222222222222",
      factory: "0x3333333333333333333333333333333333333333",
      status: MempoolEntryStatus.New,
      revertReason: undefined,
      actualTransaction: undefined,
      transaction: undefined,
    };
    const getEntryByHash = vi.fn().mockResolvedValue(entry);
    const skandha = buildSkandha({ mempoolService: { getEntryByHash } });

    const result = await skandha.getFrameTransactionStatus(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );

    expect(result.tx).toBe(entry.tx);
    expect(result.sender).toBe(entry.sender);
    expect(result.payer).toBe(entry.payer);
    expect(result.factory).toBe(entry.factory);
    expect(result.status).toBe("New");
  });

  it("throws when the hash is not known to the mempool", async () => {
    const getEntryByHash = vi.fn().mockResolvedValue(null);
    const skandha = buildSkandha({ mempoolService: { getEntryByHash } });

    await expect(
      skandha.getFrameTransactionStatus(
        "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      )
    ).rejects.toThrow(RpcError);
  });
});

describe("Skandha.getConfig", () => {
  it("reports stakingRegistryAddress, so a tester can confirm which registry a running node uses", async () => {
    const networkConfig = {
      entryPoints: [],
      beneficiary: "",
      minInclusionDenominator: 10,
      throttlingSlack: 10,
      banSlack: 50,
      minStake: 1_000_000_000n,
      minUnstakeDelay: 0,
      minSignerBalance: 0n,
      multicall: "0x0",
      estimationStaticBuffer: 0,
      validationGasLimit: 0,
      receiptLookupRange: 1024,
      etherscanApiKey: "",
      conditionalTransactions: false,
      rpcEndpointSubmit: "",
      rpcEndpointSubmitMethod: "eth_sendBundle",
      gasPriceMarkup: 0,
      enforceGasPrice: false,
      enforceGasPriceThreshold: 0,
      eip1559: true,
      eip2930: false,
      useropsTTL: 300,
      whitelistedEntities: {},
      bundleGasLimitMarkup: 0,
      maxConcurrentSubmissions: 10,
      bundleInterval: 10000,
      pollingInterval: 3000,
      maxSubmitAttempts: 3,
      bundleSize: 4,
      standardMempoolId: "",
      canonicalEntryPoint: "",
      supportedMempools: [],
      gasFeeInSimulation: false,
      skipBundleValidation: false,
      pvgMarkup: 0,
      cglMarkup: 0,
      vglMarkup: 0,
      paymasterVglMarkup: 0,
      paymasterPoglMarkup: 0,
      estimationGasLimit: 0,
      archiveDuration: 86400,
      pvgMarkupPercent: 0,
      cglMarkupPercent: 0,
      vglMarkupPercent: 0,
      paymasterVglMarkupPercent: 0,
      paymasterPoglMarkupPercent: 0,
      userOpGasLimit: 25_000_000,
      bundleGasLimit: 25_000_000,
      blockscoutUrl: "",
      blockscoutApiKeys: [],
      tenderlyApiUrl: false,
      tenderlyKey: false,
      tenderlySave: true,
      rpcTimeout: "10s",
      disableWatchContract: false,
      epSimulationsContract: "",
      pimlicoSimulationsContract: "",
      binarySearchMaxRetries: 3,
      precompiles: [],
      relayOpsWithWhitelistedEntities: false,
      stakingRegistryAddress: "0x61D818a79103de5a832b3d996AE7Db2b7911FF59",
    };
    const skandha = buildSkandha({ networkConfig });

    const result = await skandha.getConfig();

    expect(result.stakingRegistryAddress).toBe(
      "0x61D818a79103de5a832b3d996AE7Db2b7911FF59"
    );
  });
});

describe("Skandha (getFeeHistory removed)", () => {
  it("no longer exposes getFeeHistory (no EIP-8141 UserOperationEvent-log analogue)", () => {
    const skandha = buildSkandha();
    expect((skandha as any).getFeeHistory).toBeUndefined();
  });
});

describe("Skandha.getConfig budgets (skandha_config)", () => {
  it("advertises the BUDGET-010 per-entity budgets the node enforces", async () => {
    const skandha = buildSkandha({
      networkConfig: { minStake: 10n ** 16n, minUnstakeDelay: 0, minSignerBalance: 0n, blockscoutApiKeys: [], maxVerifyGasPerEntity: 100_000, maxVerifyGasStakedEntity: 1_000_000 },
    });
    const cfg = await skandha.getConfig();
    expect(cfg.budgets).toEqual({
      rule: "BUDGET-010",
      maxVerifyGasPerEntity: 100_000,
      maxVerifyGasStakedEntity: 1_000_000,
      signatureCostAttributedTo: "sender",
      maxVerifyStateGas: 500_000,
    });
  });
});
