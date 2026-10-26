import { describe, expect, it, vi } from "vitest";
import { FrameTxValidationService } from "../packages/executor/src/services/UserOpValidation/validators/frameTx";
import {
  APPROVE_SCOPE,
  ENTRY_POINT,
  FRAME_MODE,
  SIG_SCHEME,
  type Frame,
  type FrameTransaction,
} from "../packages/types/src/contracts/FrameTx";
import type {
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
} from "../packages/types/src/executor/validation/ethrexFrameTx";

// A12 probe (question 3): what the sidecar does with a prefix that never sets a
// payer.
//
// ethrex rejects such a prefix with "validation prefix did not establish a payer"
// (crates/vm/backends/levm/mod.rs:3288-3296), reports `payer: null` and
// `canonicalMempoolValid: false`, but still returns the full trace and per-frame
// results (crates/networking/rpc/ethrex.rs:100-110). The sidecar ignores the
// verdict (validators/frameTx.ts:364-371) and derives roles from the *recognized
// prefix*, never from `simResult.payer`, so this probe asks whether an
// unapproved prefix is admitted anyway.
//
// Mocks only the execution-client boundary. No network.
// Marked `it.fails`: the assertion states behaviour the spec requires and the code
// does not implement today. When someone fixes it this test starts FAILING, which is
// the intended signal that the probe can be flipped back to a plain `it`.

const SENDER = "0x9999999999999999999999999999999999999999";

const EMPTY_SLOTS = {
  reads: {},
  writes: {},
  transientReads: {},
  transientWrites: {},
};

function frame(
  mode: number,
  flags: number,
  target: `0x${string}` | null
): Frame {
  return {
    mode: mode as Frame["mode"],
    flags,
    target,
    limits: { execution: BigInt(10_000), state: BigInt(1_000) },
    value: BigInt(0),
    data: "0x",
  };
}

function root(to: `0x${string}`): FrameCallTraceFrame {
  return {
    from: ENTRY_POINT,
    to,
    type: "CALL",
    value: "0x0",
    accessedSlots: EMPTY_SLOTS,
    extCodeAccessInfo: [],
    usedOpcodes: {},
    contractSize: {},
    outOfGas: false,
  };
}

describe("A12 prefix that never sets a payer", () => {
  it.fails("rejects a transaction the client reports as payer-less", async () => {
    const tx: FrameTransaction = {
      chainId: BigInt(1),
      nonceKeys: [BigInt(0)],
      nonceSeq: BigInt(0),
      sender: SENDER,
      // A well-formed self_verify shape whose APPROVE never landed: the client
      // reports payer = null.
      frames: [
        frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION_AND_PAYMENT, SENDER),
      ],
      signatures: [
        {
          scheme: SIG_SCHEME.ARBITRARY,
          signer: "0x",
          msg: "0x",
          signature: "0x",
        },
      ],
      fees: {
        maxPriorityFeePerGas: BigInt(1),
        maxFeePerGas: BigInt(1),
        maxFeePerBlobGas: BigInt(0),
      },
      blobVersionedHashes: [],
      recentRootReferences: [],
    };

    const simResult: EthrexSimulateFrameTransactionResult = {
      canonicalMempoolValid: false,
      canonicalMempoolViolation: "validation prefix did not establish a payer",
      prefixShape: "SelfVerify",
      payer: null,
      maxCost: "0x100000",
      gasUsed: "0x1000",
      frames: [{ gasUsed: "0x1", succeeded: true }],
      executionStatus: "success",
      executionError: null,
      erc7562Trace: [{ frameIndex: 0, root: root(SENDER) }],
      erc7562TraceError: null,
    };

    const validator = new FrameTxValidationService(
      {
        getDepositInfo: vi.fn(async (addr: `0x${string}`) => ({
          addr,
          stake: BigInt(0),
          unstakeDelaySec: 0,
          withdrawTime: BigInt(0),
        })),
      } as any,
      { checkStake: vi.fn(async () => ({ code: 0, msg: "" })) } as any,
      {
        minStake: BigInt(1),
        whitelistedEntities: {
          account: [],
          paymaster: [],
          factory: [],
          external: [],
        },
        precompiles: [],
        relayOpsWithWhitelistedEntities: false,
        standardMempoolId: "test-mempool",
      } as any,
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any
    );

    await expect(validator.validate(tx, simResult)).rejects.toBeDefined();
  });
});
