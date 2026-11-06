/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Validation-prefix opcode/storage interpreter for EIP-8141 frame
 * transactions.
 *
 * Applies ERC-7562's OP-, STO- and COD-010 judgment calls (banned-opcode
 * set, CREATE/CREATE2 special-casing, associated-storage access loop,
 * contract-size/un-deployed-address checks, extCodeAccessInfo
 * EntryPoint-address check, whitelisted-entities carve-out) to a frame
 * transaction's trace. Entities (`{sender, payer, factory}`) are indexed by
 * validation-prefix frame index (`recognizeValidationPrefix`), since there
 * is no EntryPoint contract call whose method signature to match against -
 * ERC-4337's EntryPoint-call-depth-based indexing has no equivalent here.
 */
import { IWhitelistedEntities } from "@skandha/types/lib/executor/index.js";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { Logger } from "@skandha/types/lib/index.js";
import { EVM_OPCODES } from "@skandha/params/lib/index.js";
import { Hex, getAddress } from "viem";
import {
  EthrexAccessedSlots,
  EthrexSimulateFrameTransactionResult,
  FrameCallTraceFrame,
} from "@skandha/types/lib/executor/validation/ethrexFrameTx.js";
import {
  Frame,
  FrameTransaction,
  ENTRY_POINT,
} from "@skandha/types/lib/contracts/FrameTx.js";
import {
  EXPLORER_RULES,
  ExplorerRuleId,
} from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../../ExplorerService/checkCollector.js";
import { computeSigHash } from "../../FrameTxService/codec.js";
import { validateSignature } from "../../FrameTxService/signature.js";
import { selectPrefixTrace } from "../erc7562TraceAdapter.js";
import {
  checkVerifyGasBudgets,
  computeEntityVerifyGas,
  DEFAULT_VERIFY_GAS_BUDGETS,
  recognizeValidationPrefix,
  validateStructuralRules,
  ValidationPrefixMatch,
  VerifyGasBudgets,
} from "../utils/validationPrefix.js";
import { NetworkConfig, StakeInfo } from "../../../interfaces.js";
import {
  getAccessInfo,
  getContractSizes,
  getExtCodeAccessInfos,
  getOpcodesInfo,
  hasNestedCallWithValue,
  isSlotAssociatedWith,
  outOfGasExists,
  parseEntitySlots,
} from "../utils.js";
import { StakingRegistryService } from "../../StakingRegistryService/index.js";
import { ReputationService } from "../../ReputationService.js";

/**
 * Some opcodes like:
 * - CREATE2
 * are not included here because they are handled elsewhere.
 * Do not include them in this list!!!
 *
 * Ported verbatim from safe.ts - this list is a generic ERC-7562 OP-011
 * banned-opcode set, not specific to the EntryPoint/UserOperation model, so
 * it needs no change for frame transactions.
 */
const bannedOpCodes = new Set([
  "GASPRICE",
  "GASLIMIT",
  "DIFFICULTY",
  "TIMESTAMP",
  "BASEFEE",
  "BLOCKHASH",
  "NUMBER",
  "SELFBALANCE",
  "BALANCE",
  "ORIGIN",
  "GAS",
  "COINBASE",
  "SELFDESTRUCT",
  "RANDOM",
  "PREVRANDAO",
  "INVALID",
  "BLOBHASH",
  "BLOBBASEFEE",
]);

export type EntityRole = "sender" | "payer" | "factory";

/**
 * Maps a validation-prefix role to the `IWhitelistedEntities` key for the
 * analogous ERC-4337 concept:
 *  - "sender" (validates tx.sender's own authorization - either via a
 *    dedicated `only_verify` frame in the Canonical Paymaster shape, or
 *    folded into the `payer` frame itself in the Self Relay shape)
 *    corresponds to ERC-4337's "account".
 *  - "payer" (whoever's approval frame ends up paying gas - the sender
 *    itself when self-relaying) corresponds to ERC-4337's "paymaster".
 *  - "factory" is unchanged.
 */
const roleToWhitelistKey: Record<EntityRole, keyof IWhitelistedEntities> = {
  sender: "account",
  payer: "paymaster",
  factory: "factory",
};

/**
 * Per-mempool admission result, keyed by `mempoolId` (the same IPFS-hash-style
 * string `NetworkConfig.standardMempoolId`/`supportedMempools[].mempoolId`
 * and the P2P gossip topic layer already use - see erc-7562.md's ALT-010).
 * A transaction can belong to several mempools at once (each with its own
 * rule set); today `checkEntityCompliance` only implements one rule set
 * (`standardMempoolId`'s), so this map has at most one entry, but the shape
 * doesn't privilege that one mempool as "canonical" - it's simply the only
 * one currently implemented.
 */
export interface FrameTxValidationResult {
  mempoolMembership: { [mempoolId: string]: boolean };
  /**
   * ethrex's maximum cost for the transaction (`maxCost`, TXPARAM 0x06), in
   * wei: what its payer must be able to escrow. Feeds the mempool's
   * per-account balance accounting.
   */
  maxCost: bigint;
  /**
   * Every storage slot (reads, writes, and transient reads/writes, merged -
   * direction doesn't matter for this) touched by any validation-prefix
   * frame, aggregated across the whole transaction and keyed by address.
   * Not consulted by any admission decision here - it exists so a future
   * per-block mempool-revalidation pass can intersect this against a newly
   * mined block's `eth_getBlockAccessList` diff to narrow which `New`
   * entries actually need re-validation, instead of re-validating all of
   * them. Computed once, cheaply, from data `checkEntityCompliance` already
   * has in hand - not itself a new RPC call.
   */
  accessedSlots: { [address: string]: Set<string> };
  /**
   * Per-role stake info, already resolved against `StakingRegistryService`
   * during this same validation pass (`resolveRoleStakes`) - not a second
   * lookup. Keyed by validation-prefix role, so a role absent from the
   * prefix (e.g. "sender" in the Self Relay shape, where the sender's own
   * authorization folds into the "payer" frame instead of a dedicated
   * frame - see `FrameTxMempoolEntry`'s class doc comment) is simply
   * missing here, not present with zeroed-out stake. Feeds
   * `MempoolService.addFrameTx`'s `senderInfo`/`factoryInfo`/`payerInfo`
   * reputation-gate parameters, which were previously always omitted on
   * the real send path - this is what makes that gate live.
   */
  roleStakes: Partial<Record<EntityRole, StakeInfo & { addr: Hex }>>;
}

/**
 * Resolves a validation-prefix role's entity address, mirroring
 * `FrameTxMempoolEntry.resolveRoles`:
 *  - "sender" is always `tx.sender`.
 *  - "payer"/"factory" are the role's frame's `target`, defaulting to
 *    `tx.sender` when `target` is null (self-pay, only possible for
 *    "payer" in the Self Relay shape).
 */
function resolveRoleAddr(role: EntityRole, frame: Frame, txSender: Hex): Hex {
  if (role === "sender") {
    return getAddress(txSender) as Hex;
  }
  return getAddress(frame.target ?? txSender) as Hex;
}

/** The most the transaction can cost its payer: every frame's gas limits at `maxFeePerGas`. */
export function estimateMaxCost(tx: FrameTransaction): bigint {
  const gas = tx.frames.reduce(
    (sum, f) => sum + f.limits.execution + f.limits.state,
    BigInt(0)
  );
  return gas * tx.fees.maxFeePerGas;
}

/**
 * ethrex's `violation` field is the Rust Debug format of its own trace-rule
 * violation enum: mostly self-explanatory PascalCase text (`StorageReadNonSender`,
 * `CallToNonexistentOrDelegated(0x...)`), except `BannedOpcode(N)`, whose payload
 * is the opcode's raw decimal byte - meaningless on its own. Substitutes the real
 * mnemonic and its hex value, so this reads the same as the sidecar's own banned-opcode
 * rejection ("uses banned opcode: GASPRICE") - ethrex's own dispatch-loop check
 * catches a banned opcode before the sidecar's downstream OP-011 check ever runs, so
 * without this the caller only ever saw the bare number. An opcode byte this
 * table does not know (unassigned) is left as the bare number.
 */
function describeEthrexViolation(violation: string): string {
  return violation.replace(/^BannedOpcode\((\d+)\)$/, (match, byte: string) => {
    const hex = `0x${Number(byte).toString(16).padStart(2, "0")}`;
    const name = EVM_OPCODES[hex];
    return name ? `banned opcode: ${name} (${hex})` : match;
  });
}

export class FrameTxValidationService {
  constructor(
    private stakingRegistryService: StakingRegistryService,
    private reputationService: ReputationService,
    private networkConfig: NetworkConfig,
    private logger: Logger,
    /** Reads an account's balance, to say when a payer cannot afford a transaction. Optional. */
    private getBalance?: (address: Hex) => Promise<bigint>,
    /**
     * Reads an account's code, so a default-code entity (empty code) is never
     * treated as staked for [BUDGET-010] (ERC-8421 Definitions item 5).
     * Optional: without it, stake alone decides.
     */
    private getCode?: (address: Hex) => Promise<Hex | undefined>
  ) {}

  /**
   * The [BUDGET-010] limits this node enforces: `NetworkConfig`'s
   * `maxVerifyGasPerEntity`/`maxVerifyGasStakedEntity` when set, else the
   * ERC-8421 constants (100,000 / 1,000,000).
   */
  get verifyGasBudgets(): VerifyGasBudgets {
    const cfg = this.networkConfig as Partial<NetworkConfig> | undefined;
    return {
      perEntity:
        cfg?.maxVerifyGasPerEntity != null
          ? BigInt(cfg.maxVerifyGasPerEntity)
          : DEFAULT_VERIFY_GAS_BUDGETS.perEntity,
      stakedEntity:
        cfg?.maxVerifyGasStakedEntity != null
          ? BigInt(cfg.maxVerifyGasStakedEntity)
          : DEFAULT_VERIFY_GAS_BUDGETS.stakedEntity,
    };
  }

  /**
   * [STAKING-010] for one [BUDGET-010] entity: the Staking Registry's deposit
   * passes `ReputationService.checkStake` (stake >= `minStake`, delay >=
   * `minUnstakeDelay`, no withdrawal initiated, not banned; a whitelisted
   * entity also passes, as it does for every other stake-gated rule here),
   * and the entity is not a default-code account.
   *
   * A failed code or registry read propagates (the transaction is rejected
   * with that error, as it is when `resolveRoleStakes` cannot read the
   * registry): a larger budget is never granted on a guess.
   */
  private async isStakedEntity(address: Hex): Promise<boolean> {
    if (this.getCode) {
      const code = await this.getCode(address);
      if (code == null || code === "0x") return false;
    }
    const deposit = await this.stakingRegistryService.getDepositInfo(address);
    const { code } = await this.reputationService.checkStake({
      addr: address,
      stake: deposit.stake,
      unstakeDelaySec: deposit.unstakeDelaySec,
      withdrawTime: deposit.withdrawTime,
    });
    return code === 0;
  }

  /**
   * The message for a failure ethrex described in detail (`failedFrameIndex`
   * and `haltReason`), or `null` when this ethrex sent none (an older one), so
   * the caller falls back to `explainFailure`. An unknown `haltReason` (a
   * newer ethrex) is described by its own `haltDetail`.
   */
  private describeStructuredFailure(
    simResult: EthrexSimulateFrameTransactionResult
  ): string | null {
    const { failedFrameIndex: frame, haltReason: reason, haltDetail } = simResult;
    if (frame === undefined || reason === undefined) return null;
    const at = `validation frame ${frame}`;
    switch (reason) {
      case "insufficient_funds":
        if (simResult.account && simResult.balance && simResult.required) {
          return `${at}: the payer ${simResult.account} has ${BigInt(simResult.balance)} wei, the transaction's maximum cost is ${BigInt(simResult.required)} wei`;
        }
        break;
      case "out_of_gas":
        return `${at}: ran out of gas${haltDetail ? ` (${haltDetail})` : ""}`;
      case "revert":
        return simResult.revertData && simResult.revertData !== "0x"
          ? `${at}: reverted with data ${simResult.revertData}`
          : `${at}: reverted`;
      case "static_violation":
        return `${at}: wrote state or sent value in a read-only validation frame`;
      case "invalid_opcode":
        return `${at}: hit an invalid opcode`;
      default:
        break;
    }
    return haltDetail ? `${at}: ${haltDetail}` : `${at}: failed (${reason})`;
  }

  /**
   * ethrex reports every failure of the validation prefix as "validation
   * prefix frame reverted": no funds, running out of gas, a revert and a
   * loop all look alike, and it names neither the frame nor the cause. Say
   * what the sidecar can tell for itself: whether the payer's balance is below
   * the transaction's maximum cost, and otherwise the gas limits the prefix
   * frames were given. Any other `reason` is returned unchanged. Never
   * throws: a failed balance read only means less detail.
   *
   * ethrex reports this either inside a simulation result or as a JSON-RPC
   * error, so both paths call this; `maxCost` is ethrex's own figure when it
   * gave one, else `estimateMaxCost(tx)`.
   */
  async explainFailure(
    tx: FrameTransaction,
    reason: string,
    maxCost: bigint = estimateMaxCost(tx)
  ): Promise<string> {
    if (!/validation prefix frame reverted/.test(reason)) return reason;
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    if (prefix == null) return reason;
    try {
      const payerFrame = prefix.frames.find(
        (f) => f.frameIndex === prefix.payerFrameIndex
      );
      if (this.getBalance && payerFrame) {
        const payer = resolveRoleAddr("payer", payerFrame.frame, tx.sender);
        const balance = await this.getBalance(payer);
        if (maxCost > BigInt(0) && balance < maxCost) {
          return `${reason}: payer ${payer} has ${balance} wei, the transaction's maximum cost is ${maxCost} wei`;
        }
      }
    } catch (err) {
      this.logger.debug(err, "could not read the payer's balance");
    }
    const limits = prefix.frames
      .map((f) => `frame ${f.frameIndex}: ${f.frame.limits.execution} gas`)
      .join(", ");
    return `${reason} (validation gas limits: ${limits}; a frame may have reverted or run out of gas)`;
  }

  /**
   * Takes an already-fetched, traced `simResult` rather than fetching its
   * own - this service has no `GethTracer` of its own to call. Its only
   * caller, `FrameTxSimulationService.simulate`, fetches exactly one traced
   * `ethrex_simulateFrameTransaction` result per admission attempt and
   * reuses it both here and for its own gas/receipt mapping (both are
   * present on any traced response - `{trace: true}` only adds
   * `erc7562Trace` on top of the same `gasUsed`/`frames`/`payer` fields a
   * `{trace: false}` call would have had) - see that class's header
   * comment for why a second, untraced call used to exist and no longer
   * does.
   */
  async validate(
    tx: FrameTransaction,
    simResult: EthrexSimulateFrameTransactionResult,
    collector: CheckCollector = new CheckCollector()
  ): Promise<FrameTxValidationResult> {
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    if (prefix == null) {
      throw collector.failed(
        EXPLORER_RULES.PREFIX,
        new RpcError(
          "frame transaction validation prefix not recognized",
          RpcErrorCodes.INVALID_OPCODE
        )
      );
    }
    collector.pass(EXPLORER_RULES.PREFIX);

    const structural = validateStructuralRules(tx, prefix);
    if (!structural.valid) {
      throw collector.failed(
        EXPLORER_RULES.STRUCTURE,
        new RpcError(structural.reason, RpcErrorCodes.INVALID_USEROP)
      );
    }
    collector.pass(EXPLORER_RULES.STRUCTURE);

    // ERC-8421 [BUDGET-010]: per-entity verification gas, staked entities
    // get the larger budget. Acceptance Algorithm step 3 (resolve each
    // entity's stake) - the Staking Registry is read only for an entity
    // above the unstaked budget.
    const budget = await checkVerifyGasBudgets(
      computeEntityVerifyGas(tx, prefix),
      (address) => this.isStakedEntity(address as Hex),
      this.verifyGasBudgets
    );
    if (!budget.valid) {
      throw collector.failed(
        EXPLORER_RULES.BUDGET,
        new RpcError(budget.reason, RpcErrorCodes.INVALID_USEROP)
      );
    }
    collector.pass(EXPLORER_RULES.BUDGET, {}, budget.summary);

    // The validation prefix's last real frame index (recognizeValidationPrefix
    // already computes each role's real frameIndex, including the shift a
    // leading expiry_verify frame introduces - see ValidationPrefixMatch).
    // Computed once here so both `selectPrefixTrace` (below) and
    // `checkEntityCompliance`'s own identical fail-closed invariant
    // check work off the same value rather than each re-deriving it
    // independently.
    const lastPrefixIndex = Math.max(...prefix.frames.map((f) => f.frameIndex));

    // Per EIP-8141 §Behavior: "For each sig in tx.signatures, ensure
    // validate_signature(...) == true". This replaces safe.ts's
    // `returnInfo.sigFailed` check, which read an aggregate bit out of the
    // EntryPoint's ABI-decoded validateUserOp/validatePaymasterUserOp
    // return data - there is no such contract call for a frame transaction,
    // so signature validity is checked directly off-chain instead.
    const sigHash = computeSigHash(tx);
    for (const sig of tx.signatures) {
      const ok = await validateSignature(sig, tx.sender, sigHash);
      if (!ok) {
        throw collector.failed(
          EXPLORER_RULES.SIGNATURE,
          new RpcError(
            "Invalid frame transaction signature",
            RpcErrorCodes.INVALID_SIGNATURE
          )
        );
      }
    }
    collector.pass(EXPLORER_RULES.SIGNATURE);

    // `simResult` (the caller's already-fetched, traced
    // `ethrex_simulateFrameTransaction` response) carries a native ERC-7562
    // trace segmented per frame (`FrameEntry[]`, under `erc7562Trace`).
    // `checkEntityCompliance` below walks that real `FrameCallTraceFrame`
    // tree directly - no synthetic geth-shaped wrapper.

    // Fail closed: a missing trace (tracing was requested but the tx never
    // reached the traced execution pass - see
    // EthrexSimulateFrameTransactionResult's doc comment) must not fall
    // through to `checkEntityCompliance` with a hollow/default trace.
    // Surfaced as an RpcError carrying ethrex's own
    // canonicalMempoolViolation/executionError/erc7562TraceError string,
    // mirroring this same method's existing convention for reporting
    // simulation failures (e.g. the revert-reason RpcErrors below).
    //
    // `simResult.canonicalMempoolValid` is deliberately NOT part of this
    // condition: it's ethrex's own canonical-mempool-policy opinion, decoupled
    // from whether it reports execution results - `false` there does not
    // imply a missing trace. `erc7562Trace == null` is the real "no data"
    // signal; everything downstream (checkEntityCompliance's ERC-7562 rules,
    // pre_verify-aware checks) is the sidecar's own admission gate, run against
    // the trace regardless of ethrex's canonical-mempool verdict.
    //
    // `erc7562TraceError` is ethrex's own reason when the gas pass
    // succeeded but the trace pass itself specifically failed -
    // in that case `canonicalMempoolViolation`/`executionError` are both
    // `null`, so without this in the chain the caller only ever saw the
    // generic fallback message instead of the real reason. Ordered between
    // `canonicalMempoolViolation` (a structural/gas-cap rejection - more
    // specific, since it means tracing was never even attempted) and
    // `executionError` (a revert during the traced execution pass itself).
    if (simResult.erc7562Trace == null) {
      const reason =
        (simResult.canonicalMempoolViolation != null
          ? describeEthrexViolation(simResult.canonicalMempoolViolation)
          : null) ??
        simResult.erc7562TraceError ??
        simResult.executionError ??
        "frame transaction simulation failed";
      // ethrex rejects an unusable EIP-8272 reference (too new, expired, or
      // not committed) before running any frame; report it as such.
      throw collector.failed(
        /EIP-8272/.test(reason)
          ? EXPLORER_RULES.RECENT_ROOT
          : EXPLORER_RULES.SIMULATION,
        new RpcError(
          this.describeStructuredFailure(simResult) ??
            (await this.explainFailure(tx, reason, BigInt(simResult.maxCost))),
          RpcErrorCodes.VALIDATION_FAILED
        )
      );
    }
    collector.pass(EXPLORER_RULES.SIMULATION);
    if (tx.recentRootReferences.length > 0) {
      // ethrex checked every reference (window and commitment) before running
      // the frames it just traced; see `Eth.checkRecentRootWindow`.
      collector.pass(EXPLORER_RULES.RECENT_ROOT);
    }

    // See erc7562TraceAdapter.ts's selectPrefixTrace doc comment:
    // lastPrefixIndex bounds epTopLevelCalls to the validation prefix's own
    // frames, excluding post-prefix body frames (e.g. a post_op) that would
    // otherwise be miscounted as extra validation-prefix top-level calls.
    const { epTopLevelCalls, transactionKeccak } = selectPrefixTrace(
      simResult,
      lastPrefixIndex
    );

    // ERC-4337's predecessor validator hashed every referenced contract's
    // bytecode on a second debug_traceCallPrestate call and rejected an op
    // if that hash didn't match one computed during an earlier validation
    // pass of the SAME op - guarding the bundler's own `handleOps` batch
    // (which it signed and paid gas for) from going stale between admission
    // and the bundler including it in that self-submitted transaction.
    // There is no equivalent risk here to guard against: a frame
    // transaction is already fully signed and pays its own fees, and this
    // bundler relays it via the privileged ethrex endpoint unmodified (see
    // `PrivilegedRelayer`) - there is no bundler-owned, bundler-paid
    // transaction whose staleness this bundler needs to protect itself
    // from. Porting this specific defense would solve a problem that
    // doesn't exist in this model.
    //
    // The real analogous gap is different in shape: an already-admitted
    // mempool entry needs re-checking against newly mined blocks and
    // eviction once it's no longer ERC-7562-compliant. ERC-4337's
    // on-chain-event-driven EventsService did this and was removed outright
    // for frame transactions; `MempoolReconciler`
    // (`BundlingService/reconciliation.ts`) is its replacement, driven off
    // newly observed block numbers rather than EntryPoint events. That's
    // mempool/network hygiene - keeping the standard alt-mempool honest for
    // other bundlers gossiping it - not a second validation pass in the
    // ERC-4337 sense.
    const result = await this.checkEntityCompliance(
      epTopLevelCalls,
      simResult.executionError,
      transactionKeccak,
      tx,
      prefix,
      lastPrefixIndex,
      collector
    );
    return {
      ...result,
      maxCost: simResult.maxCost
        ? BigInt(simResult.maxCost)
        : estimateMaxCost(tx),
    };
  }

  /**
   * Builds the `{sender?, payer, factory?}`-shaped stake-info map by
   * looking up each validation-prefix role's resolved address against
   * `StakingRegistryService` - not a parsed EntryPoint validation-result
   * struct, since no such struct exists for a frame transaction.
   */
  private async resolveRoleStakes(
    tx: FrameTransaction,
    prefix: ValidationPrefixMatch
  ): Promise<Partial<Record<EntityRole, StakeInfo & { addr: Hex }>>> {
    const roleStakes: Partial<Record<EntityRole, StakeInfo & { addr: Hex }>> =
      {};
    for (const { frame, role } of prefix.frames) {
      const addr = resolveRoleAddr(role, frame, tx.sender);
      const deposit = await this.stakingRegistryService.getDepositInfo(addr);
      roleStakes[role] = {
        addr,
        stake: deposit.stake,
        unstakeDelaySec: deposit.unstakeDelaySec,
        withdrawTime: deposit.withdrawTime,
      };
    }
    return roleStakes;
  }

  /**
   * `ReputationService.checkStake(info)`, memoized per address for the
   * duration of one `validate()` call - the associated-storage loop below
   * can call this once per accessed slot/address, and `ReputationService`
   * hits its own DB for whitelist/ban status on every call.
   *
   * Takes an already-resolved `StakeInfo` (both call sites below already
   * have one in hand from `resolveRoleStakes`'s `roleStakes` map - no
   * on-chain re-fetch needed here) rather than a bare address:
   * `ReputationService.checkStake` was always contract-agnostic (it
   * consults its own whitelist/ban state, then thresholds the `StakeInfo`
   * it's handed), exactly mirroring how ERC-4337's `safe.ts` called it -
   * see `parseValidationResult`'s `stakeInfoEntities` on the pre-fork
   * `develop` branch. `StakingRegistryService` stays a pure on-chain data
   * source (`getDepositInfo`, used by `resolveRoleStakes`), not a second,
   * independent stake-checking implementation.
   */
  private async checkStakeCached(
    info: StakeInfo & { addr: Hex },
    cache: Map<string, { code: number; msg: string }>
  ): Promise<{ code: number; msg: string }> {
    const key = info.addr.toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    const result = await this.reputationService.checkStake(info);
    cache.set(key, result);
    return result;
  }

  private async checkEntityCompliance(
    epTopLevelCalls: FrameCallTraceFrame[],
    executionError: string | null,
    transactionKeccak: `0x${string}`[],
    tx: FrameTransaction,
    prefix: ValidationPrefixMatch,
    lastPrefixIndex: number,
    collector: CheckCollector
  ): Promise<Omit<FrameTxValidationResult, "maxCost">> {
    let satisfiesStandardMempool = true; // false if some entity is in whitelist

    // Accumulates every slot touched by any prefix frame, across the whole
    // transaction, for `FrameTxValidationResult.accessedSlots` (see its doc
    // comment). Deliberately a SEPARATE accumulator from the per-iteration
    // `access` map computed below the fail-closed checks are gated on -
    // reusing one shared object for both would let an earlier frame's
    // accesses leak into a later frame's own compliance check, changing the
    // security-relevant control flow this method exists to protect. This
    // aggregation runs unconditionally (even for a whitelisted entity's
    // frame, before its check is skipped via `continue`), since it's only
    // ever consumed by an out-of-band future revalidation pass, not by any
    // decision this method itself makes.
    const aggregatedAccess: { [address: string]: EthrexAccessedSlots } = {};

    const entryPoint = ENTRY_POINT.toLowerCase();

    // Fail-closed frameIndex<->trace-level alignment invariant.
    // `lastPrefixIndex` is computed once by the caller (validate()) and
    // threaded through here (and into selectPrefixTrace) rather than
    // re-derived, so both consumers agree on the same value.
    if (epTopLevelCalls.length !== lastPrefixIndex + 1) {
      throw collector.failed(
        EXPLORER_RULES.TRACE_ALIGNMENT,
        new RpcError(
          `frame trace has ${epTopLevelCalls.length} top-level call(s), expected exactly ${lastPrefixIndex + 1} (one per tx.frames[0..${lastPrefixIndex}]) - cannot safely correlate frameIndex to trace level`,
          RpcErrorCodes.INTERNAL_ERROR
        )
      );
    }
    collector.pass(EXPLORER_RULES.TRACE_ALIGNMENT);

    // ERC-7562 [OP-061]: "CALL with value is forbidden." No EntryPoint
    // exception applies here - the ERC-4337-only exemptions [OP-051]-
    // [OP-055] that carve-out referred to (depositTo/fallback-with-value/
    // etc.) have no EIP-8141 equivalent, so every nested CALL-family opcode
    // with nonzero value is banned unconditionally. See
    // hasNestedCallWithValue's doc comment (utils.ts).
    if (epTopLevelCalls.some((call) => hasNestedCallWithValue(call))) {
      throw collector.failed(
        EXPLORER_RULES.NESTED_CALL_VALUE,
        new RpcError(
          "nested CALL with value during validation",
          RpcErrorCodes.INVALID_OPCODE
        )
      );
    }
    collector.pass(EXPLORER_RULES.NESTED_CALL_VALUE);

    const sender = tx.sender.toLowerCase();

    if (executionError) {
      throw collector.failed(
        EXPLORER_RULES.EXECUTION,
        new RpcError(executionError, RpcErrorCodes.VALIDATION_FAILED)
      );
    }
    collector.pass(EXPLORER_RULES.EXECUTION);

    const roleStakes = await this.resolveRoleStakes(tx, prefix);
    const hasFactory = prefix.frames.some((f) => f.role === "factory");
    // Memoizes ReputationService.checkStake per address for the
    // duration of this validate() call.
    const stakeCheckCache = new Map<string, { code: number; msg: string }>();

    const entitySlots: { [addr: string]: Set<string> } = parseEntitySlots(
      roleStakes,
      transactionKeccak
    );

    function nameAddr(addr: string): string {
      const [title] =
        Object.entries(roleStakes).find(
          ([, info]) => info?.addr.toLowerCase() === addr.toLowerCase()
        ) ?? [];
      return title ?? addr;
    }

    for (const { frameIndex, role } of prefix.frames) {
      const entStakes = roleStakes[role]!;
      const entityAddr = entStakes.addr.toLowerCase();
      const currentNumLevel = epTopLevelCalls[frameIndex];
      const ctx = { frameIndex, entity: role };

      if (!currentNumLevel) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `missing trace into ${role} frame`,
            RpcErrorCodes.EXECUTION_REVERTED
          ),
          ctx
        );
      }

      // Best-effort target cross-check restoring something closer to
      // safe.ts's fail-closed method-signature match, now that there is no
      // EntryPoint call whose calldata target to check against directly.
      //
      // `to` is typed `Address | null` only because of ethrex's Rust
      // `#[derive(Default)]` on `FrameCallTraceFrame` - every one of the
      // three frame-root dispatch call sites (vm.rs) that can produce an
      // `epTopLevelCalls` entry always passes `CallType::CALL` and a
      // concrete, non-optional `Address`, so `to` is never actually `null`
      // here for a well-formed response. Treat it as the same fail-closed
      // signal as the length-mismatch check above, not something to
      // silently route around.
      if (currentNumLevel.to == null) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `frame trace/frameIndex misalignment: frame ${frameIndex} (role ${role}) trace level has no resolvable target address`,
            RpcErrorCodes.INTERNAL_ERROR
          ),
          ctx
        );
      }
      if (currentNumLevel.to.toLowerCase() !== entityAddr) {
        throw collector.failed(
          EXPLORER_RULES.TRACE_ALIGNMENT,
          new RpcError(
            `frame trace/frameIndex misalignment: frame ${frameIndex} (role ${role}) trace level targets ${currentNumLevel.to}, expected ${entityAddr}`,
            RpcErrorCodes.INTERNAL_ERROR
          ),
          ctx
        );
      }
      collector.pass(EXPLORER_RULES.TRACE_ALIGNMENT, ctx);

      const opcodes = getOpcodesInfo(currentNumLevel);

      const access = getAccessInfo(currentNumLevel);
      // Side effect only: mutates `aggregatedAccess` in place. See its
      // declaration above for why this is a second, independent call rather
      // than reusing `access`.
      getAccessInfo(currentNumLevel, aggregatedAccess);

      const isOutOfGas = outOfGasExists(currentNumLevel);

      if (isOutOfGas) {
        throw collector.failed(
          EXPLORER_RULES.OUT_OF_GAS,
          new RpcError(
            `${role} internally reverts on oog`,
            RpcErrorCodes.INVALID_OPCODE
          ),
          ctx
        );
      }
      collector.pass(EXPLORER_RULES.OUT_OF_GAS, ctx);

      // Every rule below runs even after an earlier one fails, so the report
      // can show all violations. Only the FIRST violation (source order) is
      // thrown / whitelist-checked afterwards - identical to the old
      // single-try/catch behavior.
      const violations: any[] = [];
      const check = async (
        rule: ExplorerRuleId,
        fn: () => void | Promise<void>
      ): Promise<void> => {
        try {
          await fn();
          collector.pass(rule, ctx);
        } catch (err: any) {
          collector.fail(rule, err?.message ?? String(err), ctx);
          violations.push(err);
        }
      };

      await check(EXPLORER_RULES.BANNED_OPCODE, () => {
        // `opcodes` keys are ethrex's native decimal opcode-byte strings
        // (e.g. `"241"` for CALL/0xf1) - see FrameCallTraceFrame.usedOpcodes'
        // doc comment (ethrexFrameTx.ts). `EVM_OPCODES` (packages/params) is
        // indexed by hex string, so every lookup here converts first.
        Object.keys(opcodes).forEach((opcode) => {
          const opcodeName = EVM_OPCODES["0x" + Number(opcode).toString(16)];
          if (bannedOpCodes.has(opcodeName)) {
            if (
              (opcodeName === "BALANCE" || opcodeName === "SELFBALANCE") &&
              BigInt(entStakes.stake) > this.networkConfig.minStake
            ) {
              return;
            }
            throw new RpcError(
              `${role} uses banned opcode: ${opcodeName}`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        });
      });

      await check(EXPLORER_RULES.CREATE, () => {
        if (role !== "factory" && opcodes[String(0xf0)] > 0) {
          throw new RpcError(
            `${role} uses banned opcode: CREATE`,
            RpcErrorCodes.INVALID_OPCODE
          );
        }

        // Special case for CREATE2
        if (role === "factory") {
          if (opcodes[String(0xf5)] > 1) {
            throw new RpcError(
              `${role} with too many CREATE2`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        } else {
          if (opcodes[String(0xf5)] > 0) {
            throw new RpcError(
              `${role} uses banned opcode: CREATE2`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      await check(EXPLORER_RULES.STORAGE, async () => {
        for (const [
          addr,
          { reads, writes, transientReads, transientWrites },
        ] of Object.entries(access)) {
          if (addr === sender) {
            continue;
          }

          if (addr === entryPoint) {
            continue;
          }

          let requireStakeSlot: string | undefined;
          for (const slot of [
            ...Object.keys(writes),
            ...Object.keys(reads),
            ...Object.keys(transientReads),
            ...Object.keys(transientWrites),
          ]) {
            if (isSlotAssociatedWith(slot, sender, entitySlots)) {
              if (hasFactory) {
                const stake = await this.checkStakeCached(
                  roleStakes.factory!,
                  stakeCheckCache
                );
                if (!(entityAddr === sender && stake.code === 0)) {
                  requireStakeSlot = slot;
                }
              }
            } else if (isSlotAssociatedWith(slot, entityAddr, entitySlots)) {
              requireStakeSlot = slot;
            } else if (addr === entityAddr) {
              requireStakeSlot = slot;
            } else if (writes[slot] == null) {
              requireStakeSlot = slot;
            } else {
              const readWrite = Object.keys(writes).includes(addr)
                ? "write to"
                : "read from";
              throw new RpcError(
                `${role} has forbidden ${readWrite} ${nameAddr(addr)} slot ${slot}`,
                RpcErrorCodes.INVALID_OPCODE,
                {
                  [role]: entStakes.addr,
                  accessed: addr,
                }
              );
            }
          }

          if (requireStakeSlot != null) {
            const stake = await this.checkStakeCached(
              entStakes,
              stakeCheckCache
            );
            if (stake.code != 0) {
              throw new RpcError(
                `unstaked ${role} accessed ${nameAddr(addr)} slot ${requireStakeSlot}`,
                RpcErrorCodes.INVALID_OPCODE,
                {
                  [role]: entStakes.addr,
                  accessed: addr,
                }
              );
            }
          }
        }
      });

      await check(EXPLORER_RULES.CODE_ACCESS, () => {
        const contractSizes = getContractSizes(currentNumLevel, {});
        for (const addr of Object.keys(contractSizes)) {
          if (
            addr !== sender &&
            contractSizes[addr].contractSize <= 2 &&
            !this.networkConfig.precompiles.includes(addr.toLowerCase())
          ) {
            const { opcode } = contractSizes[addr];
            throw new RpcError(
              `${role} accesses un-deployed contract address ${addr} with opcode ${
                EVM_OPCODES["0x" + Number(opcode).toString(16)]
              }`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      await check(EXPLORER_RULES.ENTRYPOINT_ACCESS, () => {
        const extCodeAccessInfos = getExtCodeAccessInfos(currentNumLevel, []);
        for (const addr of extCodeAccessInfos) {
          if (addr === entryPoint) {
            throw new RpcError(
              `${role} accesses EntryPoint contract address ${addr}`,
              RpcErrorCodes.INVALID_OPCODE
            );
          }
        }
      });

      if (violations.length === 0) continue;

      // Handle the first violation exactly as the old `catch (err)` did.
      const err = violations[0];
      if (err instanceof RpcError) {
        const accessed = err?.data?.accessed;
        const externalEntities =
          this.networkConfig.whitelistedEntities.external;
        if (
          accessed &&
          externalEntities != null &&
          externalEntities.some(
            (entity: any) => getAddress(entity) === getAddress(accessed)
          )
        ) {
          satisfiesStandardMempool = this.networkConfig
            .relayOpsWithWhitelistedEntities
            ? true
            : false;
          this.logger.debug(
            `${err.message}; ${accessed} is in whitelist. Skipping opcode validation...`
          );
          collector.waive(ctx, "whitelisted external entity");
          continue;
        }
        if (accessed && err?.data && typeof err.data === "object") {
          delete (err.data as any).accessed;
        }
      }
      // check whitelisted senders, payers & factories
      const whitelist =
        this.networkConfig.whitelistedEntities[roleToWhitelistKey[role]];
      if (
        entityAddr &&
        whitelist != null &&
        whitelist.some(
          (addr: any) => getAddress(addr) === getAddress(entityAddr)
        )
      ) {
        satisfiesStandardMempool = this.networkConfig
          .relayOpsWithWhitelistedEntities
          ? true
          : false;
        this.logger.debug(
          `${role} is in whitelist. Skipping opcode validation...`
        );
        collector.waive(ctx, "whitelisted entity");
        continue;
      }

      // if entity is not whitelisted, bubble up the error
      throw err;
    }

    const accessedSlots: { [address: string]: Set<string> } = {};
    for (const [addr, { reads, writes, transientReads, transientWrites }] of Object.entries(
      aggregatedAccess
    )) {
      accessedSlots[addr] = new Set([
        ...Object.keys(reads),
        ...Object.keys(writes),
        ...Object.keys(transientReads),
        ...Object.keys(transientWrites),
      ]);
    }

    return {
      mempoolMembership: {
        [this.networkConfig.standardMempoolId]: satisfiesStandardMempool,
      },
      accessedSlots,
      roleStakes,
    };
  }
}
