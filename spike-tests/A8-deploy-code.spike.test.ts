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

// A8 probe: H-S40 re-run through the FULL validator, with the client's own
// canonical-mempool verdict populated the way ethrex returns it.
//
// Context: H-S40 originally asserted `recognizeValidationPrefix` returns null for
// `[DEFAULT, self_verify]`. That assertion was wrong against EIP-8141 - the EIP
// treats a leading DEFAULT as the `deploy` frame and lists `[deploy, self_verify]`
// as a recognized shape; `pre_verify` does not exist in EIP-8141 at all. So H-S40
// as written is withdrawn (see notes/A8-version-and-h-s40.md).
//
// What survives is a different question: EIP-8141 §Mempool §Validation Trace Rules
// requires rejecting a transaction whose deploy frame "does not result in non-empty
// code being installed at tx.sender"; ERC-8421 §PREFIX-020 says the deploy frame
// "MUST result in a successful deployment of the tx.sender contract". ethrex
// enforces this and reports `DeployInstalledNoCode`
// (ethrex crates/vm/backends/levm/mod.rs:3296-3305) in
// `canonical_mempool_violation`, while still returning the trace
// (ethrex crates/networking/rpc/ethrex.rs:74-79: a false verdict "does NOT prevent
// gas_used/frames/erc7562_trace from being populated").
//
// The sidecar deliberately ignores that verdict
// (validators/frameTx.ts:360-377: "canonicalMempoolValid is deliberately NOT part
// of this condition ... everything downstream is Skandha's own admission gate") and
// has no check of its own that the deploy installed code - only CREATE/CREATE2
// opcode counts (validators/frameTx.ts:714-737).
//
// These probes assert what the spec requires; a failure means the sidecar admits a
// transaction the client already condemned. No network, no real client.
// Marked `it.fails`: the assertion states behaviour the spec requires and the code
// does not implement today. When someone fixes it this test starts FAILING, which is
// the intended signal that the probe can be flipped back to a plain `it`.

const SENDER = "0x9999999999999999999999999999999999999999";
const FACTORY = "0x5555555555555555555555555555555555555555";

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

function trace(
  from: `0x${string}`,
  to: `0x${string}`,
  opcodes: { [opcode: string]: number },
  contractSize: { [addr: string]: { contractSize: number; opcode: number } }
): FrameCallTraceFrame {
  return {
    from,
    to,
    type: "CALL",
    value: "0x0",
    accessedSlots: EMPTY_SLOTS,
    extCodeAccessInfo: [],
    usedOpcodes: opcodes,
    contractSize,
    outOfGas: false,
  };
}

function deploySelfVerifyTx(): FrameTransaction {
  return {
    chainId: BigInt(1),
    nonceKeys: [BigInt(0)],
    nonceSeq: BigInt(0),
    sender: SENDER,
    frames: [
      frame(FRAME_MODE.DEFAULT, 0, FACTORY),
      frame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION_AND_PAYMENT, SENDER),
    ],
    signatures: [
      { scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" },
    ],
    fees: {
      maxPriorityFeePerGas: BigInt(1),
      maxFeePerGas: BigInt(1),
      maxFeePerBlobGas: BigInt(0),
    },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

// The factory ran but issued no CREATE/CREATE2/SETDELEGATE (0xf0/0xf5/0xf6):
// nothing could have installed code at tx.sender.
function noCodeInstalledSim(violation: string): EthrexSimulateFrameTransactionResult {
  return {
    canonicalMempoolValid: false,
    canonicalMempoolViolation: violation,
    prefixShape: "DeploySelfVerify",
    payer: SENDER,
    maxCost: "0x100000",
    gasUsed: "0x2000",
    frames: [
      { gasUsed: "0x1", succeeded: true },
      { gasUsed: "0x1", succeeded: true },
    ],
    executionStatus: "success",
    executionError: null,
    erc7562Trace: [
      entry(0, trace(ENTRY_POINT, FACTORY, {}, {
        [FACTORY]: { contractSize: 120, opcode: 0xf5 },
      })),
      entry(1, trace(ENTRY_POINT, SENDER, {}, {})),
    ],
    erc7562TraceError: null,
  };
}

function entry(frameIndex: number, root: FrameCallTraceFrame) {
  return { frameIndex, root };
}

function makeValidator() {
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
  return new FrameTxValidationService(
    stakingRegistryService as any,
    reputationService as any,
    networkConfig as any,
    logger as any
  );
}

describe("A8 deploy-installed-code rule (EIP-8141 Validation Trace Rules / ERC-8421 PREFIX-020)", () => {
  it.fails("rejects when the client says the deploy installed no sender code", async () => {
    const validator = makeValidator();
    await expect(
      validator.validate(deploySelfVerifyTx(), noCodeInstalledSim("DeployInstalledNoCode"))
    ).rejects.toBeDefined();
  });

  it.fails("does not silently discard any other client canonical-mempool violation", async () => {
    const validator = makeValidator();
    await expect(
      validator.validate(
        deploySelfVerifyTx(),
        noCodeInstalledSim("CallToNonexistentOrDelegated(0x4444444444444444444444444444444444444444)")
      )
    ).rejects.toBeDefined();
  });
});
