import { Frame, FRAME_MODE, APPROVE_SCOPE, ATOMIC_BATCH_FLAG, FrameTransaction, SIG_SCHEME, SigScheme } from "@skandha/types/lib/contracts/FrameTx.js";
import { classifyFrame, FRAME_SUBCLASS } from "@skandha/types/lib/contracts/frameModes.js";
import { getAddress } from "viem";

/**
 * EIP-8141 §Constants:
 * "Maximum amount of gas a node should expend validating signatures and
 * simulating the validation prefix."
 */
export const MAX_VERIFY_GAS = BigInt(100_000);

/**
 * ERC-8421 BUDGET-010: validation gas is budgeted per entity (sender, payer,
 * factory) instead of one flat cap over the whole prefix. An unstaked entity
 * gets MAX_VERIFY_GAS_PER_ENTITY; a staked one gets
 * MAX_VERIFY_GAS_STAKED_ENTITY. This is what lets an expensive but legitimate
 * check, such as a post-quantum signature verified in a VERIFY frame, into
 * the alternative mempool while the canonical mempool keeps its 100k cap.
 * The staked ceiling is configurable through
 * SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY.
 */
export const MAX_VERIFY_GAS_PER_ENTITY = BigInt(100_000);
export const MAX_VERIFY_GAS_STAKED_ENTITY = BigInt(
  process.env.SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY ?? 1_000_000
);

/**
 * EIP-8141's intrinsic cost per signature, by scheme - not stated in
 * erc-7562.md (that spec states the rule, FRA-040, that this cost counts
 * against `MAX_VERIFY_GAS`, but not the constants themselves). Taken from
 * ethrex's real implementation (`FrameTransaction::
 * signature_verification_cost`, crates/common/types/transaction.rs), the
 * reference this bundler validates every transaction against - not a guess.
 * A scheme outside this table costs 0: unrecognized schemes are already
 * rejected before this runs (`SignatureEntryDto`'s own membership check at
 * the API boundary), so this is an unreachable-in-practice default, not a
 * silent undercount.
 */
const SIGNATURE_VERIFICATION_GAS_COST: Record<SigScheme, bigint> = {
  [SIG_SCHEME.ARBITRARY]: BigInt(100),
  [SIG_SCHEME.SECP256K1]: BigInt(2800),
  [SIG_SCHEME.P256]: BigInt(6700),
};

/** Sum of `signatureVerificationCost(sig)` over `tx.signatures` - see
 * `SIGNATURE_VERIFICATION_GAS_COST`. */
function signatureVerificationCost(tx: FrameTransaction): bigint {
  return tx.signatures.reduce(
    (sum, sig) => sum + (SIGNATURE_VERIFICATION_GAS_COST[sig.scheme] ?? BigInt(0)),
    BigInt(0)
  );
}

/**
 * EIP-8141 §Constants:
 * "Maximum amount of state gas that may be budgeted across the validation
 * prefix."
 */
export const MAX_VERIFY_STATE_GAS = BigInt(500_000);

export interface ValidationPrefixMatch {
  payerFrameIndex: number;
  frames: { frame: Frame; frameIndex: number; role: "sender" | "payer" | "factory" }[];
}

/**
 * Resolves a frame's target for comparison: an explicit target, or
 * `txSender` when the target is null (EIP-8141 §Structural Rules item 3 /
 * ERC-2028 PREFIX-030/PREFIX-110: "or null" always means "tx.sender", never
 * an untargeted call). Checksums both sides so a case-only difference can't
 * defeat the match.
 */
function resolvedTarget(target: `0x${string}` | null, txSender: `0x${string}`): `0x${string}` {
  return getAddress(target ?? txSender) as `0x${string}`;
}

/**
 * A `pre_verify` frame immediately before `approving` at `approvingIndex`
 * (ERC-2028 PREFIX-110): the frame at `approvingIndex - 1`, if it exists, is
 * `DEFAULT`-mode, and its resolved target equals `approving`'s. Returns null
 * when there's no such frame — `pre_verify` is always optional (PREFIX-010).
 */
function matchPreVerify(
  allFrames: Frame[],
  approvingIndex: number,
  approving: Frame,
  role: "sender" | "payer",
  txSender: `0x${string}`
): ValidationPrefixMatch["frames"][number] | null {
  const candidateIndex = approvingIndex - 1;
  if (candidateIndex < 0) return null;
  const candidate = allFrames[candidateIndex];
  if (classifyFrame(candidate) !== FRAME_SUBCLASS.DEPLOY_OR_POST_OP) return null;
  if (resolvedTarget(candidate.target, txSender) !== resolvedTarget(approving.target, txSender)) {
    return null;
  }
  return { frame: candidate, frameIndex: candidateIndex, role };
}

/**
 * Matches one of the two approving-frame skeletons — Self Relay
 * `[pre_verify?, self_verify]` or Canonical Paymaster `[pre_verify?,
 * only_verify, pre_verify?, pay]` — starting at `start` in `allFrames`. Each
 * `pre_verify?` is independently optional (ERC-2028 PREFIX-010/PREFIX-110).
 * `frameIndex` values in the result are absolute indices into `allFrames`.
 */
function matchApprovingSkeleton(
  allFrames: Frame[],
  start: number,
  txSender: `0x${string}`
): ValidationPrefixMatch | null {
  // Self Relay: [pre_verify?, self_verify]
  for (const selfVerifyIndex of [start, start + 1]) {
    if (selfVerifyIndex >= allFrames.length) continue;
    const candidate = allFrames[selfVerifyIndex];
    if (classifyFrame(candidate) !== FRAME_SUBCLASS.SELF_VERIFY) continue;
    const frames: ValidationPrefixMatch["frames"] = [];
    if (selfVerifyIndex === start + 1) {
      const pv = matchPreVerify(allFrames, selfVerifyIndex, candidate, "payer", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: candidate, frameIndex: selfVerifyIndex, role: "payer" });
    return { payerFrameIndex: selfVerifyIndex, frames };
  }

  // Canonical Paymaster: [pre_verify?, only_verify, pre_verify?, pay]
  for (const onlyVerifyIndex of [start, start + 1]) {
    if (onlyVerifyIndex >= allFrames.length) continue;
    const onlyVerify = allFrames[onlyVerifyIndex];
    if (classifyFrame(onlyVerify) !== FRAME_SUBCLASS.ONLY_VERIFY) continue;

    const frames: ValidationPrefixMatch["frames"] = [];
    if (onlyVerifyIndex === start + 1) {
      const pv = matchPreVerify(allFrames, onlyVerifyIndex, onlyVerify, "sender", txSender);
      if (!pv) continue;
      frames.push(pv);
    }
    frames.push({ frame: onlyVerify, frameIndex: onlyVerifyIndex, role: "sender" });

    for (const payIndex of [onlyVerifyIndex + 1, onlyVerifyIndex + 2]) {
      if (payIndex >= allFrames.length) continue;
      const pay = allFrames[payIndex];
      if (classifyFrame(pay) !== FRAME_SUBCLASS.PAY) continue;
      const withPay = [...frames];
      if (payIndex === onlyVerifyIndex + 2) {
        const pv = matchPreVerify(allFrames, payIndex, pay, "payer", txSender);
        if (!pv) continue;
        withPay.push(pv);
      }
      withPay.push({ frame: pay, frameIndex: payIndex, role: "payer" });
      return { payerFrameIndex: payIndex, frames: withPay };
    }
  }

  return null;
}

/**
 * Recognizes one of the EIP-8141 §Public Mempool-recognized Validation
 * Prefixes shapes, each optionally augmented with a `pre_verify` frame
 * (ERC-2028 PREFIX-010/PREFIX-110) immediately before any approving frame
 * (`self_verify`, `only_verify` or `pay`):
 *   - Self Relay, Basic Transaction:     [pre_verify?, self_verify]
 *   - Self Relay, Deploy New Account:    [deploy, pre_verify?, self_verify]
 *   - Canonical Paymaster, Basic Tx:     [pre_verify?, only_verify, pre_verify?, pay]
 *   - Canonical Paymaster, Deploy:       [deploy, pre_verify?, only_verify, pre_verify?, pay]
 *
 * Per §Expiry Verifier Frame, a leading `expiry_verify` frame is skipped for
 * the purposes of shape matching (e.g. `[expiry_verify, self_verify]` is
 * recognized as `[self_verify]`), but its index is preserved in the returned
 * frameIndex values.
 *
 * `self_verify`/`only_verify`/`pay` are classified unambiguously by
 * `classifyFrame()` alone (`VERIFY`-mode, disambiguated by `flags`). A
 * `DEFAULT`-mode frame is not: it's ambiguous between `deploy` and
 * `pre_verify` by mode/flags alone, so this function tries the
 * approving-frame skeleton (which resolves `pre_verify` via adjacency and
 * target-matching, PREFIX-110) starting at the prefix's first real frame
 * first; only if that fails does it retry one frame later, treating the
 * skipped leading frame as `deploy` (PREFIX-020: `deploy` must be the
 * prefix's first frame). This means a leading `DEFAULT`-mode frame whose
 * target doesn't match the following approving frame's target is `deploy`;
 * one whose target does match is `pre_verify` instead — `deploy` calls a
 * distinct factory contract that `CREATE2`s `tx.sender`'s code, so it cannot
 * sensibly target `tx.sender` (or a payer) itself.
 *
 * Returns null if `allFrames` does not match any of the resulting twelve
 * concrete shapes (§Structural Rules item 1). §Structural Rules items 5, 6
 * and 8 are NOT checked here — see `validateStructuralRules` below, which
 * needs the whole transaction rather than just the recognized prefix slice.
 */
export function recognizeValidationPrefix(
  allFrames: Frame[],
  txSender: `0x${string}`
): ValidationPrefixMatch | null {
  let offset = 0;
  if (allFrames.length > 0 && classifyFrame(allFrames[0]) === FRAME_SUBCLASS.EXPIRY_VERIFY) {
    offset = 1;
  }

  const withoutDeploy = matchApprovingSkeleton(allFrames, offset, txSender);
  if (withoutDeploy) return withoutDeploy;

  if (allFrames.length > offset && classifyFrame(allFrames[offset]) === FRAME_SUBCLASS.DEPLOY_OR_POST_OP) {
    const withDeploy = matchApprovingSkeleton(allFrames, offset + 1, txSender);
    if (withDeploy) {
      // A real deploy frame calls a distinct factory contract to CREATE2
      // tx.sender's code - it cannot sensibly target tx.sender itself (which
      // has no code yet) or the payer. Without this check, a leading
      // DEFAULT-mode frame that happens to target either would be admitted
      // as `deploy` (factory privileges: CREATE exemption, broader
      // associated-storage access) purely because an approving-frame
      // skeleton happens to match starting one frame later.
      const deployTarget = resolvedTarget(allFrames[offset].target, txSender);
      const senderAddr = resolvedTarget(null, txSender);
      const payerFrame = withDeploy.frames.find((f) => f.frameIndex === withDeploy.payerFrameIndex)!.frame;
      const payerAddr = resolvedTarget(payerFrame.target, txSender);
      if (deployTarget !== senderAddr && deployTarget !== payerAddr) {
        return {
          payerFrameIndex: withDeploy.payerFrameIndex,
          frames: [
            { frame: allFrames[offset], frameIndex: offset, role: "factory" },
            ...withDeploy.frames,
          ],
        };
      }
    }
  }

  return null;
}

export type StructuralRulesResult =
  | { valid: true; entityVerifyGas: Map<string, bigint> }
  | { valid: false; reason: string };

/**
 * Implements the remaining EIP-8141 §Structural Rules items not already
 * enforced by `recognizeValidationPrefix`'s shape matching (items 1-4), plus
 * the "target tx.sender" half of item 3 (which needs `tx.sender`, not just
 * the candidate prefix slice):
 *
 *   3. (target half) self_verify/only_verify must target tx.sender, either
 *      explicitly or via a null target.
 *   5. No frame in the validation prefix may have ATOMIC_BATCH_FLAG set.
 *   6. sum(limits.execution) over the prefix + intrinsic signature-validation
 *      cost <= MAX_VERIFY_GAS; sum(limits.state) over the prefix <=
 *      MAX_VERIFY_STATE_GAS.
 *   8. There must not be a VERIFY frame after the validation prefix.
 *
 * Items 3, 5 and 6 are checked over `tx.frames[0..lastPrefixIndex]` (the
 * full frame array up to and including the prefix's last recognized index),
 * NOT over `prefix.frames` — the validation prefix per EIP-8141 is "the
 * shortest prefix of frames whose successful execution sets `payer`", which
 * includes a leading `expiry_verify` frame that `recognizeValidationPrefix`
 * skips for shape-matching purposes and omits from `prefix.frames`. Relying
 * on `prefix.frames` here would let a leading `expiry_verify` frame smuggle
 * an ATOMIC_BATCH_FLAG or unbounded gas past these checks. Item 8 already
 * scanned `tx.frames` for this same reason.
 *
 * Item 7 ("nodes SHOULD stop simulation once payer is set and its VERIFY
 * frame completes") is a simulation-performance recommendation, not a
 * rejection condition on the transaction's validity — it doesn't reject
 * anything, so it is intentionally not implemented here.
 */
export function validateStructuralRules(tx: FrameTransaction, prefix: ValidationPrefixMatch): StructuralRulesResult {
  const prefixFrameIndices = prefix.frames.map((f) => f.frameIndex);
  const lastPrefixIndex = Math.max(...prefixFrameIndices);

  // Items 3 (target half), 5 and 6 all scan the same full-prefix range
  // tx.frames[0..lastPrefixIndex], including any leading expiry_verify
  // frame skipped by recognizeValidationPrefix (see rationale above).
  let executionSum = BigInt(0);
  let stateSum = BigInt(0);
  // BUDGET-010: execution gas of the prefix, grouped by the entity each frame
  // runs as. A null target is tx.sender.
  const entityVerifyGas = new Map<string, bigint>();
  for (let i = 0; i <= lastPrefixIndex; i++) {
    const frame = tx.frames[i];

    // Item 3 (target half): self_verify/only_verify must target tx.sender,
    // either explicitly or via a null target.
    const subclass = classifyFrame(frame);
    if (
      (subclass === FRAME_SUBCLASS.SELF_VERIFY || subclass === FRAME_SUBCLASS.ONLY_VERIFY) &&
      frame.target !== null &&
      frame.target !== tx.sender
    ) {
      return { valid: false, reason: `frame ${i} (${subclass}) targets ${frame.target}, expected tx.sender ${tx.sender} or null` };
    }

    // Item 5: no ATOMIC_BATCH_FLAG in the validation prefix.
    if ((frame.flags & ATOMIC_BATCH_FLAG) !== 0) {
      return { valid: false, reason: `frame ${i} in validation prefix has ATOMIC_BATCH_FLAG set` };
    }

    executionSum += frame.limits.execution;
    stateSum += frame.limits.state;
    const entity = (frame.target ?? tx.sender).toLowerCase();
    entityVerifyGas.set(entity, (entityVerifyGas.get(entity) ?? BigInt(0)) + frame.limits.execution);
  }

  // Item 6 (FRA-040): the sum of the validation prefix's `limits.execution`,
  // PLUS the intrinsic cost of validating tx.signatures, MUST NOT exceed
  // MAX_VERIFY_GAS - see SIGNATURE_VERIFICATION_GAS_COST for where that
  // per-scheme cost comes from.
  // Signature verification is attributed to the sender. Each entity is held
  // to the staked ceiling here; the unstaked budget needs stake info and is
  // enforced in FrameTxValidationService.validate.
  const sigCost = signatureVerificationCost(tx);
  const senderKey = tx.sender.toLowerCase();
  entityVerifyGas.set(senderKey, (entityVerifyGas.get(senderKey) ?? BigInt(0)) + sigCost);
  for (const [entity, gas] of entityVerifyGas) {
    if (gas > MAX_VERIFY_GAS_STAKED_ENTITY) {
      return {
        valid: false,
        reason: `BUDGET-010: entity ${entity} validation gas ${gas} exceeds MAX_VERIFY_GAS_STAKED_ENTITY ${MAX_VERIFY_GAS_STAKED_ENTITY}`,
      };
    }
  }
  if (stateSum > MAX_VERIFY_STATE_GAS) {
    return {
      valid: false,
      reason: `validation prefix state gas sum ${stateSum} exceeds MAX_VERIFY_STATE_GAS ${MAX_VERIFY_STATE_GAS}`,
    };
  }

  // Item 7 (nodes SHOULD stop simulation once `payer` is set and its VERIFY
  // frame completes) is a simulation-behavior recommendation, not a
  // rejection condition — intentionally not implemented as part of this
  // structural-validity check.

  // Item 8: there must not be a VERIFY frame after the validation prefix.
  for (let i = lastPrefixIndex + 1; i < tx.frames.length; i++) {
    if (tx.frames[i].mode === FRAME_MODE.VERIFY) {
      return { valid: false, reason: `frame ${i} is a VERIFY frame after the validation prefix (ends at index ${lastPrefixIndex})` };
    }
  }

  return { valid: true, entityVerifyGas };
}
