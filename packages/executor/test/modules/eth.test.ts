import { describe, it, expect, vi, afterEach } from "vitest";
import { Eth } from "../../src/modules/eth.js";
import { FrameTxSimulationService } from "../../src/services/FrameTxSimulationService/index.js";
import { ReceiptService } from "../../src/services/ReceiptService/index.js";
import { MempoolService } from "../../src/services/MempoolService/service.js";
import { Skandha } from "../../src/modules/skandha.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  recognizeValidationPrefix,
  validateStructuralRules,
} from "../../src/services/UserOpValidation/utils/validationPrefix.js";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { ExplorerService } from "../../src/services/ExplorerService/service.js";
import { keccak256 } from "viem";
import { encodeRawFrameTx } from "../../src/services/FrameTxService/codec.js";

/**
 * `Eth`'s constructor: (chainId, publicClient, frameTxSimulationService,
 * receiptService, mempoolService, skandhaModule, config, logger, metrics,
 * getNodeAPI, explorer). This helper passes `undefined` for `getNodeAPI`, which
 * defaults to `() => null`, so gossip publish is a no-op in these tests, and
 * forwards the optional `explorer` (11th parameter) from its overrides. There is no
 * `getSupportedEntryPoints`/`entryPointService`/`userOpValidationService` -
 * exactly one fixed ENTRY_POINT sentinel exists under EIP-8141, not a
 * configurable/validated set. There is also no `frameTxValidationService` -
 * `Eth` only ever talks to `FrameTxSimulationService`, which calls
 * `FrameTxValidationService.validate` itself and returns its result
 * alongside the simulation result (see that class's header comment).
 */
function buildEth(overrides: Partial<{
  frameTxSimulationService: Partial<FrameTxSimulationService>;
  receiptService: Partial<ReceiptService>;
  mempoolService: Partial<MempoolService>;
  skandhaModule: Partial<Skandha>;
  explorer: ExplorerService;
  publicClient: unknown;
}> = {}): Eth {
  const frameTxSimulationService = {
    simulate: vi.fn().mockResolvedValue({
      simulation: {
        cumulativeGasUsed: "0x100",
        payer: "0x1111111111111111111111111111111111111111",
        frameReceipts: [],
      },
      validation: {
        mempoolMembership: { "": true },
        accessedSlots: {},
        roleStakes: {},
      },
    }),
    ...overrides.frameTxSimulationService,
  } as unknown as FrameTxSimulationService;

  const receiptService = {
    getReceipt: vi.fn(),
    ...overrides.receiptService,
  } as unknown as ReceiptService;

  const mempoolService = {
    getEntryByHash: vi.fn().mockResolvedValue(null),
    validateFrameTxReplaceability: vi.fn().mockResolvedValue(true),
    addFrameTx: vi.fn().mockResolvedValue(undefined),
    ...overrides.mempoolService,
  } as unknown as MempoolService;

  const skandhaModule = {
    getGasPrice: vi.fn().mockResolvedValue({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
    ...overrides.skandhaModule,
  } as unknown as Skandha;

  const config = {
    userOpGasLimit: 25_000_000,
    cglMarkup: 0,
    cglMarkupPercent: 0,
    vglMarkup: 0,
    vglMarkupPercent: 0,
    pvgMarkup: 0,
    pvgMarkupPercent: 0,
  } as any;

  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  } as any;

  return new Eth(
    1337,
    (overrides.publicClient ?? {}) as any,
    frameTxSimulationService,
    receiptService,
    mempoolService,
    skandhaModule,
    config,
    logger,
    null,
    undefined, // getNodeAPI: use the default
    overrides.explorer
  );
}

describe("Eth.sendFrameTransaction", () => {
  it("rejects a transaction whose validation prefix is not recognized", async () => {
    // sendFrameTransaction only ever talks to frameTxSimulationService now -
    // FrameTxValidationService.validate runs inside simulate(), so a
    // rejection from admission-gate validation is modeled by rejecting
    // simulate() itself, not a (now nonexistent) direct validate() call.
    const eth = buildEth({
      frameTxSimulationService: {
        simulate: vi.fn().mockRejectedValue(
          new RpcError("frame transaction validation prefix not recognized", -32502)
        ),
      },
    });
    const malformedTx = { frames: [] } as any; // empty frames list — invalid per EIP-8141 Constraints
    await expect(eth.sendFrameTransaction(malformedTx)).rejects.toThrow();
  });

  const validTx = () =>
    ({
      chainId: 1337n,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: "0x1111111111111111111111111111111111111111",
      frames: [
        {
          mode: 1,
          flags: 3,
          target: null,
          limits: { execution: 1n, state: 0n },
          value: 0n,
          data: "0x",
        },
      ],
      signatures: [],
      fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
      recentRootReferences: [],
    }) as any;

  it("rejects a transaction for another chain before simulating it", async () => {
    const simulate = vi.fn();
    const eth = buildEth({ frameTxSimulationService: { simulate } });
    await expect(eth.sendFrameTransaction({ ...validTx(), chainId: 9n })).rejects.toMatchObject({
      code: RpcErrorCodes.INVALID_USEROP,
      message: expect.stringMatching(/chain id 9 does not match .* 1337/),
    });
    expect(simulate).not.toHaveBeenCalled();
  });

  it.each([0n, 2n ** 64n])("rejects chain id %s", async (chainId) => {
    const eth = buildEth();
    await expect(eth.sendFrameTransaction({ ...validTx(), chainId })).rejects.toBeInstanceOf(RpcError);
  });

  it("records the wrong-chain rejection under the structure rule", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    await expect(eth.sendFrameTransaction({ ...validTx(), chainId: 9n })).rejects.toThrow();
    const record = explorer.listAdmissions({}).items[0]!;
    expect(record.outcome).toBe("rejected");
    expect(record.checks.find((c) => c.rule === "structure")).toMatchObject({ verdict: "fail" });
  });

  describe("EIP-8272 recent-root window (before simulating)", () => {
    const HEAD = 261_223n;
    const headClient = (slot: bigint | null) => ({
      request: vi.fn().mockResolvedValue(slot === null ? {} : { slotNumber: `0x${slot.toString(16)}` }),
    });
    const withRef = (slot: bigint) => ({
      ...validTx(),
      nonceKeys: [7n],
      recentRootReferences: [{ sourceId: `0x${"a".repeat(64)}`, slot, root: `0x${"b".repeat(64)}` }],
    });

    it.each([
      ["expired", HEAD - 8191n, /expired: usable through slot 261223/],
      ["too new", HEAD + 1n, /not referenceable before slot 261225/],
    ])("rejects a %s reference without simulating, under the recent-root rule", async (_, slot, message) => {
      const simulate = vi.fn();
      const explorer = new ExplorerService();
      const eth = buildEth({ frameTxSimulationService: { simulate }, publicClient: headClient(HEAD), explorer });
      await expect(eth.sendFrameTransaction(withRef(slot))).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_USEROP,
        message: expect.stringMatching(message),
      });
      expect(simulate).not.toHaveBeenCalled();
      const record = explorer.listAdmissions({}).items[0]!;
      expect(record.checks.filter((c) => c.rule === "recent-root")).toEqual([
        expect.objectContaining({ verdict: "fail" }),
      ]);
    });

    it("lets an in-window reference through to the simulation, which decides on commitment", async () => {
      const addFrameTx = vi.fn().mockResolvedValue(undefined);
      const eth = buildEth({ publicClient: headClient(HEAD), mempoolService: { addFrameTx, getEntryByHash: vi.fn(), validateFrameTxReplaceability: vi.fn().mockResolvedValue(true) } });
      await expect(eth.sendFrameTransaction(withRef(HEAD - 8190n))).resolves.toMatch(/^0x/);
      await expect(eth.sendFrameTransaction(withRef(HEAD))).resolves.toMatch(/^0x/);
      expect(addFrameTx).toHaveBeenCalledTimes(2);
    });

    it("leaves the window to ethrex when the chain reports no slot", async () => {
      const simulate = vi.fn().mockRejectedValue(new RpcError("simulated", -32500));
      const eth = buildEth({ frameTxSimulationService: { simulate }, publicClient: headClient(null) });
      await expect(eth.sendFrameTransaction(withRef(1n))).rejects.toThrow("simulated");
      expect(simulate).toHaveBeenCalledTimes(1);
    });

    it("passes the rule at once for a transaction without references", async () => {
      const explorer = new ExplorerService();
      const eth = buildEth({ explorer });
      await eth.sendFrameTransaction(validTx());
      const record = explorer.listAdmissions({}).items[0]!;
      expect(record.checks.filter((c) => c.rule === "recent-root")).toEqual([
        expect.objectContaining({ verdict: "pass" }),
      ]);
    });
  });

  it("hands ethrex's maxCost to the mempool for balance accounting", async () => {
    const addFrameTx = vi.fn().mockResolvedValue(undefined);
    const eth = buildEth({
      mempoolService: { addFrameTx, getEntryByHash: vi.fn(), validateFrameTxReplaceability: vi.fn().mockResolvedValue(true) },
      frameTxSimulationService: {
        simulate: vi.fn().mockResolvedValue({
          simulation: { cumulativeGasUsed: "0x100", payer: "0x1111111111111111111111111111111111111111", frameReceipts: [] },
          validation: { mempoolMembership: { "": true }, accessedSlots: {}, roleStakes: {}, maxCost: 4242n },
        }),
      },
    });
    await eth.sendFrameTransaction(validTx());
    expect(addFrameTx.mock.calls[0][6]).toBe(4242n);
  });

  it("stores an accepted transaction in the mempool and returns its hash", async () => {
    const addFrameTx = vi.fn().mockResolvedValue(undefined);
    const eth = buildEth({ mempoolService: { addFrameTx, getEntryByHash: vi.fn(), validateFrameTxReplaceability: vi.fn().mockResolvedValue(true) } });
    const tx = validTx();

    const hash = await eth.sendFrameTransaction(tx);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(addFrameTx).toHaveBeenCalledTimes(1);
  });
});

describe("Eth.getChainId", () => {
  it("returns the configured chain id", async () => {
    const eth = buildEth();
    await expect(eth.getChainId()).resolves.toBe(1337);
  });
});

describe("Eth (getSupportedEntryPoints removed)", () => {
  it("no longer exposes getSupportedEntryPoints or validateEntryPoint", () => {
    const eth = buildEth();
    expect((eth as any).getSupportedEntryPoints).toBeUndefined();
    expect((eth as any).validateEntryPoint).toBeUndefined();
  });
});

/**
 * Self Relay validation-prefix shape: `[self_verify]` (see
 * `validationPrefix.ts`'s `recognizeValidationPrefix` doc comment) - a
 * single VERIFY-mode frame with flags == APPROVE_SCOPE.EXECUTION_AND_PAYMENT
 * (3), targeting `null` (implicitly tx.sender). frame index 0 is therefore
 * the whole validation prefix (`lastPrefixIndex === 0`); any frame after it
 * is a "body" frame.
 */
const SELF_VERIFY_FRAME = {
  mode: 1,
  flags: 3,
  target: null,
  limits: { execution: 50_000n, state: 50_000n },
  value: 0n,
  data: "0x",
} as const;

const BODY_FRAME = {
  mode: 2, // FRAME_MODE.SENDER
  flags: 0,
  target: "0x2222222222222222222222222222222222222222",
  // Deliberately tiny caller-supplied guess - estimateFrameTransactionGas is
  // supposed to override THIS with the placeholder, not the prefix frame's.
  limits: { execution: 1n, state: 1n },
  value: 0n,
  data: "0x",
} as const;

function buildEstimateTx(): Partial<FrameTransaction> {
  return {
    sender: "0x1111111111111111111111111111111111111111",
    frames: [{ ...SELF_VERIFY_FRAME }, { ...BODY_FRAME }],
  };
}

describe("Eth.estimateFrameTransactionGas", () => {
  it(
    "does not trip the real EIP-8141 validation-prefix gas caps for a normal " +
      "estimate request (regression test for B1: the old code slapped the " +
      "placeholder on EVERY frame, including the validation prefix, which " +
      "always exceeded MAX_VERIFY_GAS/MAX_VERIFY_STATE_GAS and rejected " +
      "every single call)",
    async () => {
      // A `simulate` stub that ACTUALLY enforces EIP-8141's structural gas
      // caps via the real, unmodified recognizeValidationPrefix/
      // validateStructuralRules (the same functions
      // FrameTxValidationService.validate uses internally) - not a bare
      // always-resolves mock. With the pre-fix code (placeholder applied to
      // ALL frames, including the validation prefix), this stub would
      // reject every call, exactly like the real
      // FrameTxSimulationService.simulate did.
      const simulate = vi.fn(async (tx: FrameTransaction) => {
        const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
        if (prefix == null) {
          throw new RpcError(
            "frame transaction validation prefix not recognized",
            RpcErrorCodes.INVALID_OPCODE
          );
        }
        // No entity staked: every entity gets MAX_VERIFY_GAS_PER_ENTITY.
        const structural = validateStructuralRules(tx, prefix, () => false);
        if (!structural.valid) {
          throw new RpcError(structural.reason, RpcErrorCodes.INVALID_USEROP);
        }
        return {
          simulation: {
            cumulativeGasUsed: "0x100",
            payer: "0x1111111111111111111111111111111111111111",
            frameReceipts: tx.frames.map(() => ({
              status: "success" as const,
              gasUsed: { execution: "0x10", state: "0x10" },
              logs: [],
            })),
          },
          validation: { mempoolMembership: {}, accessedSlots: {}, roleStakes: {} },
        };
      });

      const eth = buildEth({ frameTxSimulationService: { simulate } });

      await expect(
        eth.estimateFrameTransactionGas(buildEstimateTx())
      ).resolves.toBeDefined();
      expect(simulate).toHaveBeenCalledTimes(1);
    }
  );

  it(
    "applies the placeholder gas limit only to body frames, leaving the " +
      "validation prefix's caller-supplied limits untouched (spy assertion " +
      "on the exact FrameTransaction simulate() was called with)",
    async () => {
      const simulate = vi.fn().mockResolvedValue({
        simulation: {
          cumulativeGasUsed: "0x100",
          payer: "0x1111111111111111111111111111111111111111",
          frameReceipts: [],
        },
        validation: { mempoolMembership: {}, accessedSlots: {}, roleStakes: {} },
      });
      const eth = buildEth({ frameTxSimulationService: { simulate } });

      await eth.estimateFrameTransactionGas(buildEstimateTx());

      expect(simulate).toHaveBeenCalledTimes(1);
      const calledWith = simulate.mock.calls[0][0] as FrameTransaction;
      // Prefix frame (index 0): untouched caller-supplied limits.
      expect(calledWith.frames[0].limits).toEqual({
        execution: 50_000n,
        state: 50_000n,
      });
      // Body frame (index 1): overridden with the 10e6 placeholder.
      expect(calledWith.frames[1].limits).toEqual({
        execution: BigInt(10e6),
        state: BigInt(10e6),
      });
    }
  );

  it("rejects a request with no sender", async () => {
    const eth = buildEth();
    await expect(
      eth.estimateFrameTransactionGas({ frames: [{ ...SELF_VERIFY_FRAME }] })
    ).rejects.toThrow();
  });

  it("rejects a request with no frames", async () => {
    const eth = buildEth();
    await expect(
      eth.estimateFrameTransactionGas({
        sender: "0x1111111111111111111111111111111111111111",
        frames: [],
      })
    ).rejects.toThrow();
  });
});

describe("Eth.getFrameTransactionByHash", () => {
  it("returns the serialized mempool entry when the hash is known", async () => {
    const serialized = { sender: "0x1111111111111111111111111111111111111111" };
    const getEntryByHash = vi.fn().mockResolvedValue({
      serialize: vi.fn().mockReturnValue(serialized),
    });
    const eth = buildEth({ mempoolService: { getEntryByHash } });

    const result = await eth.getFrameTransactionByHash(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );

    expect(result).toEqual(serialized);
    expect(getEntryByHash).toHaveBeenCalledWith(
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("returns null when the hash is not known to the mempool", async () => {
    const getEntryByHash = vi.fn().mockResolvedValue(null);
    const eth = buildEth({ mempoolService: { getEntryByHash } });

    const result = await eth.getFrameTransactionByHash(
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );

    expect(result).toBeNull();
  });
});

describe("Eth.getFrameTransactionReceipt", () => {
  it("delegates to receiptService.getReceipt with the given hash and returns its result", async () => {
    const receipt = {
      transactionHash: "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      payer: "0x1111111111111111111111111111111111111111",
      cumulativeGasUsed: 100n,
      frameReceipts: [],
    };
    const getReceipt = vi.fn().mockResolvedValue(receipt);
    const eth = buildEth({ receiptService: { getReceipt } });

    const result = await eth.getFrameTransactionReceipt(
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );

    expect(getReceipt).toHaveBeenCalledWith(
      "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    );
    expect(result).toEqual(receipt);
  });
});

describe("Eth.sendFrameTransaction explorer recording", () => {
  const frameTx = (limit = 1n): FrameTransaction =>
    ({
      chainId: 1337n,
      nonceKeys: [0n],
      nonceSeq: 0n,
      sender: "0x1111111111111111111111111111111111111111",
      frames: [
        {
          mode: 1,
          flags: 3,
          target: null,
          limits: { execution: limit, state: 0n },
          value: 0n,
          data: "0x",
        },
      ],
      signatures: [],
      fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
      blobVersionedHashes: [],
      recentRootReferences: [],
    }) as unknown as FrameTransaction;
  const hashOf = (tx: FrameTransaction) => keccak256(encodeRawFrameTx(tx));

  it("records an accepted admission with the given source", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx, "gossip:peerA");
    expect(explorer.getAdmission(hashOf(tx))).toMatchObject({
      outcome: "accepted",
      source: "gossip:peerA",
    });
  });

  it("defaults the source to rpc", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx);
    expect(explorer.getAdmission(hashOf(tx))?.source).toBe("rpc");
  });

  it("records a rejected admission with the failing rule when simulation rejects", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      frameTxSimulationService: {
        simulate: vi.fn().mockRejectedValue(new RpcError("frame transaction simulation failed", -32502)),
      },
    });
    const tx = frameTx();
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("frame transaction simulation failed");
    const rec = explorer.getAdmission(hashOf(tx));
    expect(rec).toMatchObject({ outcome: "rejected", errorCode: -32502 });
    // simulate() was mocked, so no validator rule claimed the failure:
    expect(rec?.checks.find((c) => c.verdict === "fail")).toMatchObject({
      rule: "admission",
      detail: "frame transaction simulation failed",
    });
    expect(explorer.getEvents(hashOf(tx))).toEqual([
      expect.objectContaining({ kind: "rejected", reason: "frame transaction simulation failed" }),
    ]);
  });

  it("carries the collector's frame receipts into an accepted admission record", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      frameTxSimulationService: {
        simulate: vi.fn(async (_tx, collector) => {
          collector?.setFrameReceipts([
            { status: "success", gasUsed: { execution: "0x64", state: "0x0" }, logs: [] },
          ]);
          return {
            simulation: { cumulativeGasUsed: "0x100", payer: "0x1111111111111111111111111111111111111111", frameReceipts: [] },
            validation: { mempoolMembership: { "": true }, accessedSlots: {}, roleStakes: {} },
          };
        }),
      },
    });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx);
    const rec = explorer.getAdmission(hashOf(tx));
    expect(rec?.frameStatuses).toEqual(["success"]);
    expect(rec?.frames).toHaveLength(1);
  });

  it("carries the collector's frame receipts into a rejected admission record", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      frameTxSimulationService: {
        simulate: vi.fn(async (_tx, collector) => {
          collector?.setFrameReceipts([
            { status: "reverted", gasUsed: { execution: "0x64", state: "0x0" }, logs: [] },
          ]);
          throw new RpcError("sender uses banned opcode: TIMESTAMP", -32502);
        }),
      },
    });
    const tx = frameTx();
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow();
    const rec = explorer.getAdmission(hashOf(tx));
    expect(rec?.frameStatuses).toEqual(["reverted"]);
  });

  it("records a failed 'gas-limit' check when the transaction's limits are too high", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({ explorer });
    const tx = frameTx(30_000_000n); // config.userOpGasLimit is 25_000_000
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("gas limit is too high");
    expect(explorer.getAdmission(hashOf(tx))?.checks).toContainEqual(
      expect.objectContaining({ rule: "gas-limit", verdict: "fail" })
    );
  });

  it("records a failed 'mempool' check when the mempool refuses the transaction", async () => {
    const explorer = new ExplorerService();
    const eth = buildEth({
      explorer,
      mempoolService: {
        validateFrameTxReplaceability: vi
          .fn()
          .mockRejectedValue(new RpcError("Frame transaction cannot be replaced: fee too low", -32602)),
      },
    });
    const tx = frameTx();
    await expect(eth.sendFrameTransaction(tx)).rejects.toThrow("fee too low");
    expect(explorer.getAdmission(hashOf(tx))?.checks).toContainEqual(
      expect.objectContaining({ rule: "mempool", verdict: "fail" })
    );
  });

  it("marks the old transaction replaced when addFrameTx reports a replacement", async () => {
    const explorer = new ExplorerService();
    const oldTx = { ...frameTx(), nonceSeq: 7n } as FrameTransaction;
    explorer.recordAdmission({
      tx: oldTx,
      txHash: "0xold",
      source: "rpc",
      outcome: "accepted",
      checks: [],
    });
    const eth = buildEth({
      explorer,
      mempoolService: { addFrameTx: vi.fn().mockResolvedValue({ replacedTxHash: "0xold" }) },
    });
    const tx = frameTx();
    await eth.sendFrameTransaction(tx);
    expect(explorer.getAdmission("0xold")?.outcome).toBe("replaced");
    expect(explorer.getAdmission(hashOf(tx))?.outcome).toBe("accepted");
  });

  it("does not let a duplicate resubmission's rejection overwrite the accepted record", async () => {
    const explorer = new ExplorerService();
    const tx = frameTx();
    await buildEth({ explorer }).sendFrameTransaction(tx); // accepted
    const failing = buildEth({
      explorer,
      mempoolService: {
        validateFrameTxReplaceability: vi
          .fn()
          .mockRejectedValue(new RpcError("Frame transaction cannot be replaced: fee too low", -32602)),
      },
    });
    await expect(failing.sendFrameTransaction(tx)).rejects.toThrow();
    expect(explorer.getAdmission(hashOf(tx))?.outcome).toBe("accepted");
  });

  it("does not append a 'rejected' lifecycle event for a refused resubmission of an accepted tx", async () => {
    const explorer = new ExplorerService();
    const tx = frameTx();
    await buildEth({ explorer }).sendFrameTransaction(tx); // accepted
    const failing = buildEth({
      explorer,
      mempoolService: {
        validateFrameTxReplaceability: vi
          .fn()
          .mockRejectedValue(new RpcError("Frame transaction cannot be replaced: fee too low", -32602)),
      },
    });
    await expect(failing.sendFrameTransaction(tx)).rejects.toThrow();
    expect(explorer.getEvents(hashOf(tx)).filter((e) => e.kind === "rejected")).toEqual([]);
  });

  describe("when explorer bookkeeping throws", () => {
    it("still resolves with the hash, persists the tx once and records no rejection", async () => {
      const explorer = new ExplorerService();
      vi.spyOn(explorer, "recordAdmission").mockImplementation(() => {
        throw new Error("boom");
      });
      const addFrameTx = vi.fn().mockResolvedValue(undefined);
      const eth = buildEth({ explorer, mempoolService: { addFrameTx } });
      const tx = frameTx();
      await expect(eth.sendFrameTransaction(tx)).resolves.toBe(hashOf(tx));
      expect(addFrameTx).toHaveBeenCalledTimes(1);
      expect(explorer.getEvents(hashOf(tx)).filter((e) => e.kind === "rejected")).toEqual([]);
    });

    it("rethrows the original RpcError, not the explorer's error", async () => {
      const explorer = new ExplorerService();
      vi.spyOn(explorer, "recordAdmission").mockImplementation(() => {
        throw new Error("boom");
      });
      const original = new RpcError("frame transaction simulation failed", -32502);
      const eth = buildEth({
        explorer,
        frameTxSimulationService: { simulate: vi.fn().mockRejectedValue(original) },
      });
      await expect(eth.sendFrameTransaction(frameTx())).rejects.toBe(original);
    });
  });

  describe("admission time", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is captured when the request is received, not after simulation", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const explorer = new ExplorerService();
      const eth = buildEth({
        explorer,
        frameTxSimulationService: {
          simulate: vi.fn().mockImplementation(async () => {
            vi.advanceTimersByTime(500);
            return {
              simulation: { cumulativeGasUsed: "0x100", payer: "0x1111111111111111111111111111111111111111", frameReceipts: [] },
              validation: { mempoolMembership: { "": true }, accessedSlots: {}, roleStakes: {} },
            };
          }),
        },
      });
      const tx = frameTx();
      await eth.sendFrameTransaction(tx);
      expect(explorer.getAdmission(hashOf(tx))?.at).toBe(1_700_000_000_000);
    });

    it("is also the receive time for a rejected admission", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_700_000_000_000);
      const explorer = new ExplorerService();
      const eth = buildEth({
        explorer,
        frameTxSimulationService: {
          simulate: vi.fn().mockImplementation(async () => {
            vi.advanceTimersByTime(500);
            throw new RpcError("frame transaction simulation failed", -32502);
          }),
        },
      });
      const tx = frameTx();
      await expect(eth.sendFrameTransaction(tx)).rejects.toThrow();
      expect(explorer.getAdmission(hashOf(tx))?.at).toBe(1_700_000_000_000);
    });
  });

  it("records nothing and behaves as before when no explorer is configured", async () => {
    const eth = buildEth();
    await expect(eth.sendFrameTransaction(frameTx())).resolves.toMatch(/^0x/);
  });
});
