import { describe, it, expect, vi } from "vitest";
import { FrameTxValidationService } from "../../../../src/services/UserOpValidation/validators/frameTx.js";
import { StakingRegistryService } from "../../../../src/services/StakingRegistryService/index.js";
import { ReputationService } from "../../../../src/services/ReputationService.js";
import { LocalDbController } from "../../../mocks/database.js";
import { NetworkConfig } from "../../../../src/interfaces.js";
import { CheckCollector } from "../../../../src/services/ExplorerService/checkCollector.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
} from "@skandha/types/lib/contracts/FrameTx.js";

// Addresses are digit-only so viem's getAddress() checksumming is a no-op
// (no a-f hex letters to re-case), keeping every string comparison in the
// service under test byte-for-byte stable without extra normalization here.
const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x5555555555555555555555555555555555555555" as const;
const OTHER_CONTRACT = "0x6666666666666666666666666666666666666666" as const;
const SOME_SLOT =
  "0x0000000000000000000000000000000000000000000000000000000000000001" as const;

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

const preVerifyFrame = (target: `0x${string}`): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

// APPROVE_SCOPE.NONE (0) - classifyFrame's fallthrough for a VERIFY-mode
// frame is FRAME_SUBCLASS.EXPIRY_VERIFY. Per validationPrefix.ts, a leading
// expiry_verify frame is skipped for *shape* matching but its index is
// preserved in the returned frameIndex values - i.e. it shifts every
// subsequent role's frameIndex by 1 relative to its position in
// prefix.frames.
const expiryVerifyFrame = (): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags: APPROVE_SCOPE.NONE,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

// FRAME_MODE.SENDER ("user_op") - a post-prefix body frame executed with
// tx.sender as the frame's own top-level caller (per ethrex's real VM: a
// SENDER-mode frame's root scope `from` is tx.sender, NOT ENTRY_POINT -
// unlike DEFAULT/VERIFY-mode frames, see frame_tx_entry_point()).
const userOpFrame = (target: `0x${string}`): Frame => ({
  mode: FRAME_MODE.SENDER,
  flags: APPROVE_SCOPE.NONE,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x",
});

// FRAME_MODE.DEFAULT ("deploy_or_post_op") appearing AFTER the validation
// prefix is a `post_op` frame (a leading DEFAULT-mode frame would be
// `deploy` instead - see FRAME_SUBCLASS.DEPLOY_OR_POST_OP's doc comment).
// DEFAULT-mode frames' root scope also uses ENTRY_POINT as `from` (verified
// against ethrex's VM, same as VERIFY-mode), which is exactly what makes a
// post-prefix post_op frame indistinguishable from a validation-prefix
// frame under a naive array-position-based adaptation.
const postOpFrame = (target: `0x${string}`): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: APPROVE_SCOPE.NONE,
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

function fakeStakingRegistry(
  stakedAddr?: `0x${string}`,
  withdrawTime = 0n
): StakingRegistryService {
  return {
    getDepositInfo: vi.fn(async (addr: string) => {
      if (stakedAddr && addr.toLowerCase() === stakedAddr.toLowerCase()) {
        return { stake: 10_000_000_000n, unstakeDelaySec: 100, withdrawTime };
      }
      return { stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n };
    }),
  } as unknown as StakingRegistryService;
}

// `checkStakeCached` now calls `ReputationService.checkStake(info)` directly
// (info.addr, not a bare address) - see frameTx.ts's own comment. `whitelistedAddr`
// models the whitelist-bypass branch real `ReputationService.checkStake` has
// (code: 0 regardless of stake) - the exact behavior this fixture split was
// introduced to let a test exercise.
function fakeReputationService(
  stakedAddr?: `0x${string}`,
  whitelistedAddr?: `0x${string}`
): ReputationService {
  return {
    checkStake: vi.fn(async (info: { addr: string }) => {
      if (
        (whitelistedAddr &&
          info.addr.toLowerCase() === whitelistedAddr.toLowerCase()) ||
        (stakedAddr && info.addr.toLowerCase() === stakedAddr.toLowerCase())
      ) {
        return { code: 0, msg: "" };
      }
      return { code: 1, msg: "unstaked" };
    }),
  } as unknown as ReputationService;
}

const STANDARD_MEMPOOL_ID = "test-standard-mempool";

const fakeNetworkConfig = (): NetworkConfig =>
  ({
    minStake: 1_000_000_000n,
    precompiles: [],
    whitelistedEntities: {},
    relayOpsWithWhitelistedEntities: false,
    standardMempoolId: STANDARD_MEMPOOL_ID,
  }) as unknown as NetworkConfig;

const fakeLogger = () => ({ debug: vi.fn(), error: vi.fn() }) as any;

const ENTRY_POINT = "0x00000000000000000000000000000000000000aa" as const;

function emptyAccessedSlots() {
  return { reads: {}, writes: {}, transientReads: {}, transientWrites: {} };
}

// A single ethrex FrameCallTraceFrame - one per validation-prefix frame,
// `from: ENTRY_POINT` per the VERIFY-mode root-scope caller convention
// (matches ethrex's own VM, frame_tx_entry_point()).
function ethrexFrame(overrides: any = {}): any {
  return {
    from: ENTRY_POINT,
    to: SENDER,
    type: "CALL",
    value: "0x0",
    accessedSlots: emptyAccessedSlots(),
    extCodeAccessInfo: [],
    usedOpcodes: {},
    contractSize: {},
    outOfGas: false,
    ...overrides,
  };
}

// The raw `EthrexSimulateFrameTransactionResult` shape `validate()` now
// takes directly as its `simResult` argument (what `GethTracer.
// simulateFrameTransaction` would have returned for an
// `ethrex_simulateFrameTransaction` call).
function fakeEthrexResult(frames: any[]): any {
  return {
    canonicalMempoolValid: true,
    prefixShape: "SelfVerify",
    payer: SENDER,
    maxCost: "0x0",
    canonicalMempoolViolation: null,
    gasUsed: "0x64",
    frames: frames.map(() => ({ gasUsed: "0x1", succeeded: true })),
    executionStatus: "success",
    executionError: null,
    erc7562Trace: frames.map((root, frameIndex) => ({ frameIndex, root })),
    erc7562TraceError: null,
  };
}

describe("FrameTxValidationService", () => {
  describe("validate() (ethrex_simulateFrameTransaction path)", () => {
    it("accepts a clean Self Relay tx, threading a genuinely nested call through the adapter", () => {
      // Frame 0 (self_verify, role "payer") makes an inner CALL to
      // OTHER_CONTRACT with no storage access - proves the adapter's
      // recursive `calls` mapping actually threads through, not just a flat
      // single-level frame.
      const inner = ethrexFrame({ from: SENDER, to: OTHER_CONTRACT });
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [inner] });
      const ethrexResult = fakeEthrexResult([root]);

      const simResult = ethrexResult;
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      return expect(service.validate(tx, simResult)).resolves.toMatchObject({
        mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
      });
    });

    it("rejects a VERIFY-mode frame that reads storage outside tx.sender", async () => {
      // getAccessInfo groups accessedSlots per the call's own `to` (or
      // `from` for DELEGATECALL) - a cross-contract read is a nested call
      // whose own `to` is the read contract, not a field on the root's own
      // accessedSlots. Model that here.
      const innerRead = ethrexFrame({
        from: SENDER,
        to: OTHER_CONTRACT,
        accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
      });
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [innerRead] });

      const simResult = fakeEthrexResult([root]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(), // nobody staked
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_OPCODE,
      });
    });

    it("a whitelisted entity may touch unrelated storage without being staked (ReputationService.checkStake's whitelist bypass, restored)", async () => {
      // Identical scenario to the rejection above - same trace, same zero
      // on-chain stake for everyone (fakeStakingRegistry() with no staked
      // address) - except SENDER (the "payer" role's resolved entity here,
      // Self Relay shape) is whitelisted. Proves checkStakeCached now routes
      // through ReputationService.checkStake, which grants exactly this
      // bypass, rather than StakingRegistryService.checkStake, which had no
      // whitelist concept at all and would reject this unconditionally.
      const innerRead = ethrexFrame({
        from: SENDER,
        to: OTHER_CONTRACT,
        accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
      });
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [innerRead] });

      const simResult = fakeEthrexResult([root]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(), // nobody staked on-chain
        fakeReputationService(undefined, SENDER), // SENDER is whitelisted
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).resolves.toMatchObject({
        mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
      });
    });

    it("a genuinely staked entity with no pending withdrawal may touch its own associated storage (real ReputationService.checkStake, not the fake)", async () => {
      // Same read-outside-sender scenario as the base rejection test above,
      // but SENDER itself clears the real stake/delay thresholds on-chain
      // and has never called unlockStake (withdrawTime 0) - this is the
      // control case resolveRoleStakes/checkStakeCached must still accept
      // once withdrawTime starts being threaded through.
      const innerRead = ethrexFrame({
        from: SENDER,
        to: OTHER_CONTRACT,
        accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
      });
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [innerRead] });

      const simResult = fakeEthrexResult([root]);
      const realReputationService = new ReputationService(
        new LocalDbController("test-frameTx-staked-no-withdrawal"),
        1337,
        10,
        10,
        50,
        1_000_000_000n,
        0
      );
      const service = new FrameTxValidationService(
        fakeStakingRegistry(SENDER, 0n), // genuinely staked, no withdrawal initiated
        realReputationService,
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).resolves.toMatchObject({
        mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
      });
    });

    it("a staked entity that has already initiated a stake withdrawal is rejected just like an unstaked one (real ReputationService.checkStake, not the fake)", async () => {
      // Identical to the control case above - same on-chain stake/delay,
      // same storage access - except withdrawTime is non-zero (unlockStake()
      // was called). Per ERC-8421's STAKING-010, "withdrawal has not been
      // initiated" is a condition of being staked independent of stake/delay
      // - resolveRoleStakes must thread withdrawTime through for this
      // rejection to happen at all (it used to be silently dropped).
      const innerRead = ethrexFrame({
        from: SENDER,
        to: OTHER_CONTRACT,
        accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
      });
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [innerRead] });

      const simResult = fakeEthrexResult([root]);
      const realReputationService = new ReputationService(
        new LocalDbController("test-frameTx-staked-mid-withdrawal"),
        1337,
        10,
        10,
        50,
        1_000_000_000n,
        0
      );
      const service = new FrameTxValidationService(
        fakeStakingRegistry(SENDER, 999_999_999_999n), // staked, but withdrawal initiated
        realReputationService,
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_OPCODE,
      });
    });

    it("rejects a banned opcode (validators/frameTx.ts converts ethrex's decimal wire keys itself)", async () => {
      // "68" = 0x44 = DIFFICULTY, a banned opcode. This specifically proves
      // the decimal->hex conversion at the EVM_OPCODES lookup site is
      // load-bearing: without it, EVM_OPCODES["68"] is undefined and this
      // check would silently never fire.
      const root = ethrexFrame({ usedOpcodes: { "68": 1 } });

      const simResult = fakeEthrexResult([root]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_OPCODE,
      });
    });

    it("accepts a keyed-nonce, root-referencing tx whose prefix uses TXPARAM (0xb0) and RECENTROOTREFLOAD (0xb6)", async () => {
      // A shared-sender pool's verification reads nonce_keys[0] (TXPARAM 0x10)
      // and its declared root (RECENTROOTREFLOAD); both are envelope reads,
      // neither a banned opcode nor a storage access.
      const root = ethrexFrame({ usedOpcodes: { "176": 2, "182": 1 } });
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );
      const tx = {
        ...baseTx([selfVerifyFrame()]),
        nonceKeys: [0xabcn],
        recentRootReferences: [
          { sourceId: `0x${"a".repeat(64)}` as const, slot: 100n, root: `0x${"b".repeat(64)}` as const },
        ],
      };
      await expect(service.validate(tx, fakeEthrexResult([root]))).resolves.toBeDefined();
    });

    it("rejects a nested CALL with nonzero value (ERC-7562 [OP-061], unconditionally - no EntryPoint exception for a frame transaction)", async () => {
      const innerCallWithValue = ethrexFrame({
        from: SENDER,
        to: OTHER_CONTRACT,
        value: "0x1",
      });
      const root = ethrexFrame({
        from: ENTRY_POINT,
        to: SENDER,
        calls: [innerCallWithValue],
      });

      const simResult = fakeEthrexResult([root]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.INVALID_OPCODE,
      });
    });

    it("surfaces ethrex's real executionError string as the RpcError message on a reverted validation execution, instead of a generic fallback", async () => {
      // executionError is already a human-readable message from ethrex's own
      // VM (see the identical `simResult.executionError` usage a few lines
      // above validate()'s fail-closed check) - it must be thrown verbatim,
      // not routed through a raw-ABI-bytes revert decoder that only ever
      // sees a placeholder and silently falls back to a generic message.
      const root = ethrexFrame({});
      const ethrexResult = fakeEthrexResult([root]);
      ethrexResult.executionError = "reverted: custom account error";
      ethrexResult.executionStatus = "reverted";

      const simResult = ethrexResult;
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.VALIDATION_FAILED,
        message: "reverted: custom account error",
      });
    });

    it("accepts a sponsored tx with a trailing post_op frame (DEFAULT-mode frames after the prefix must not inflate the top-level-call count)", async () => {
      // [only_verify, pay, user_op, post_op]: a perfectly ordinary,
      // spec-sanctioned sponsored transaction with a post-op. The 2-frame
      // Canonical Paymaster prefix ends at frameIndex 1; frames 2 (SENDER-
      // mode user_op, from: SENDER) and 3 (DEFAULT-mode post_op, from:
      // ENTRY_POINT) come after it. Frames 0, 1 and 3 all report
      // `from: ENTRY_POINT` to ethrex's real tracer (matching real ethrex
      // behavior for VERIFY- and DEFAULT-mode frames), so an adapter that
      // discards each entry's own frameIndex and just flattens the whole
      // array would produce 3 ENTRY_POINT-attributed top-level calls where
      // only 2 are expected - triggering a spurious
      // "cannot safely correlate frameIndex to trace level" INTERNAL_ERROR
      // even though nothing is wrong with this transaction. A correct
      // implementation must limit the trace it hands to
      // checkEntityCompliance to frames 0..lastPrefixIndex (here,
      // 0..1) and resolve cleanly.
      const root0 = ethrexFrame({ from: ENTRY_POINT, to: SENDER }); // only_verify (sender role, frameIndex 0)
      const root1 = ethrexFrame({ from: ENTRY_POINT, to: PAYER }); // pay (payer role, frameIndex 1)
      const root2 = ethrexFrame({ from: SENDER, to: OTHER_CONTRACT }); // user_op body frame, frameIndex 2 - real sender as caller
      const root3 = ethrexFrame({ from: ENTRY_POINT, to: OTHER_CONTRACT }); // post_op body frame, frameIndex 3 - ENTRY_POINT as caller

      const simResult = fakeEthrexResult([root0, root1, root2, root3]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(PAYER),
        fakeReputationService(PAYER),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([
        onlyVerifyFrame(),
        payFrame(PAYER),
        userOpFrame(OTHER_CONTRACT),
        postOpFrame(OTHER_CONTRACT),
      ]);

      await expect(service.validate(tx, simResult)).resolves.toMatchObject({
        mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
      });
    });

    it("handles a leading expiry_verify frame AND a trailing post-prefix body frame together (both frameIndex-shifting effects at once)", async () => {
      // [expiry_verify, only_verify, pay, post_op]: the leading expiry_verify
      // frame shifts prefix.frames' role frameIndex values by 1 relative to
      // array position (sender at frameIndex 1, payer at frameIndex 2,
      // lastPrefixIndex = 2), while the trailing post_op frame (frameIndex 3,
      // DEFAULT-mode, from: ENTRY_POINT like every other frame here) must
      // still be excluded from the top-level-call count. Proves the fix
      // isn't only correct for the simple lastPrefixIndex-equals-array-
      // length-minus-2 case above.
      const root0 = ethrexFrame({ from: ENTRY_POINT, to: SENDER }); // expiry_verify's own level, frameIndex 0 - never consulted by role
      const root1 = ethrexFrame({ from: ENTRY_POINT, to: SENDER }); // only_verify (sender role, frameIndex 1)
      const root2 = ethrexFrame({ from: ENTRY_POINT, to: PAYER }); // pay (payer role, frameIndex 2)
      const root3 = ethrexFrame({ from: ENTRY_POINT, to: OTHER_CONTRACT }); // post_op body frame, frameIndex 3

      const simResult = fakeEthrexResult([root0, root1, root2, root3]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(PAYER),
        fakeReputationService(PAYER),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([
        expiryVerifyFrame(),
        onlyVerifyFrame(),
        payFrame(PAYER),
        postOpFrame(OTHER_CONTRACT),
      ]);

      await expect(service.validate(tx, simResult)).resolves.toMatchObject({
        mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
      });
    });

    it("rejects when the trace's top-level call count doesn't match the validation prefix's frame range", async () => {
      // [only_verify, pay]: lastPrefixIndex is 1, so the trace must contain
      // exactly 2 top-level calls (one per tx.frames[0..1]). Supplying only
      // one must be rejected outright, rather than silently misaligning
      // frameIndex 1 (payer) onto whatever the adapter produces for an
      // out-of-range index - this is the fail-closed invariant itself, not
      // a symptom it would otherwise degrade to.
      const root0 = ethrexFrame({ from: ENTRY_POINT, to: SENDER });

      const simResult = fakeEthrexResult([root0]);
      const service = new FrameTxValidationService(
        fakeStakingRegistry(PAYER),
        fakeReputationService(PAYER),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([onlyVerifyFrame(), payFrame(PAYER)]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.INTERNAL_ERROR,
      });
    });

    it("surfaces erc7562TraceError as the RpcError message when the trace pass itself failed", async () => {
      // ethrex sets erc7562Trace: null AND erc7562TraceError: "<reason>",
      // with violation/executionError both null, when the gas pass
      // succeeded but the trace pass specifically failed. validate()'s
      // `violation ?? executionError ?? "..."` fallback chain must surface
      // this real reason rather than skipping straight to the generic
      // message.
      const ethrexResult = {
        canonicalMempoolValid: true,
        prefixShape: "SelfVerify",
        payer: SENDER,
        maxCost: "0x0",
        canonicalMempoolViolation: null,
        gasUsed: "0x64",
        frames: [{ gasUsed: "0x1", succeeded: true }],
        executionStatus: "success",
        executionError: null,
        erc7562Trace: null,
        erc7562TraceError: "trace pass exceeded step limit",
      };

      const simResult = ethrexResult;
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.VALIDATION_FAILED,
        message: expect.stringContaining("trace pass exceeded step limit"),
      });
    });

    describe("DELEGATECALL storage attribution (fix round 2 - real ethrex `type` field)", () => {
      // Self Relay shape: [self_verify], role "payer", entityAddr resolves
      // to tx.sender (selfVerifyFrame's target is null, i.e. self-pay) - so
      // entityAddr === sender === SENDER throughout this scenario. The root
      // frame (VERIFY, from: ENTRY_POINT, to: SENDER) makes an inner call
      // from SENDER into a library contract (OTHER_CONTRACT) that reads
      // SOME_SLOT - modeling the dominant smart-account pattern: a proxy
      // (SENDER) DELEGATECALLing its own implementation (OTHER_CONTRACT),
      // which executes against the PROXY's storage (a DELEGATECALL runs in
      // the caller's storage context, not the callee's).
      //
      // getAccessInfo (utils.ts:334) decides which address a call's storage
      // access is attributed to: `call.from` for a real DELEGATECALL, else
      // `call.to`. Nobody is staked here, so if the access is (mis)attributed
      // to OTHER_CONTRACT, checkEntityCompliance's associated-storage
      // loop falls through to its `writes[slot] == null` branch (a read with
      // no corresponding write) and rejects with "unstaked payer accessed
      // <OTHER_CONTRACT> slot ...". If it's correctly attributed to SENDER,
      // the loop's very first check (`addr === sender`) short-circuits and
      // the tx validates regardless of stake.
      function delegateCallReadingOwnStorage(type: "CALL" | "DELEGATECALL") {
        const innerCall = ethrexFrame({
          from: SENDER,
          to: OTHER_CONTRACT,
          type,
          accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
        });
        return ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [innerCall] });
      }

      it("BEFORE (proof the old hardcoded-CALL behavior really did reject this): a library CALL reading the same slot is rejected as unstaked access to the library's address", async () => {
        // Same scenario, but `type: "CALL"` - exactly what every frame
        // synthesized by the pre-fix adapter (hardcoded `type: "CALL"`
        // regardless of the real EVM call opcode) would have produced for
        // this same real-world DELEGATECALL. This is not prose reasoning:
        // it's the actual old wire shape, replayed through the actual
        // unmodified validation logic, showing it really does reject.
        const root = delegateCallReadingOwnStorage("CALL");

        const simResult = fakeEthrexResult([root]);
        const service = new FrameTxValidationService(
          fakeStakingRegistry(), // nobody staked
          fakeReputationService(),
          fakeNetworkConfig(),
          fakeLogger()
        );

        const tx = baseTx([selfVerifyFrame()]);

        await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
        await expect(service.validate(tx, simResult)).rejects.toMatchObject({
          code: RpcErrorCodes.INVALID_OPCODE,
          message: expect.stringContaining("unstaked payer accessed"),
        });
      });

      it("AFTER (the actual fix): a real DELEGATECALL reading its own storage validates successfully, attributed to the sender (not the library)", async () => {
        const root = delegateCallReadingOwnStorage("DELEGATECALL");

        const simResult = fakeEthrexResult([root]);
        const service = new FrameTxValidationService(
          fakeStakingRegistry(), // still nobody staked - proves this isn't passing via a stake carve-out
          fakeReputationService(),
          fakeNetworkConfig(),
          fakeLogger()
        );

        const tx = baseTx([selfVerifyFrame()]);

        await expect(service.validate(tx, simResult)).resolves.toMatchObject({
          mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
        });
      });
    });

    it("surfaces ethrex's own violation reason as an RpcError when erc7562Trace is null", async () => {
      const ethrexResult = {
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

      const simResult = ethrexResult;
      const service = new FrameTxValidationService(
        fakeStakingRegistry(),
        fakeReputationService(),
        fakeNetworkConfig(),
        fakeLogger()
      );

      const tx = baseTx([selfVerifyFrame()]);

      await expect(service.validate(tx, simResult)).rejects.toThrow(RpcError);
      await expect(service.validate(tx, simResult)).rejects.toMatchObject({
        code: RpcErrorCodes.VALIDATION_FAILED,
        message: expect.stringContaining("total gas limit exceeds"),
      });
    });
  });
});

describe("FrameTxValidationService checks[] (transaction-level rules)", () => {
  const service = () =>
    new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger()
    );

  it("records a pass for every transaction-level rule on a clean tx", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
    await service().validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([root]),
      collector
    );
    const passed = collector
      .toChecks()
      .filter((c) => c.entity === undefined && c.verdict === "pass")
      .map((c) => c.rule);
    expect(passed).toEqual(
      expect.arrayContaining([
        "prefix",
        "structure",
        "signature",
        "simulation",
        "trace-alignment",
        "OP-061",
        "execution",
      ])
    );
    expect(collector.hasFailure()).toBe(false);
  });

  describe("EIP-8272 recent-root references", () => {
    const ref = { sourceId: `0x${"a".repeat(64)}` as const, slot: 100n, root: `0x${"b".repeat(64)}` as const };
    const withRef = () => ({ ...baseTx([selfVerifyFrame()]), nonceKeys: [7n], recentRootReferences: [ref] });

    it("records ethrex's reference rejection under 'recent-root', not 'simulation'", async () => {
      const collector = new CheckCollector();
      const rejected = {
        ...fakeEthrexResult([]),
        canonicalMempoolValid: false,
        canonicalMempoolViolation:
          "EIP-8272 recent-root reference is not committed in the RECENT_ROOT_ADDRESS predeploy at head state",
        frames: null,
        executionError: "Invalid Transaction: EIP-8272 recent-root reference is expired or not committed",
        erc7562Trace: null,
      };
      await expect(service().validate(withRef(), rejected, collector)).rejects.toThrow(/not committed/);
      const checks = collector.toChecks();
      expect(checks.find((c) => c.rule === "recent-root")?.verdict).toBe("fail");
      expect(checks.find((c) => c.rule === "simulation")?.verdict).toBe("skipped");
    });

    it("passes 'recent-root' once the simulation accepted the references", async () => {
      const collector = new CheckCollector();
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
      await service().validate(withRef(), fakeEthrexResult([root]), collector);
      expect(collector.toChecks().filter((c) => c.rule === "recent-root")).toEqual([
        expect.objectContaining({ verdict: "pass" }),
      ]);
    });

    it("leaves 'recent-root' to the admission pre-check for a tx without references", async () => {
      const collector = new CheckCollector();
      const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
      await service().validate(baseTx([selfVerifyFrame()]), fakeEthrexResult([root]), collector);
      expect(collector.toChecks().some((c) => c.rule === "recent-root")).toBe(false);
    });
  });

  it("fails 'prefix' and marks later rules skipped when the prefix is not recognized", async () => {
    const collector = new CheckCollector();
    await expect(
      service().validate(baseTx([]), fakeEthrexResult([]), collector)
    ).rejects.toThrow(RpcError);
    const checks = collector.toChecks();
    expect(checks.find((c) => c.rule === "prefix")?.verdict).toBe("fail");
    expect(checks.find((c) => c.rule === "signature")?.verdict).toBe("skipped");
    expect(checks.find((c) => c.rule === "OP-061")?.verdict).toBe("skipped");
  });

  it("passes 'simulation' even when canonicalMempoolValid is false, as long as a trace is present", async () => {
    // ethrex's canonicalMempoolValid/canonicalMempoolViolation report its own
    // canonical-mempool-policy opinion, decoupled from whether it reports
    // execution results - a `false` canonicalMempoolValid does not gate
    // the sidecar's own ERC-7562 admission checks, which run against the trace
    // regardless (and here find nothing to object to, so the tx validates).
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
    const sim = fakeEthrexResult([root]);
    sim.canonicalMempoolValid = false;
    sim.canonicalMempoolViolation = "gas cap exceeded";
    await service().validate(baseTx([selfVerifyFrame()]), sim, collector);
    expect(collector.toChecks().find((c) => c.rule === "simulation")).toMatchObject({
      verdict: "pass",
    });
  });

  it("fails 'simulation' with ethrex's violation text when no trace was produced", async () => {
    const collector = new CheckCollector();
    const sim = fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]);
    sim.canonicalMempoolValid = false;
    sim.canonicalMempoolViolation = "gas cap exceeded";
    sim.erc7562Trace = null;
    await expect(
      service().validate(baseTx([selfVerifyFrame()]), sim, collector)
    ).rejects.toThrow("gas cap exceeded");
    expect(collector.toChecks().find((c) => c.rule === "simulation")).toMatchObject({
      verdict: "fail",
      detail: "gas cap exceeded",
    });
  });

  it("fails 'OP-061' on a nested CALL with value, and passes the rules before it", async () => {
    const collector = new CheckCollector();
    const inner = ethrexFrame({ from: SENDER, to: OTHER_CONTRACT, value: "0x1" });
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, calls: [inner] });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("nested CALL with value during validation");
    const checks = collector.toChecks();
    expect(checks.find((c) => c.rule === "OP-061")?.verdict).toBe("fail");
    expect(checks.find((c) => c.rule === "trace-alignment")?.verdict).toBe("pass");
    expect(checks.find((c) => c.rule === "execution")?.verdict).toBe("skipped");
  });

  it("fails 'execution' with ethrex's executionError text", async () => {
    const collector = new CheckCollector();
    const sim = fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]);
    sim.executionError = "execution reverted: nope";
    await expect(
      service().validate(baseTx([selfVerifyFrame()]), sim, collector)
    ).rejects.toThrow("execution reverted: nope");
    expect(collector.toChecks().find((c) => c.rule === "execution")).toMatchObject({
      verdict: "fail",
      detail: "execution reverted: nope",
    });
  });

  it("still works when no collector is passed", async () => {
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })])
      )
    ).resolves.toBeDefined();
  });
});

describe("FrameTxValidationService checks[] (per-entity rules)", () => {
  const service = (netConfig = fakeNetworkConfig()) =>
    new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      netConfig,
      fakeLogger()
    );

  it("records every per-entity rule as a pass for a clean Self Relay tx", async () => {
    const collector = new CheckCollector();
    await service().validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]),
      collector
    );
    const entityChecks = collector.toChecks().filter((c) => c.entity === "payer");
    expect(entityChecks.map((c) => [c.rule, c.verdict, c.frameIndex])).toEqual([
      ["trace-alignment", "pass", 0],
      ["out-of-gas", "pass", 0],
      ["OP-011", "pass", 0],
      ["create", "pass", 0],
      ["storage", "pass", 0],
      ["COD-010", "pass", 0],
      ["entrypoint-access", "pass", 0],
    ]);
  });

  it("reports several violations at once but throws the first, unchanged", async () => {
    // "68" = DIFFICULTY (banned). The nested cross-contract read is an unstaked storage access.
    const innerRead = ethrexFrame({
      from: SENDER,
      to: OTHER_CONTRACT,
      accessedSlots: { ...emptyAccessedSlots(), reads: { [SOME_SLOT]: ["0x0"] } },
    });
    const root = ethrexFrame({
      from: ENTRY_POINT,
      to: SENDER,
      usedOpcodes: { "68": 1 },
      calls: [innerRead],
    });
    const collector = new CheckCollector();
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("payer uses banned opcode: DIFFICULTY");

    const failed = collector
      .toChecks()
      .filter((c) => c.verdict === "fail")
      .map((c) => [c.rule, c.entity, c.frameIndex]);
    expect(failed).toEqual(
      expect.arrayContaining([
        ["OP-011", "payer", 0],
        ["storage", "payer", 0],
      ])
    );
  });

  it("catches a banned opcode inside a pre_verify frame under the right role, with no code changes beyond recognition", async () => {
    // [pre_verify, only_verify, pay]: pre_verify precedes only_verify, so it
    // must target the same address only_verify resolves to — tx.sender
    // (SENDER), since only_verify's own target is null.
    const tx = baseTx([preVerifyFrame(SENDER), onlyVerifyFrame(), payFrame(PAYER)]);
    // "68" = DIFFICULTY (banned) — same fixture convention as the existing
    // "reports several violations at once" test above.
    const preVerifyRoot = ethrexFrame({ from: ENTRY_POINT, to: SENDER, usedOpcodes: { "68": 1 } });
    const onlyVerifyRoot = ethrexFrame({ from: ENTRY_POINT, to: SENDER });
    const payRoot = ethrexFrame({ from: ENTRY_POINT, to: PAYER });
    const collector = new CheckCollector();

    await expect(
      service().validate(tx, fakeEthrexResult([preVerifyRoot, onlyVerifyRoot, payRoot]), collector)
    ).rejects.toThrow("sender uses banned opcode: DIFFICULTY");

    // checkEntityCompliance's per-frame loop (frameTx.ts:570) throws as soon
    // as one frame's checks find a violation, so only_verify's own frameIndex
    // 1 is never reached in this run — this asserts what IS observable: the
    // violation is tagged with the pre_verify frame's own frameIndex (0), not
    // conflated with its approving frame's (1), proving prefix.frames treats
    // it as its own distinct entry.
    expect(collector.toChecks()).toContainEqual(
      expect.objectContaining({ rule: "OP-011", entity: "sender", frameIndex: 0, verdict: "fail" })
    );
  });

  it("passes a clean pre_verify frame's checks before reaching its approving frame", async () => {
    // Same shape, no violation this time — proves frameIndex 0 (pre_verify)
    // is checked and recorded independently of frameIndex 1 (only_verify),
    // both under role "sender", without the early-throw from the test above
    // masking it.
    const tx = baseTx([preVerifyFrame(SENDER), onlyVerifyFrame(), payFrame(PAYER)]);
    const collector = new CheckCollector();
    await service().validate(
      tx,
      fakeEthrexResult([
        ethrexFrame({ from: ENTRY_POINT, to: SENDER }),
        ethrexFrame({ from: ENTRY_POINT, to: SENDER }),
        ethrexFrame({ from: ENTRY_POINT, to: PAYER }),
      ]),
      collector
    );
    const senderChecks = collector.toChecks().filter((c) => c.entity === "sender");
    expect(senderChecks.map((c) => [c.rule, c.frameIndex, c.verdict])).toEqual(
      expect.arrayContaining([
        ["OP-011", 0, "pass"],
        ["OP-011", 1, "pass"],
      ])
    );
  });

  it("fails 'out-of-gas' immediately with entity context", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: SENDER, outOfGas: true });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("payer internally reverts on oog");
    expect(collector.toChecks().find((c) => c.rule === "out-of-gas")).toMatchObject({
      verdict: "fail",
      entity: "payer",
      frameIndex: 0,
    });
  });

  it("shows a whitelisted entity's waived violations as pass, with a note", async () => {
    // Self Relay: the payer role maps to the "paymaster" whitelist key.
    const netConfig = {
      ...fakeNetworkConfig(),
      whitelistedEntities: { paymaster: [SENDER] },
    } as unknown as NetworkConfig;
    const collector = new CheckCollector();
    const root = ethrexFrame({
      from: ENTRY_POINT,
      to: SENDER,
      usedOpcodes: { "68": 1 },
    });
    const result = await service(netConfig).validate(
      baseTx([selfVerifyFrame()]),
      fakeEthrexResult([root]),
      collector
    );
    expect(result.mempoolMembership[STANDARD_MEMPOOL_ID]).toBe(false);
    const opcodeCheck = collector.toChecks().find((c) => c.rule === "OP-011");
    expect(opcodeCheck?.verdict).toBe("pass");
    expect(opcodeCheck?.detail).toContain("waived (whitelisted entity)");
    expect(collector.hasFailure()).toBe(false);
  });

  it("fails 'trace-alignment' with entity context when the frame's trace targets the wrong address", async () => {
    const collector = new CheckCollector();
    const root = ethrexFrame({ from: ENTRY_POINT, to: OTHER_CONTRACT });
    await expect(
      service().validate(
        baseTx([selfVerifyFrame()]),
        fakeEthrexResult([root]),
        collector
      )
    ).rejects.toThrow("frame trace/frameIndex misalignment");
    expect(
      collector
        .toChecks()
        .find((c) => c.rule === "trace-alignment" && c.entity === "payer")
    ).toMatchObject({ verdict: "fail", frameIndex: 0 });
  });
});

describe("FrameTxValidationService: explaining a reverted validation prefix", () => {
  const revertedResult = (maxCost = "0x0"): any => ({
    canonicalMempoolValid: false,
    prefixShape: null,
    payer: null,
    maxCost,
    canonicalMempoolViolation: null,
    gasUsed: null,
    frames: null,
    executionStatus: null,
    executionError: "validation prefix frame reverted",
    erc7562Trace: null,
    erc7562TraceError: null,
  });
  const build = (getBalance?: (a: `0x${string}`) => Promise<bigint>) =>
    new FrameTxValidationService(
      fakeStakingRegistry(),
      fakeReputationService(),
      fakeNetworkConfig(),
      fakeLogger(),
      getBalance
    );
  const selfTx = () => baseTx([{ ...selfVerifyFrame(), limits: { execution: 30_000n, state: 0n } }]);

  it("names the balance and the cost when the payer cannot afford the transaction", async () => {
    const getBalance = vi.fn(async () => 12n);
    await expect(build(getBalance).validate(selfTx(), revertedResult("0x33e140"))).rejects.toMatchObject({
      code: RpcErrorCodes.VALIDATION_FAILED,
      message: expect.stringMatching(/validation prefix frame reverted.*payer 0x1111111111111111111111111111111111111111 has 12 wei.*maximum cost is 3400000 wei/),
    });
    expect(getBalance).toHaveBeenCalledWith("0x1111111111111111111111111111111111111111");
  });

  it("looks up the pay frame's target as the payer in the canonical paymaster shape", async () => {
    const getBalance = vi.fn(async () => 0n);
    const tx = baseTx([onlyVerifyFrame(), payFrame(PAYER)]);
    await expect(build(getBalance).validate(tx, revertedResult("0x64"))).rejects.toMatchObject({
      message: expect.stringContaining(`payer ${PAYER} has 0 wei`),
    });
    expect(getBalance).toHaveBeenCalledWith(PAYER);
  });

  it("lists the validation gas limits when the payer can afford it (a revert or out of gas)", async () => {
    const err = await build(async () => 10n ** 18n)
      .validate(selfTx(), revertedResult("0x64"))
      .catch((e) => e);
    expect(err.message).toMatch(/validation prefix frame reverted/);
    expect(err.message).toMatch(/frame 0: 30000 gas/);
    expect(err.message).toMatch(/run out of gas/);
  });

  it("falls back to the gas limits when the balance cannot be read, and never throws for it", async () => {
    const err = await build(async () => {
      throw new Error("rpc down");
    })
      .validate(selfTx(), revertedResult("0x64"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toMatch(/frame 0: 30000 gas/);
  });

  it("explains the generic text wherever ethrex puts it, including the violation field", async () => {
    const asViolation = { ...revertedResult("0x64"), canonicalMempoolViolation: "validation prefix frame reverted", executionError: null };
    await expect(build(async () => 0n).validate(selfTx(), asViolation)).rejects.toMatchObject({
      message: expect.stringMatching(/validation prefix frame reverted: payer 0x1111\S+ has 0 wei/),
    });
  });

  it("works without a balance reader, and leaves ethrex's own violations alone", async () => {
    await expect(build().validate(selfTx(), revertedResult())).rejects.toMatchObject({
      message: expect.stringMatching(/frame 0: 30000 gas/),
    });
    const violation = { ...revertedResult(), canonicalMempoolViolation: "BannedOpcode(66)", executionError: null };
    await expect(build(async () => 0n).validate(selfTx(), violation)).rejects.toMatchObject({ message: "banned opcode: TIMESTAMP (0x42)" });
  });
});

describe("FrameTxValidationService: naming a banned opcode ethrex itself caught", () => {
  const violationResult = (violation: string): any => ({
    canonicalMempoolValid: false,
    prefixShape: null,
    payer: null,
    maxCost: "0x0",
    canonicalMempoolViolation: violation,
    gasUsed: null,
    frames: null,
    executionStatus: null,
    executionError: null,
    erc7562Trace: null,
    erc7562TraceError: null,
  });
  const service = () =>
    new FrameTxValidationService(fakeStakingRegistry(), fakeReputationService(), fakeNetworkConfig(), fakeLogger());
  const tx = () => baseTx([selfVerifyFrame()]);

  it("replaces ethrex's raw opcode byte with its mnemonic and hex value", async () => {
    // 58 decimal = 0x3a = GASPRICE - the exact case a real GASPRICE call in a
    // validation frame produces (ethrex's own trace-rule violation fires
    // before the sidecar's own OP-011 check ever runs).
    const err = await service()
      .validate(tx(), violationResult("BannedOpcode(58)"))
      .catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.message).toBe("banned opcode: GASPRICE (0x3a)");
  });

  it("leaves an unknown opcode byte as the bare number, and other violations untouched", async () => {
    const unknown = await service()
      .validate(tx(), violationResult("BannedOpcode(12)"))
      .catch((e) => e);
    expect(unknown.message).toBe("BannedOpcode(12)");

    const other = await service()
      .validate(tx(), violationResult("StorageReadNonSender"))
      .catch((e) => e);
    expect(other.message).toBe("StorageReadNonSender");
  });
});

describe("FrameTxValidationService: ethrex's structured failure detail", () => {
  const failedResult = (detail: Record<string, unknown>): any => ({
    canonicalMempoolValid: false,
    prefixShape: null,
    payer: null,
    maxCost: "0x64",
    canonicalMempoolViolation: "validation prefix frame reverted",
    gasUsed: null,
    frames: null,
    executionStatus: null,
    executionError: null,
    erc7562Trace: null,
    erc7562TraceError: null,
    ...detail,
  });
  const service = (getBalance?: (a: `0x${string}`) => Promise<bigint>) =>
    new FrameTxValidationService(fakeStakingRegistry(), fakeReputationService(), fakeNetworkConfig(), fakeLogger(), getBalance);
  const tx = () => baseTx([{ ...selfVerifyFrame(), limits: { execution: 30_000n, state: 0n } }]);
  const message = async (detail: Record<string, unknown>, getBalance?: (a: `0x${string}`) => Promise<bigint>) =>
    (await service(getBalance).validate(tx(), failedResult(detail)).catch((e) => e)).message as string;

  it("uses ethrex's account, balance and cost for insufficient funds, without asking the chain", async () => {
    const getBalance = vi.fn(async () => 999n);
    const text = await message(
      { failedFrameIndex: 0, haltReason: "insufficient_funds", haltDetail: "x", account: SENDER, balance: "0x5", required: "0x33e140" },
      getBalance
    );
    expect(text).toBe(`validation frame 0: the payer ${SENDER} has 5 wei, the transaction's maximum cost is 3400000 wei`);
    expect(getBalance).not.toHaveBeenCalled();
  });

  it.each([
    [{ haltReason: "out_of_gas", haltDetail: "Out Of Gas" }, "validation frame 1: ran out of gas (Out Of Gas)"],
    [{ haltReason: "revert", haltDetail: "the frame reverted", revertData: "0x" }, "validation frame 1: reverted"],
    [{ haltReason: "revert", haltDetail: "the frame reverted", revertData: "0xab" }, "validation frame 1: reverted with data 0xab"],
    [{ haltReason: "static_violation", haltDetail: "Opcode Not Allowed In Static Context" }, "validation frame 1: wrote state or sent value in a read-only validation frame"],
    [{ haltReason: "invalid_opcode", haltDetail: "Invalid Opcode" }, "validation frame 1: hit an invalid opcode"],
    [{ haltReason: "payment_before_execution_approval", haltDetail: "APPROVE(payment) ran before the sender approved execution" }, "validation frame 1: APPROVE(payment) ran before the sender approved execution"],
    [{ haltReason: "something_new", haltDetail: "a cause this version does not know" }, "validation frame 1: a cause this version does not know"],
  ])("names the frame and the cause for %j", async (detail, expected) => {
    expect(await message({ failedFrameIndex: 1, ...detail })).toBe(expected);
  });

  it("falls back to the heuristic explanation when ethrex sends no detail (an older ethrex)", async () => {
    const text = await message({}, async () => 1n);
    expect(text).toMatch(/validation prefix frame reverted: payer .* has 1 wei/);
  });

  it("keeps ethrex's own violations that name no frame", async () => {
    expect(await message({ canonicalMempoolViolation: "BannedOpcode(66)" })).toBe("banned opcode: TIMESTAMP (0x42)");
  });
});

describe("FrameTxValidationService: ERC-8421 BUDGET-010 per-entity budgets", () => {
  const selfVerifyWith = (execution: bigint): Frame => ({ ...selfVerifyFrame(), limits: { execution, state: 0n } });
  const make = (opts: {
    staked?: `0x${string}`;
    config?: Record<string, unknown>;
    getCode?: (a: `0x${string}`) => Promise<`0x${string}` | undefined>;
  } = {}) =>
    new FrameTxValidationService(
      fakeStakingRegistry(opts.staked),
      fakeReputationService(opts.staked),
      { ...fakeNetworkConfig(), ...(opts.config ?? {}) } as NetworkConfig,
      fakeLogger(),
      undefined,
      opts.getCode
    );
  const run = (svc: FrameTxValidationService, execution: bigint, collector = new CheckCollector()) =>
    svc.validate(baseTx([selfVerifyWith(execution)]), fakeEthrexResult([ethrexFrame({ from: ENTRY_POINT, to: SENDER })]), collector);

  it("rejects an unstaked sender's 150k VERIFY under rule BUDGET-010, before simulation results are consulted", async () => {
    const collector = new CheckCollector();
    await expect(run(make(), 150_000n, collector)).rejects.toThrow(
      /BUDGET-010: sender\+payer 0x1111111111111111111111111111111111111111 verification gas 150000 .* exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity/
    );
    const checks = collector.toChecks();
    expect(checks.find((c) => c.rule === "BUDGET-010")).toMatchObject({ verdict: "fail" });
    expect(checks.find((c) => c.rule === "simulation")).toMatchObject({ verdict: "skipped" });
  });

  it("admits the same 150k VERIFY once the entity is staked, and records the budget used", async () => {
    const collector = new CheckCollector();
    await expect(run(make({ staked: SENDER }), 150_000n, collector)).resolves.toMatchObject({
      mempoolMembership: { [STANDARD_MEMPOOL_ID]: true },
    });
    expect(collector.toChecks().find((c) => c.rule === "BUDGET-010")).toMatchObject({
      verdict: "pass",
      detail: "sender+payer 150000/1000000 (staked)",
    });
  });

  it("rejects a 1.1M VERIFY even when staked", async () => {
    await expect(run(make({ staked: SENDER }), 1_100_000n)).rejects.toThrow(/exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000/);
  });

  it("adds no staking-registry lookup for a prefix within the unstaked budget (only the existing per-entity compliance lookup runs)", async () => {
    const within = fakeStakingRegistry();
    await run(new FrameTxValidationService(within, fakeReputationService(), fakeNetworkConfig(), fakeLogger()), 90_000n);
    expect(within.getDepositInfo).toHaveBeenCalledTimes(1);
    const over = fakeStakingRegistry(SENDER);
    await run(new FrameTxValidationService(over, fakeReputationService(SENDER), fakeNetworkConfig(), fakeLogger()), 150_000n);
    expect(over.getDepositInfo).toHaveBeenCalledTimes(2);
  });

  it("never treats a default-code entity (empty code) as staked, whatever the registry says", async () => {
    await expect(run(make({ staked: SENDER, getCode: async () => "0x" }), 150_000n)).rejects.toThrow(/unstaked entity/);
    await expect(run(make({ staked: SENDER, getCode: async () => "0x6000" }), 150_000n)).resolves.toBeDefined();
  });

  it("fails closed when the entity's code cannot be read: the error propagates, the larger budget is not granted", async () => {
    const svc = make({ staked: SENDER, getCode: async () => { throw new Error("rpc down"); } });
    await expect(run(svc, 150_000n)).rejects.toThrow(/rpc down/);
    // within the unstaked budget nothing is read, so the same node still admits a 90k VERIFY
    await expect(run(svc, 90_000n)).resolves.toBeDefined();
  });

  it("uses NetworkConfig.maxVerifyGasPerEntity / maxVerifyGasStakedEntity when set", async () => {
    const svc = make({ config: { maxVerifyGasPerEntity: 250_000, maxVerifyGasStakedEntity: 2_500_000 } });
    expect(svc.verifyGasBudgets).toEqual({ perEntity: 250_000n, stakedEntity: 2_500_000n });
    await expect(run(svc, 150_000n)).resolves.toBeDefined();
    await expect(run(svc, 300_000n)).rejects.toThrow(/MAX_VERIFY_GAS_PER_ENTITY 250000/);
  });

  it("defaults to the ERC-8421 constants when NetworkConfig has no budgets", () => {
    expect(make().verifyGasBudgets).toEqual({ perEntity: 100_000n, stakedEntity: 1_000_000n });
  });
});
