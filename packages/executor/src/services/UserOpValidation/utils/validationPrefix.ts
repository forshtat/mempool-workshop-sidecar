import { Frame, FRAME_MODE, APPROVE_SCOPE, ATOMIC_BATCH_FLAG, FrameTransaction, SIG_SCHEME, SigScheme } from "@skandha/types/lib/contracts/FrameTx.js";
import { classifyFrame, FRAME_SUBCLASS } from "@skandha/types/lib/contracts/frameModes.js";
import { getAddress } from "viem";

/**
 * EIP-8141 §Constants:
 * "Maximum amount of gas a node should expend validating signatures and
 * simulating the validation prefix."
 *
 * The public (canonical) mempool's single combined budget. This sidecar is an
 * ERC-8421 alternative mempool and enforces the per-entity [BUDGET-010]
 * budgets below instead; the constant stays exported for callers that need
 * the public-mempool figure (e.g. to tell a caller that a transaction will
 * not pass a node's `eth_sendRawTransaction`).
 */
export const MAX_VERIFY_GAS = BigInt(100_000);

/**
 * ERC-8421 §Constants: "Maximum execution gas budget for a single unstaked
 * or default-code entity's validation frames." Applied per entity by
 * [BUDGET-010] (see `computeEntityVerifyGas`), replacing EIP-8141's single
 * combined `MAX_VERIFY_GAS` for this alternative mempool. Default for
 * `NetworkConfig.maxVerifyGasPerEntity`.
 */
export const MAX_VERIFY_GAS_PER_ENTITY = BigInt(100_000);

/**
 * ERC-8421 §Constants: "Maximum execution gas budget for a single staked
 * entity's validation frames." A staked entity is one the Staking Registry
 * reports with stake >= `minStake`, unstake delay >= `minUnstakeDelay` and no
 * withdrawal in progress ([STAKING-010]). Default for
 * `NetworkConfig.maxVerifyGasStakedEntity`.
 */
export const MAX_VERIFY_GAS_STAKED_ENTITY = BigInt(1_000_000);

/** The two [BUDGET-010] limits a node enforces (operator-configurable). */
export interface VerifyGasBudgets {
  perEntity: bigint;
  stakedEntity: bigint;
}

export const DEFAULT_VERIFY_GAS_BUDGETS: VerifyGasBudgets = {
  perEntity: MAX_VERIFY_GAS_PER_ENTITY,
  stakedEntity: MAX_VERIFY_GAS_STAKED_ENTITY,
};

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
export function signatureVerificationCost(tx: FrameTransaction): bigint {
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

export type StructuralRulesResult = { valid: true } | { valid: false; reason: string };

/**
 * Implements the remaining EIP-8141 §Structural Rules items not already
 * enforced by `recognizeValidationPrefix`'s shape matching (items 1-4), plus
 * the "target tx.sender" half of item 3 (which needs `tx.sender`, not just
 * the candidate prefix slice):
 *
 *   3. (target half) self_verify/only_verify must target tx.sender, either
 *      explicitly or via a null target.
 *   5. No frame in the validation prefix may have ATOMIC_BATCH_FLAG set.
 *   6. sum(limits.state) over the prefix <= MAX_VERIFY_STATE_GAS. The
 *      execution half of item 6 (one combined MAX_VERIFY_GAS for the whole
 *      prefix) is replaced, for this alternative mempool, by ERC-8421's
 *      per-entity [BUDGET-010] - see `computeEntityVerifyGas` and
 *      `checkVerifyGasBudgets` below, which need each entity's stake and
 *      therefore run in `FrameTxValidationService.validate` after the
 *      Staking Registry lookup.
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
  let stateSum = BigInt(0);
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

    stateSum += frame.limits.state;
  }

  // Item 6, state half. The execution half is ERC-8421 [BUDGET-010]
  // (per entity, stake-dependent): `checkVerifyGasBudgets`.
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

  return { valid: true };
}


/** A validation-prefix entity's role, as `recognizeValidationPrefix` assigns it. */
export type PrefixEntityRole = ValidationPrefixMatch["frames"][number]["role"];

/**
 * One entity's [BUDGET-010] verification-gas usage: the sum of
 * `limits.execution` over the validation frames attributed to it, plus (for
 * `tx.sender` only) the intrinsic cost of validating `tx.signatures`.
 */
export interface EntityVerifyGas {
  /** Checksummed entity address. */
  address: `0x${string}`;
  /** Every prefix role this address plays (Self Relay: `tx.sender` is sender and payer). */
  roles: PrefixEntityRole[];
  /** Absolute `tx.frames` indices attributed to this entity. */
  frameIndices: number[];
  /** Sum of `limits.execution` over `frameIndices`. */
  execution: bigint;
  /** Intrinsic signature-verification cost; non-zero only for `tx.sender`. */
  signatureCost: bigint;
  /** `execution + signatureCost`: the figure compared against the budget. */
  total: bigint;
}

export interface VerifyGasUsage {
  /** One entry per distinct entity address, in first-frame order. */
  entities: EntityVerifyGas[];
  /**
   * A leading `expiry_verify` frame: ERC-8421 Definitions item 4 ("An
   * `expiry_verify` frame is attributed to no entity as its code is
   * protocol-defined"). Bounded separately (see `checkVerifyGasBudgets`).
   */
  unattributed: { frameIndex: number; execution: bigint }[];
}

/**
 * ERC-8421 [BUDGET-010] attribution: "A node MUST track the sum of
 * `limits.execution` separately per entity, over that entity's own
 * validation frames. The `pre_verify` frame counts toward the entity of the
 * approving frame it immediately precedes. The intrinsic cost of validating
 * `tx.signatures` counts toward the `tx.sender`."
 *
 *  - Entities are keyed by resolved address, not by role: the sender is
 *    `tx.sender`, the payer is the resolved target of its `pay` /
 *    `self_verify` frame, the factory the resolved target of `deploy`
 *    (Definitions item 4). A Self Relay `self_verify` frame (role "payer",
 *    target null) and the signature cost therefore land on the same entity,
 *    as does a `pay` frame that targets `tx.sender` itself.
 *  - `pre_verify` frames already carry the role of the approving frame they
 *    precede in `prefix.frames` (`matchPreVerify`) and resolve to the same
 *    target (PREFIX-110), so they need no special case here.
 *  - A leading `expiry_verify` frame is attributed to no entity.
 */
export function computeEntityVerifyGas(
  tx: FrameTransaction,
  prefix: ValidationPrefixMatch
): VerifyGasUsage {
  const byAddress = new Map<string, EntityVerifyGas>();
  const senderAddr = resolvedTarget(null, tx.sender);
  const entry = (address: `0x${string}`): EntityVerifyGas => {
    let e = byAddress.get(address);
    if (!e) {
      // tx.sender is always the sender entity, whichever role its frame has
      // (Self Relay: its self_verify frame is the payer's).
      const roles: PrefixEntityRole[] = address === senderAddr ? ["sender"] : [];
      e = { address, roles, frameIndices: [], execution: BigInt(0), signatureCost: BigInt(0), total: BigInt(0) };
      byAddress.set(address, e);
    }
    return e;
  };

  const attributed = new Set<number>();
  for (const { frame, frameIndex, role } of prefix.frames) {
    const address = role === "sender" ? senderAddr : resolvedTarget(frame.target, tx.sender);
    const e = entry(address);
    if (!e.roles.includes(role)) e.roles.push(role);
    e.frameIndices.push(frameIndex);
    e.execution += frame.limits.execution;
    attributed.add(frameIndex);
  }

  const sigCost = signatureVerificationCost(tx);
  if (sigCost > BigInt(0)) {
    entry(senderAddr).signatureCost += sigCost;
  }
  for (const e of byAddress.values()) e.total = e.execution + e.signatureCost;

  // Frames inside tx.frames[0..lastPrefixIndex] that recognizeValidationPrefix
  // left out of prefix.frames: only a leading expiry_verify frame.
  const unattributed: VerifyGasUsage["unattributed"] = [];
  const lastPrefixIndex = Math.max(...prefix.frames.map((f) => f.frameIndex));
  for (let i = 0; i <= lastPrefixIndex; i++) {
    if (!attributed.has(i)) unattributed.push({ frameIndex: i, execution: tx.frames[i].limits.execution });
  }

  return { entities: [...byAddress.values()], unattributed };
}

export type VerifyGasBudgetResult =
  | { valid: true; summary: string }
  | { valid: false; reason: string; entity?: EntityVerifyGas };

/**
 * ERC-8421 [BUDGET-010]: "For unstaked entities, that sum MUST NOT exceed
 * `MAX_VERIFY_GAS_PER_ENTITY`. For staked entities, that sum MUST NOT exceed
 * `MAX_VERIFY_GAS_STAKED_ENTITY`."
 *
 * `isStaked(address)` is consulted only for an entity whose usage exceeds
 * `budgets.perEntity` (no lookup is needed otherwise), and never for one
 * above `budgets.stakedEntity` (no stake can admit it).
 *
 * A leading `expiry_verify` frame belongs to no entity, so no stake can
 * raise its allowance: it is held to `budgets.perEntity` on its own.
 * [BUDGET-010] names no figure for it; [PREFIX-100] says a node "MUST still
 * apply the same limits it would apply normally" to an `EXPIRY_VERIFIER`
 * frame, and the unstaked budget is that limit. It keeps a huge declared
 * limit from being free.
 */
export async function checkVerifyGasBudgets(
  usage: VerifyGasUsage,
  isStaked: (address: `0x${string}`) => Promise<boolean>,
  budgets: VerifyGasBudgets = DEFAULT_VERIFY_GAS_BUDGETS
): Promise<VerifyGasBudgetResult> {
  for (const u of usage.unattributed) {
    if (u.execution > budgets.perEntity) {
      return {
        valid: false,
        reason: `BUDGET-010: expiry_verify frame ${u.frameIndex} limits.execution ${u.execution} exceeds MAX_VERIFY_GAS_PER_ENTITY ${budgets.perEntity} (attributed to no entity, so stake cannot raise it)`,
      };
    }
  }

  const parts: string[] = [];
  for (const e of usage.entities) {
    const what = `${e.roles.join("+")} ${e.address} verification gas ${e.total} (limits.execution ${e.execution} + signature-verification cost ${e.signatureCost})`;
    if (e.total <= budgets.perEntity) {
      parts.push(`${e.roles.join("+")} ${e.total}/${budgets.perEntity}`);
      continue;
    }
    if (e.total > budgets.stakedEntity) {
      return {
        valid: false,
        entity: e,
        reason: `BUDGET-010: ${what} exceeds MAX_VERIFY_GAS_STAKED_ENTITY ${budgets.stakedEntity}, the limit even for a staked entity`,
      };
    }
    if (!(await isStaked(e.address))) {
      return {
        valid: false,
        entity: e,
        reason: `BUDGET-010: ${what} exceeds MAX_VERIFY_GAS_PER_ENTITY ${budgets.perEntity} for an unstaked entity (a staked entity may use up to MAX_VERIFY_GAS_STAKED_ENTITY ${budgets.stakedEntity})`,
      };
    }
    parts.push(`${e.roles.join("+")} ${e.total}/${budgets.stakedEntity} (staked)`);
  }
  return { valid: true, summary: parts.join(", ") };
}
