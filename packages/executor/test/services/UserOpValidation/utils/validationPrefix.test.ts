import { describe, it, expect } from "vitest";
import {
  recognizeValidationPrefix,
  validateStructuralRules,
  MAX_VERIFY_GAS_PER_ENTITY,
  MAX_VERIFY_GAS_STAKED_ENTITY,
  MAX_VERIFY_STATE_GAS,
} from "../../../../src/services/UserOpValidation/utils/validationPrefix.js";
import { FRAME_MODE, APPROVE_SCOPE, ATOMIC_BATCH_FLAG, Frame, FrameTransaction, SIG_SCHEME, SignatureEntry } from "@skandha/types/lib/contracts/FrameTx.js";

const verifyFrame = (flags: number): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags,
  target: null,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});
const deployFrame = (): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target: "0x3333333333333333333333333333333333333333" as const,
  limits: { execution: 1n, state: 1n },
  value: 0n,
  data: "0x" as const,
});
const userOpFrame = (): Frame => ({
  mode: FRAME_MODE.SENDER,
  flags: 0,
  target: "0x4444444444444444444444444444444444444444" as const,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x5555555555555555555555555555555555555555" as const;

const preVerifyFrame = (target: `0x${string}` | null): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target,
  limits: { execution: 1n, state: 0n },
  value: 0n,
  data: "0x" as const,
});

// The stake predicate validateStructuralRules takes for ERC-8421 BUDGET-010:
// no entity is staked.
const UNSTAKED = (_entity: `0x${string}`): boolean => false;

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

describe("recognizeValidationPrefix", () => {
  it("recognizes [self_verify] — Basic Transaction, Self Relay", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(0);
  });

  it("recognizes [deploy, self_verify] — Deploy New Account, Self Relay", () => {
    const match = recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.find((f) => f.role === "factory")).toBeDefined();
  });

  it("recognizes [only_verify, pay] — Basic Transaction, Canonical Paymaster", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)], SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.find((f) => f.role === "payer")!.frameIndex).toBe(1);
  });

  it("recognizes [deploy, only_verify, pay] — Deploy New Account, Canonical Paymaster", () => {
    const match = recognizeValidationPrefix([deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)], SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
  });

  it("rejects a frame list matching none of the four shapes", () => {
    const match = recognizeValidationPrefix([verifyFrame(APPROVE_SCOPE.PAYMENT), verifyFrame(APPROVE_SCOPE.EXECUTION)], SENDER); // pay before only_verify — wrong order
    expect(match).toBeNull();
  });

  it("skips a leading expiry_verify frame per EIP-8141 §Expiry Verifier Frame", () => {
    const expiryFrame = verifyFrame(APPROVE_SCOPE.NONE);
    const match = recognizeValidationPrefix([expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)], SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
  });
});

describe("recognizeValidationPrefix: pre_verify frames (ERC-2028 PREFIX-010/PREFIX-110)", () => {
  it("recognizes [pre_verify, self_verify], attributing both frames role 'payer'", () => {
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(1);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "payer"],
      [1, "payer"],
    ]);
  });

  it("recognizes [deploy, pre_verify, self_verify]", () => {
    const frames = [deployFrame(), preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "factory"],
      [1, "payer"],
      [2, "payer"],
    ]);
  });

  it("recognizes [pre_verify, only_verify, pay], attributing the pre_verify frame role 'sender'", () => {
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "sender"],
      [2, "payer"],
    ]);
  });

  it("recognizes [only_verify, pre_verify, pay], with the pre_verify frame targeting pay's target and role 'payer'", () => {
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(PAYER), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(2);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "payer"],
      [2, "payer"],
    ]);
  });

  it("recognizes [pre_verify, only_verify, pre_verify, pay] with both optional pre_verify frames present", () => {
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(PAYER), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    expect(match!.payerFrameIndex).toBe(3);
    expect(match!.frames.map((f) => [f.frameIndex, f.role])).toEqual([
      [0, "sender"],
      [1, "sender"],
      [2, "payer"],
      [3, "payer"],
    ]);
  });

  it("still falls back to deploy when the leading DEFAULT-mode frame's target matches neither sender nor payer", () => {
    // Regression guard for the new two-pass matcher: introducing pre_verify
    // must not turn this pre-existing [deploy, self_verify] shape into a
    // rejected pre_verify-target-mismatch case.
    const frames = [deployFrame(), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).not.toBeNull();
    const factory = match!.frames.find((f) => f.role === "factory");
    expect(factory).toBeDefined();
    expect(factory!.frameIndex).toBe(0);
  });

  it("rejects a DEFAULT-mode frame between only_verify and pay whose target matches neither", () => {
    const otherAddr = "0x6666666666666666666666666666666666666666" as const;
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION), preVerifyFrame(otherAddr), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).toBeNull();
  });

  it("rejects a leading DEFAULT-mode frame targeting tx.sender as deploy, even when a second DEFAULT-mode frame is a valid pre_verify", () => {
    // [D(sender), D(sender), self_verify]: the second DEFAULT frame is a
    // legitimate pre_verify (target matches self_verify's), but the first
    // one's target is tx.sender itself - never a valid deploy target, since
    // deploy calls a distinct factory contract to CREATE2 tx.sender's code.
    // It must not be admitted with factory privileges just because a real
    // approving-frame skeleton happens to match starting one frame later.
    const frames = [preVerifyFrame(SENDER), preVerifyFrame(SENDER), verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).toBeNull();
  });

  it("rejects a leading DEFAULT-mode frame targeting the payer as deploy", () => {
    // [D(payer), D(sender), only_verify, pay]: the first frame's target
    // equals the payer's resolved address (pay's target) - also never a
    // valid deploy target.
    const pay: Frame = { ...verifyFrame(APPROVE_SCOPE.PAYMENT), target: PAYER };
    const frames = [preVerifyFrame(PAYER), preVerifyFrame(null), verifyFrame(APPROVE_SCOPE.EXECUTION), pay];
    const match = recognizeValidationPrefix(frames, SENDER);
    expect(match).toBeNull();
  });
});

describe("validateStructuralRules", () => {
  it("accepts a valid [self_verify] prefix with no trailing VERIFY frames", () => {
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT), userOpFrame()];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(true);
  });

  it("rejects a prefix frame with ATOMIC_BATCH_FLAG set (item 5)", () => {
    const badFrame = verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT | ATOMIC_BATCH_FLAG);
    const frames = [badFrame];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/ATOMIC_BATCH_FLAG/);
    }
  });

  it("rejects when an unstaked entity's limits.execution sum exceeds MAX_VERIFY_GAS_PER_ENTITY (item 6, BUDGET-010)", () => {
    const bigFrame: Frame = {
      ...verifyFrame(APPROVE_SCOPE.EXECUTION),
      limits: { execution: MAX_VERIFY_GAS_PER_ENTITY + 1n, state: 0n },
    };
    const payFrame = verifyFrame(APPROVE_SCOPE.PAYMENT);
    const frames = [bigFrame, payFrame];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
    }
  });

  it("rejects when limits.execution is within budget alone but signature-verification cost pushes the sender over MAX_VERIFY_GAS_PER_ENTITY (item 6, BUDGET-010)", () => {
    // A P256 signature costs 6700 gas (see SIGNATURE_VERIFICATION_GAS_COST).
    // executionSum here is MAX_VERIFY_GAS_PER_ENTITY - 1, comfortably under
    // budget on its own - only adding the signature cost pushes it over.
    const almostMaxFrame: Frame = {
      ...verifyFrame(APPROVE_SCOPE.EXECUTION),
      limits: { execution: MAX_VERIFY_GAS_PER_ENTITY - 1n, state: 0n },
    };
    const payFrame = verifyFrame(APPROVE_SCOPE.PAYMENT);
    const frames = [almostMaxFrame, payFrame];
    const tx: FrameTransaction = {
      ...baseTx(frames),
      signatures: [
        {
          scheme: SIG_SCHEME.P256,
          signer: "0x2222222222222222222222222222222222222222",
          msg: "0x",
          signature: "0x",
        } as SignatureEntry,
      ],
    };
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
      expect(result.reason).toMatch(/signature-verification cost 6700/);
    }
  });

  it("accepts when limits.execution plus signature-verification cost together stay within MAX_VERIFY_GAS_PER_ENTITY", () => {
    const smallFrame: Frame = {
      ...verifyFrame(APPROVE_SCOPE.EXECUTION),
      limits: { execution: 1000n, state: 0n },
    };
    const payFrame = verifyFrame(APPROVE_SCOPE.PAYMENT);
    const frames = [smallFrame, payFrame];
    const tx: FrameTransaction = {
      ...baseTx(frames),
      signatures: [
        {
          scheme: SIG_SCHEME.SECP256K1,
          signer: "0x2222222222222222222222222222222222222222",
          msg: "0x",
          signature: "0x",
        } as SignatureEntry,
      ],
    };
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(true);
  });

  it("rejects when the sum of limits.state across the prefix exceeds MAX_VERIFY_STATE_GAS (item 6)", () => {
    const bigStateFrame: Frame = {
      ...deployFrame(),
      limits: { execution: 1n, state: MAX_VERIFY_STATE_GAS + 1n },
    };
    const frames = [bigStateFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/MAX_VERIFY_STATE_GAS/);
    }
  });

  it("rejects a VERIFY frame after the validation prefix (item 8)", () => {
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT), verifyFrame(APPROVE_SCOPE.NONE)];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/VERIFY frame after the validation prefix/);
    }
  });

  it("accepts a [only_verify, pay] prefix followed by user_op frames (no trailing VERIFY)", () => {
    const frames = [verifyFrame(APPROVE_SCOPE.EXECUTION), verifyFrame(APPROVE_SCOPE.PAYMENT), userOpFrame(), userOpFrame()];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(true);
  });

  it("rejects a leading expiry_verify frame with ATOMIC_BATCH_FLAG set, even though it is excluded from prefix.frames (item 5)", () => {
    const expiryFrame: Frame = { ...verifyFrame(APPROVE_SCOPE.NONE), flags: APPROVE_SCOPE.NONE | ATOMIC_BATCH_FLAG };
    const frames = [expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    // Sanity check: the expiry_verify frame is deliberately absent from
    // prefix.frames (recognizeValidationPrefix skips it for shape matching)
    // — this is what makes the bug possible if validateStructuralRules only
    // scanned prefix.frames instead of tx.frames[0..lastPrefixIndex].
    expect(prefix.frames.some((f) => f.frameIndex === 0)).toBe(false);
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/ATOMIC_BATCH_FLAG/);
      expect(result.reason).toMatch(/frame 0/);
    }
  });

  it("rejects a leading expiry_verify frame whose oversized limits.execution exceeds MAX_VERIFY_GAS_PER_ENTITY (item 6, BUDGET-010)", () => {
    const expiryFrame: Frame = {
      ...verifyFrame(APPROVE_SCOPE.NONE),
      limits: { execution: MAX_VERIFY_GAS_PER_ENTITY + 1n, state: 0n },
    };
    const frames = [expiryFrame, verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT)];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    expect(prefix.frames.some((f) => f.frameIndex === 0)).toBe(false);
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
    }
  });

  it("accepts a self_verify frame with an explicit target equal to tx.sender (item 3, target half)", () => {
    const sender = "0x1111111111111111111111111111111111111111" as const;
    const frame: Frame = { ...verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT), target: sender };
    const frames = [frame];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(true);
  });

  it("rejects a self_verify frame whose explicit target differs from tx.sender (item 3, target half)", () => {
    const otherAddr = "0x9999999999999999999999999999999999999999" as const;
    const frame: Frame = { ...verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT), target: otherAddr };
    const frames = [frame];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/tx\.sender/);
    }
  });

  it("rejects an only_verify frame whose explicit target differs from tx.sender (item 3, target half)", () => {
    const otherAddr = "0x9999999999999999999999999999999999999999" as const;
    const onlyVerifyFrame: Frame = { ...verifyFrame(APPROVE_SCOPE.EXECUTION), target: otherAddr };
    const frames = [onlyVerifyFrame, verifyFrame(APPROVE_SCOPE.PAYMENT)];
    const tx = baseTx(frames);
    const prefix = recognizeValidationPrefix(frames, SENDER)!;
    expect(prefix).not.toBeNull();
    const result = validateStructuralRules(tx, prefix, UNSTAKED);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/tx\.sender/);
    }
  });
});

describe("validateStructuralRules: per-entity verification gas budgets (ERC-8421 BUDGET-010)", () => {
  const FACTORY = "0x3333333333333333333333333333333333333333" as const; // deployFrame()'s target

  const withExecution = (frame: Frame, execution: bigint): Frame => ({
    ...frame,
    limits: { ...frame.limits, execution },
  });
  const selfVerify = (execution: bigint) => withExecution(verifyFrame(APPROVE_SCOPE.EXECUTION_AND_PAYMENT), execution);
  const onlyVerify = (execution: bigint) => withExecution(verifyFrame(APPROVE_SCOPE.EXECUTION), execution);
  const pay = (execution: bigint): Frame => ({ ...withExecution(verifyFrame(APPROVE_SCOPE.PAYMENT), execution), target: PAYER });
  const preVerify = (target: `0x${string}` | null, execution: bigint) => withExecution(preVerifyFrame(target), execution);
  const deploy = (execution: bigint) => withExecution(deployFrame(), execution);

  /** Only the given addresses are staked. */
  const stakedOnly =
    (...staked: `0x${string}`[]) =>
    (entity: `0x${string}`): boolean =>
      staked.some((s) => s.toLowerCase() === entity.toLowerCase());

  // 6700 gas, see SIGNATURE_VERIFICATION_GAS_COST.
  const P256_SIGNATURE = {
    scheme: SIG_SCHEME.P256,
    signer: "0x2222222222222222222222222222222222222222",
    msg: "0x",
    signature: "0x",
  } as SignatureEntry;

  const check = (
    frames: Frame[],
    isStakedEntity: (entity: `0x${string}`) => boolean = UNSTAKED,
    signatures: SignatureEntry[] = []
  ) => {
    const prefix = recognizeValidationPrefix(frames, SENDER);
    expect(prefix).not.toBeNull();
    return validateStructuralRules({ ...baseTx(frames), signatures }, prefix!, isStakedEntity);
  };

  it("accepts an unstaked entity at exactly MAX_VERIFY_GAS_PER_ENTITY and rejects it one gas above", () => {
    expect(check([selfVerify(MAX_VERIFY_GAS_PER_ENTITY), userOpFrame()]).valid).toBe(true);

    const result = check([selfVerify(MAX_VERIFY_GAS_PER_ENTITY + 1n), userOpFrame()]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unstaked sender/);
      expect(result.reason).toContain(SENDER);
      expect(result.reason).toMatch(/exceeds MAX_VERIFY_GAS_PER_ENTITY 100000/);
    }
  });

  it("accepts a staked sender up to MAX_VERIFY_GAS_STAKED_ENTITY and rejects it above", () => {
    const staked = stakedOnly(SENDER);
    expect(check([selfVerify(MAX_VERIFY_GAS_STAKED_ENTITY), userOpFrame()], staked).valid).toBe(true);

    const result = check([selfVerify(MAX_VERIFY_GAS_STAKED_ENTITY + 1n), userOpFrame()], staked);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/^staked sender/);
      expect(result.reason).toMatch(/exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000/);
    }
  });

  it("gives the sender and the payer a budget each, rather than one combined budget", () => {
    // 200_000 in total, over EIP-8141's single combined MAX_VERIFY_GAS, but
    // each entity stays within its own MAX_VERIFY_GAS_PER_ENTITY.
    expect(check([onlyVerify(MAX_VERIFY_GAS_PER_ENTITY), pay(MAX_VERIFY_GAS_PER_ENTITY)]).valid).toBe(true);
  });

  it("does not let a staked payer's budget raise an unstaked sender's", () => {
    const staked = stakedOnly(PAYER);
    expect(check([onlyVerify(MAX_VERIFY_GAS_PER_ENTITY), pay(MAX_VERIFY_GAS_STAKED_ENTITY)], staked).valid).toBe(true);

    const result = check([onlyVerify(MAX_VERIFY_GAS_PER_ENTITY + 1n), pay(1n)], staked);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unstaked sender/);
      expect(result.reason).toContain(SENDER);
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
    }
  });

  it("does not let a staked sender's budget raise an unstaked payer's", () => {
    const result = check([onlyVerify(1n), pay(MAX_VERIFY_GAS_PER_ENTITY + 1n)], stakedOnly(SENDER));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unstaked payer/);
      expect(result.reason).toContain(PAYER);
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
    }
  });

  it("counts the signature-verification cost toward tx.sender, not toward the payer", () => {
    const overBySignature = check(
      [onlyVerify(MAX_VERIFY_GAS_PER_ENTITY - 6700n + 1n), pay(1n)],
      UNSTAKED,
      [P256_SIGNATURE]
    );
    expect(overBySignature.valid).toBe(false);
    if (!overBySignature.valid) {
      expect(overBySignature.reason).toMatch(/unstaked sender/);
      expect(overBySignature.reason).toMatch(/signature-verification cost 6700/);
    }

    // The payer's own frames use its whole budget; the signature cost is not
    // charged to it.
    expect(check([onlyVerify(1n), pay(MAX_VERIFY_GAS_PER_ENTITY)], UNSTAKED, [P256_SIGNATURE]).valid).toBe(true);
  });

  it("counts a pre_verify frame toward the entity of the approving frame it precedes", () => {
    // [only_verify, pre_verify(payer), pay]: the pre_verify frame and the pay
    // frame share the payer's budget.
    const payerOver = check([onlyVerify(1n), preVerify(PAYER, 50_001n), pay(50_000n)]);
    expect(payerOver.valid).toBe(false);
    if (!payerOver.valid) {
      expect(payerOver.reason).toMatch(/unstaked payer/);
      expect(payerOver.reason).toContain(PAYER);
    }

    // [pre_verify(sender), only_verify, pay]: the pre_verify frame counts
    // toward the sender, leaving the payer's budget untouched.
    expect(check([preVerify(null, 50_000n), onlyVerify(50_000n), pay(MAX_VERIFY_GAS_PER_ENTITY)]).valid).toBe(true);
    const senderOver = check([preVerify(null, 50_000n), onlyVerify(50_001n), pay(1n)]);
    expect(senderOver.valid).toBe(false);
    if (!senderOver.valid) {
      expect(senderOver.reason).toMatch(/unstaked sender/);
    }

    // A staked payer's pre_verify and pay frames share its larger budget.
    const staked = stakedOnly(PAYER);
    expect(check([onlyVerify(1n), preVerify(PAYER, 500_000n), pay(500_000n)], staked).valid).toBe(true);
    expect(check([onlyVerify(1n), preVerify(PAYER, 500_000n), pay(500_001n)], staked).valid).toBe(false);
  });

  it("gives frames that resolve to the same address one budget between them", () => {
    // A pay frame with a null target resolves to tx.sender: one entity, so
    // 60_000 + 60_000 is summed against the sender's single budget.
    const selfPay = withExecution(verifyFrame(APPROVE_SCOPE.PAYMENT), 60_000n);
    const result = check([onlyVerify(60_000n), selfPay]);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unstaked sender/);
      expect(result.reason).toMatch(/120000/);
    }
  });

  it("bounds the factory's deploy frame by the factory's own budget", () => {
    const result = check([deploy(MAX_VERIFY_GAS_PER_ENTITY + 1n), selfVerify(1n)], stakedOnly(SENDER));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/unstaked factory/);
      expect(result.reason).toContain(FACTORY);
    }

    expect(check([deploy(MAX_VERIFY_GAS_STAKED_ENTITY), selfVerify(1n)], stakedOnly(FACTORY)).valid).toBe(true);
  });

  it("bounds a leading expiry_verify frame by MAX_VERIFY_GAS_PER_ENTITY even when every entity is staked, as it belongs to no entity", () => {
    const expiry = withExecution(verifyFrame(APPROVE_SCOPE.NONE), MAX_VERIFY_GAS_PER_ENTITY + 1n);
    const result = check([expiry, selfVerify(1n)], stakedOnly(SENDER));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/frame 0 \(expiry_verify\) belongs to no entity/);
      expect(result.reason).toMatch(/MAX_VERIFY_GAS_PER_ENTITY/);
    }

    // Its gas is not charged to the sender either.
    const expiryAtCap = withExecution(verifyFrame(APPROVE_SCOPE.NONE), MAX_VERIFY_GAS_PER_ENTITY);
    expect(check([expiryAtCap, selfVerify(MAX_VERIFY_GAS_PER_ENTITY)]).valid).toBe(true);
  });
});
