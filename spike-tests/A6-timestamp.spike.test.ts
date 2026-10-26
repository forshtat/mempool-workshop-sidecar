import { describe, expect, it, vi } from "vitest";
import { FrameTxValidationService } from "../packages/executor/src/services/UserOpValidation/validators/frameTx";
import {
  APPROVE_SCOPE,
  EXPIRY_VERIFIER,
  FRAME_MODE,
  SIG_SCHEME,
  type Frame,
  type FrameTransaction,
} from "../packages/types/src/contracts/FrameTx";
import type {
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
} from "../packages/types/src/executor/validation/ethrexFrameTx";

// A6 probe (found AFTER the A3 hypothesis list, so it is not one of H-S1..S80).
//
// The client's ERC-7562 dispatch check bans TIMESTAMP *except* when the current
// frame's target is EXPIRY_VERIFIER - see ethrex
// `crates/vm/levm/src/vm.rs:4186-4199`. The sidecar's own banned-opcode re-check
// lists TIMESTAMP unconditionally (`validators/frameTx.ts:72`) and aggregates
// nested-call opcodes into the role's set (`UserOpValidation/utils.ts:113-124`),
// and `EXPIRY_VERIFIER` is exported but never referenced anywhere in the sidecar
// (grep finds only its definition, `contracts/FrameTx.ts:175`).
//
// So a prefix frame that legitimately reads TIMESTAMP inside expiry-verifier code
// is admitted by the client and rejected by the sidecar. This probe asserts what
// the client allows; a failure means the sidecar rejects it.
//
// Mocks ONLY the execution-client boundary (a hand-built trace). No network.
// Marked `it.fails`: the assertion states behaviour the spec requires and the code
// does not implement today. When someone fixes it this test starts FAILING, which is
// the intended signal that the probe can be flipped back to a plain `it`.

const SENDER = "0x9999999999999999999999999999999999999999";
const PAYER = "0x2222222222222222222222222222222222222222";
const TIMESTAMP_OPCODE = "66"; // 0x42, decimal-string key, see ethrexFrameTx.ts:19-23

function baseFrame(
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

const EMPTY_SLOTS = {
  reads: {},
  writes: {},
  transientReads: {},
  transientWrites: {},
};

function traceFrame(
  to: `0x${string}`,
  opcodes: { [opcode: string]: number },
  calls?: FrameCallTraceFrame[]
): FrameCallTraceFrame {
  return {
    from: SENDER,
    to,
    type: "CALL",
    value: "0x0",
    calls,
    accessedSlots: EMPTY_SLOTS,
    extCodeAccessInfo: [],
    usedOpcodes: opcodes,
    contractSize: {},
    outOfGas: false,
  };
}

describe("A6 TIMESTAMP inside EXPIRY_VERIFIER is not a banned opcode", () => {
  it.fails("accepts a sender frame whose nested call to the expiry verifier reads TIMESTAMP", async () => {
    const tx: FrameTransaction = {
      chainId: BigInt(1),
      nonceKeys: [BigInt(0)],
      nonceSeq: BigInt(0),
      sender: SENDER,
      frames: [
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, SENDER),
        baseFrame(FRAME_MODE.DEFAULT, 0, PAYER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, PAYER),
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

    // The sender's verify frame CALLs the expiry verifier; TIMESTAMP is executed
    // inside that nested scope, which is exactly where the client allows it.
    const senderRoot = traceFrame(SENDER, {}, [
      traceFrame(EXPIRY_VERIFIER, { [TIMESTAMP_OPCODE]: 1 }),
    ]);

    const simResult: EthrexSimulateFrameTransactionResult = {
      canonicalMempoolValid: true,
      prefixShape: "OnlyVerifyPay",
      payer: PAYER,
      maxCost: "0x100000",
      canonicalMempoolViolation: null,
      gasUsed: "0x1000",
      frames: [
        { gasUsed: "0x1", succeeded: true },
        { gasUsed: "0x1", succeeded: true },
        { gasUsed: "0x1", succeeded: true },
      ],
      executionStatus: "success",
      executionError: null,
      erc7562Trace: [
        { frameIndex: 0, root: senderRoot },
        { frameIndex: 1, root: traceFrame(PAYER, {}) },
        { frameIndex: 2, root: traceFrame(PAYER, {}) },
      ],
      erc7562TraceError: null,
    };

    const stakingRegistryService = {
      getDepositInfo: vi.fn(async (addr: `0x${string}`) => ({
        addr,
        stake: BigInt(0),
        unstakeDelaySec: 0,
        withdrawTime: BigInt(0),
      })),
    };
    const reputationService = {
      checkStake: vi.fn(async () => ({ code: 0, msg: "" })),
    };
    const networkConfig = {
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
    };
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const validator = new FrameTxValidationService(
      stakingRegistryService as any,
      reputationService as any,
      networkConfig as any,
      logger as any
    );

    // No rejection expected: the client would never have emitted TIMESTAMP in
    // this trace unless the expiry-verifier carve-out applied.
    await expect(validator.validate(tx, simResult)).resolves.toBeDefined();
  });
});
