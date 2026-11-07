import { describe, it, expect, vi } from "vitest";
import { PublicClient } from "viem";
import { FrameTxSimulationService } from "../../../src/services/FrameTxSimulationService/index.js";
import { FrameTxValidationService } from "../../../src/services/UserOpValidation/validators/frameTx.js";
import { StakingRegistryService } from "../../../src/services/StakingRegistryService/index.js";
import { ReputationService } from "../../../src/services/ReputationService.js";
import { NetworkConfig } from "../../../src/interfaces.js";
import { CheckCollector } from "../../../src/services/ExplorerService/checkCollector.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
} from "@skandha/types/lib/contracts/FrameTx.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x5555555555555555555555555555555555555555" as const;
const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;

const selfVerifyFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

const onlyVerifyFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.EXECUTION,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

const payFrame = (target: `0x${string}`): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.PAYMENT,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

const baseTx = (frames: Frame[]): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames,
  signatures: [],
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

function fakePublicClient(response: any): PublicClient {
  return { request: vi.fn().mockResolvedValue(response) } as unknown as PublicClient;
}

function fakeStakingRegistry(): StakingRegistryService {
  return {
    getDepositInfo: vi.fn(async () => ({ stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n })),
  } as unknown as StakingRegistryService;
}

function fakeReputationService(): ReputationService {
  return {
    checkStake: vi.fn(async () => ({ code: 0, msg: "" })),
  } as unknown as ReputationService;
}

const fakeNetworkConfig = (): NetworkConfig =>
  ({
    minStake: 1_000_000_000n,
    precompiles: [],
    whitelistedEntities: {},
    relayOpsWithWhitelistedEntities: false,
  }) as unknown as NetworkConfig;

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn() }) as any;

function emptyAccessedSlots() {
  return { reads: {}, writes: {}, transientReads: {}, transientWrites: {} };
}

// The one ethrex_simulateFrameTransaction({trace: true}) response
// FrameTxSimulationService.simulate() fetches and reuses for both
// FrameTxValidationService.validate() (erc7562Trace) and its own
// gas/receipt mapping (gasUsed/frames/payer) - see FrameTxSimulationService's
// header comment.
function passingEthrexResult(): any {
  const root = {
    from: ENTRY_POINT,
    to: SENDER,
    type: "CALL",
    accessedSlots: emptyAccessedSlots(),
    extCodeAccessInfo: [],
    usedOpcodes: {},
    contractSize: {},
    outOfGas: false,
  };
  return {
    canonicalMempoolValid: true,
    prefixShape: "SelfVerify",
    payer: SENDER,
    maxCost: "0x0",
    canonicalMempoolViolation: null,
    gasUsed: "0x64",
    frames: [{ gasUsed: "0x64", succeeded: true }],
    executionStatus: "success",
    executionError: null,
    erc7562Trace: [{ frameIndex: 0, root }],
    erc7562TraceError: null,
  };
}

describe("FrameTxSimulationService.simulate", () => {
  it("returns a per-frame status/gas_used array matching tx.frames.length for a two-frame tx", async () => {
    const root0 = {
      from: ENTRY_POINT,
      to: SENDER,
      type: "CALL",
      accessedSlots: emptyAccessedSlots(),
      extCodeAccessInfo: [],
      usedOpcodes: {},
      contractSize: {},
      outOfGas: false,
    };
    const root1 = { ...root0, to: PAYER };
    const ethrexResult = {
      canonicalMempoolValid: true,
      prefixShape: "SelfVerify",
      payer: SENDER,
      maxCost: "0x0",
      canonicalMempoolViolation: null,
      gasUsed: "0x100",
      frames: [
        { gasUsed: "0x40", succeeded: true },
        { gasUsed: "0x60", succeeded: false },
      ],
      executionStatus: "reverted",
      executionError: null,
      erc7562Trace: [
        { frameIndex: 0, root: root0 },
        { frameIndex: 1, root: root1 },
      ],
      erc7562TraceError: null,
    };

    const publicClient = fakePublicClient(ethrexResult);
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );

    // Canonical Paymaster, Basic Tx shape: [only_verify, pay] - a real
    // recognized 2-frame validation prefix, so FrameTxValidationService's
    // own frameIndex<->trace-level alignment invariant (which this same RPC
    // response also has to satisfy, since validate() is simulate()'s
    // admission gate) is honored by construction.
    const tx = baseTx([onlyVerifyFrame(), payFrame(PAYER)]);

    const { simulation, validation } = await service.simulate(tx);

    expect(simulation.frameReceipts).toHaveLength(2);
    expect(simulation.frameReceipts[0]).toEqual({
      status: "success",
      gasUsed: { execution: "0x40", state: "0x0" },
      logs: [],
    });
    expect(simulation.frameReceipts[1]).toEqual({
      status: "reverted",
      gasUsed: { execution: "0x60", state: "0x0" },
      logs: [],
    });
    expect(simulation.cumulativeGasUsed).toBe("0x100");
    expect(simulation.payer).toBe(SENDER);
    expect(validation.mempoolMembership).toBeDefined();

    // Regression guard for the redundant-RPC-calls fix: exactly one
    // ethrex_simulateFrameTransaction call for the whole simulate() - not
    // one traced (via validate()) plus one untraced, as it used to be.
    expect(publicClient.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a predicted revert when the payer is not the sender, naming the failing frame", async () => {
    const root = {
      from: ENTRY_POINT,
      to: SENDER,
      type: "CALL",
      accessedSlots: emptyAccessedSlots(),
      extCodeAccessInfo: [],
      usedOpcodes: {},
      contractSize: {},
      outOfGas: false,
    };
    const ethrexResult = {
      canonicalMempoolValid: true,
      prefixShape: "SelfVerify",
      payer: PAYER,
      maxCost: "0x0",
      canonicalMempoolViolation: null,
      gasUsed: "0x100",
      frames: [
        { gasUsed: "0x40", succeeded: true },
        { gasUsed: "0x60", succeeded: false },
      ],
      executionStatus: "reverted",
      executionError: null,
      erc7562Trace: [
        { frameIndex: 0, root },
        { frameIndex: 1, root: { ...root, to: PAYER } },
      ],
      erc7562TraceError: null,
    };
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      fakePublicClient(ethrexResult),
      frameTxValidationService,
      fakeLogger()
    );
    const tx = baseTx([onlyVerifyFrame(), payFrame(PAYER)]);

    await expect(service.simulate(tx)).rejects.toMatchObject({
      code: RpcErrorCodes.VALIDATION_FAILED,
      message: expect.stringContaining("revert at frame 1"),
    });
  });

  it("fails closed with an RpcError carrying ethrex's violation reason when no trace/gas data was produced", async () => {
    const invalidResult = {
      canonicalMempoolValid: false,
      prefixShape: null,
      payer: null,
      maxCost: "0x0",
      canonicalMempoolViolation: "total gas limit exceeds the per-transaction gas cap",
      gasUsed: null,
      frames: null,
      executionStatus: null,
      executionError: null,
      erc7562Trace: null,
      erc7562TraceError: null,
    };

    const publicClient = fakePublicClient(invalidResult);
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );

    const tx = baseTx([selfVerifyFrame()]);

    // validate(tx, result) is handed this same invalidResult and fails
    // closed first, so the surfaced RpcError comes from
    // FrameTxValidationService.validate(), not simulate()'s own fail-closed
    // check below it - both read the same `canonicalMempoolViolation` field
    // off the same result, so the assertion holds either way. The real
    // trigger here is `gasUsed`/`frames`/`erc7562Trace` all being `null`
    // (genuinely no data), not `canonicalMempoolValid` alone - see the
    // "still simulates successfully" test below for the case where
    // `canonicalMempoolValid` is false but real data is present.
    await expect(service.simulate(tx)).rejects.toThrow(RpcError);
    await expect(service.simulate(tx)).rejects.toMatchObject({
      code: RpcErrorCodes.VALIDATION_FAILED,
      message: expect.stringContaining("total gas limit exceeds"),
    });
  });

  it("still simulates successfully when canonicalMempoolValid is false but real execution/trace data is present", async () => {
    // ethrex's canonical-mempool-policy opinion is reported separately from
    // whether it ran and reported execution results - a `false`
    // canonicalMempoolValid does not imply missing data. This proves
    // neither simulate()'s own gate nor FrameTxValidationService.validate()'s
    // gate treats canonicalMempoolValid as fail-closed on its own: the sidecar's
    // own ERC-7562 checks against the real trace are the actual admission
    // gate now.
    const result = passingEthrexResult();
    result.canonicalMempoolValid = false;
    result.canonicalMempoolViolation = "gas cap exceeded";

    const publicClient = fakePublicClient(result);
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );

    const tx = baseTx([selfVerifyFrame()]);

    const { simulation, validation } = await service.simulate(tx);

    expect(simulation.cumulativeGasUsed).toBe("0x64");
    expect(validation.mempoolMembership).toBeDefined();
  });

  it("propagates FrameTxValidationService.validate()'s admission-gate rejection unchanged", async () => {
    // A structurally-unrecognized single frame (VERIFY, flags NONE i.e.
    // expiry_verify with nothing else) fails recognizeValidationPrefix -
    // proving simulate() really does call validate(tx, result) as its
    // admission gate, not just its own fail-closed check below it. Unlike
    // before this class fetched its own simResult first and reused it
    // (rather than validate() fetching its own), a structurally-invalid tx
    // no longer short-circuits before the RPC call - it still rejects
    // correctly, just after paying for the one round-trip simulate() always
    // makes now.
    const unrecognizedFrame: Frame = {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.NONE,
      target: null,
      limits: { execution: 1n, state: 0n },
      value: 0n,
      data: "0x",
    };

    const publicClient = fakePublicClient(passingEthrexResult());
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );

    const tx = baseTx([unrecognizedFrame]);

    await expect(service.simulate(tx)).rejects.toThrow(RpcError);
    await expect(service.simulate(tx)).rejects.toMatchObject({
      code: RpcErrorCodes.INVALID_OPCODE,
      message: expect.stringContaining("validation prefix not recognized"),
    });
  });

  it("sets the collector's frame receipts from the trace even when validate() rejects the tx", async () => {
    // Same unrecognized-prefix rejection as above, but this time asserting
    // that the trace's per-frame receipts reached the collector before
    // validate() threw - the explorer needs them for a rejected tx's detail
    // page, which never gets simulate()'s own return value.
    const unrecognizedFrame: Frame = {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.NONE,
      target: null,
      limits: { execution: 1n, state: 0n },
      value: 0n,
      data: "0x",
    };

    const publicClient = fakePublicClient(passingEthrexResult());
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );

    const tx = baseTx([unrecognizedFrame]);
    const collector = new CheckCollector();

    await expect(service.simulate(tx, collector)).rejects.toThrow(RpcError);

    expect(collector.getFrameReceipts()).toEqual([
      { status: "success", gasUsed: { execution: "0x64", state: "0x0" }, logs: [] },
    ]);
  });

  it("leaves the collector's frame receipts unset when the trace itself has no frames", async () => {
    const invalidResult = {
      canonicalMempoolValid: false,
      prefixShape: null,
      payer: null,
      maxCost: "0x0",
      canonicalMempoolViolation: "total gas limit exceeds the per-transaction gas cap",
      gasUsed: null,
      frames: null,
      executionStatus: null,
      executionError: null,
      erc7562Trace: null,
      erc7562TraceError: null,
    };
    const publicClient = fakePublicClient(invalidResult);
    const frameTxValidationService = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    const service = new FrameTxSimulationService(
      publicClient,
      frameTxValidationService,
      fakeLogger()
    );
    const tx = baseTx([selfVerifyFrame()]);
    const collector = new CheckCollector();

    await expect(service.simulate(tx, collector)).rejects.toThrow(RpcError);

    expect(collector.getFrameReceipts()).toBeUndefined();
  });
});

describe("FrameTxSimulationService.simulate: ethrex call failures", () => {
  const build = (request: () => Promise<unknown>) => {
    const publicClient = { request: vi.fn(request) } as unknown as PublicClient;
    const validation = new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );
    return new FrameTxSimulationService(publicClient, validation, fakeLogger());
  };
  const tx = () => baseTx([selfVerifyFrame()]);

  it("turns an ethrex JSON-RPC error into an RpcError with ethrex's own text, recorded under the simulation rule", async () => {
    const detail = "Vm execution error: Invalid Transaction: Insufficient max fee per gas";
    const service = build(() =>
      Promise.reject(Object.assign(new Error("RPC request failed."), { name: "RpcRequestError", details: detail, code: -32000 }))
    );
    const collector = new CheckCollector();
    await expect(service.simulate(tx(), collector)).rejects.toMatchObject({
      code: RpcErrorCodes.VALIDATION_FAILED,
      message: detail,
    });
    expect(collector.toChecks().find((c) => c.rule === "simulation")).toMatchObject({ verdict: "fail", detail });
  });

  it("explains ethrex's generic prefix revert with the payer's balance when it cannot afford the transaction", async () => {
    const rejectWith = () =>
      Promise.reject(
        Object.assign(new Error("RPC request failed."), { name: "RpcRequestError", details: "validation prefix frame reverted", code: -32000 })
      );
    const publicClient = { request: vi.fn(rejectWith) } as unknown as PublicClient;
    const getBalance = vi.fn(async () => 5n);
    const validation = new FrameTxValidationService(fakeStakingRegistry(), fakeReputationService(), fakeNetworkConfig(), fakeLogger(), getBalance);
    const service = new FrameTxSimulationService(publicClient, validation, fakeLogger());
    const t = { ...tx(), frames: [{ ...selfVerifyFrame(), limits: { execution: 30_000n, state: 0n } }] };
    const collector = new CheckCollector();
    const err = await service.simulate(t, collector).catch((e) => e);
    // the transaction's maximum cost is its gas limits times maxFeePerGas: 30000 * 2
    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toMatch(/validation prefix frame reverted: payer 0x1111\S+ has 5 wei, the transaction's maximum cost is 60000 wei/);
    expect(collector.toChecks().find((c) => c.rule === "simulation")?.detail).toMatch(/has 5 wei/);
  });

  it("keeps a transport failure a plain Error, but names the cause instead of an opaque token", async () => {
    const service = build(() => Promise.reject(new Error("fetch failed")));
    const collector = new CheckCollector();
    const err = await service.simulate(tx(), collector).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RpcError);
    expect(err.message).toMatch(/fetch failed/);
    expect(err.message).not.toBe("simulateFrameTransaction_failed");
    expect(collector.toChecks().find((c) => c.rule === "simulation")?.detail).toMatch(/fetch failed/);
  });
});
