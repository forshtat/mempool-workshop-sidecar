import { describe, expect, it, vi } from "vitest";
import { FrameTxValidationService } from "../packages/executor/src/services/UserOpValidation/validators/frameTx";
import {
  APPROVE_SCOPE,
  FRAME_MODE,
  SIG_SCHEME,
  type Frame,
  type FrameTransaction,
} from "../packages/types/src/contracts/FrameTx";
import type {
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
} from "../packages/types/src/executor/validation/ethrexFrameTx";

// A4 spike for H-S45 — CONDITIONAL, see notes/A8-version-and-h-s40.md §4.
//
// Two caveats now attach to this probe: (a) reachability depends on U-6
// (whether ethrex's tracer records a 0-size `contractSize` entry for a called
// EOA - if it does, R18 catches it and there is no gap); (b) ERC-8421 PREFIX-110
// contradicts PREFIX-100/CALLING-010 for a default-code target, so the claim is
// better stated via EIP-8141's own CALL*/EXTCODE* trace rule than via PREFIX-110.
//
// A4 spike for H-S45 (spec S45): a `pre_verify` frame's target must have
// deployed code (PREFIX-110 deployed-code half, deferred). R18
// (`frameTx.ts:810-828`) only inspects addresses already present in the
// trace's `contractSize` map, so an empty map means the loop sees nothing
// and cannot throw.
// Mocks ONLY the execution-client boundary: the
// `ethrex_simulateFrameTransaction` result object is constructed by hand
// (empty `contractSize`, as ethrex fixtures produce by default). No import
// from `packages/executor/test/fixtures/*`, no network.
// Marked `it.fails`: the assertion states behaviour the spec requires and the code
// does not implement today. When someone fixes it this test starts FAILING, which is
// the intended signal that the probe can be flipped back to a plain `it`.

const SENDER = "0x9999999999999999999999999999999999999999";
const PAYER = "0x2222222222222222222222222222222222222222";

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

function traceRoot(to: `0x${string}`): FrameCallTraceFrame {
  return {
    from: SENDER,
    to,
    type: "CALL",
    value: "0x0",
    accessedSlots: {
      reads: {},
      writes: {},
      transientReads: {},
      transientWrites: {},
    },
    extCodeAccessInfo: [],
    usedOpcodes: {},
    // Empty map: the ethrex default in fixtures. R18 iterates this map, so
    // an undeployed (EOA) pre_verify target reached through this trace sees
    // no COD-010 check at all.
    contractSize: {},
    outOfGas: false,
  };
}

describe("H-S45 pre_verify deployed-code requirement (S45)", () => {
  it.fails(
    "rejects a pre_verify frame targeting an undeployed (EOA) address",
    async () => {
      // [only_verify(sender), pre_verify(DEFAULT, target=P), pay(target=P)]:
      // the pre_verify DEFAULT targets P, an EOA with no deployed code.
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
          { frameIndex: 0, root: traceRoot(SENDER) },
          { frameIndex: 1, root: traceRoot(PAYER) },
          { frameIndex: 2, root: traceRoot(PAYER) },
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

      // Spec S45 requires rejection (`accesses un-deployed contract ...`);
      // admission here would confirm the deferred half is a live hole.
      await expect(validator.validate(tx, simResult)).rejects.toThrow(
        /un-deployed/
      );
    }
  );
});
