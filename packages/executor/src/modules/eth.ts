import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { Logger } from "@skandha/types/lib/index.js";
import { PerChainMetrics } from "@skandha/monitoring/lib/index.js";
import {
  FrameTransaction,
  ENTRY_POINT,
  recentRootWindowViolation,
} from "@skandha/types/lib/contracts/FrameTx.js";
import { FrameTxReceipt } from "@skandha/types/lib/executor/validation/frameTxReceipt.js";
import { PublicClient, Hex, keccak256 } from "viem";
import { MempoolService } from "../services/index.js";
import { FrameTxSimulationService } from "../services/FrameTxSimulationService/index.js";
import { recognizeValidationPrefix } from "../services/UserOpValidation/utils/validationPrefix.js";
import { ReceiptService } from "../services/ReceiptService/index.js";
import {
  AdmissionSource,
  EXPLORER_RULES,
} from "@skandha/types/lib/explorer/index.js";
import { CheckCollector } from "../services/ExplorerService/checkCollector.js";
import { ExplorerService } from "../services/ExplorerService/service.js";
import { GetNodeAPI, NetworkConfig } from "../interfaces.js";
import { encodeRawFrameTx } from "../services/FrameTxService/codec.js";
import { now } from "../utils/index.js";
import { getHeadSlot } from "../utils/headSlot.js";
import { FrameTxMempoolEntrySerialized } from "../entities/interfaces.js";
import { FrameGasEstimate } from "./interfaces.js";
import { Skandha } from "./skandha.js";

/**
 * EIP-8141 frame-transaction RPC surface: `sendFrameTransaction`/
 * `estimateFrameTransactionGas`/`getFrameTransactionByHash`/
 * `getFrameTransactionReceipt`.
 *
 * No `getSupportedEntryPoints`/`validateEntryPoint`: there is exactly one
 * fixed `ENTRY_POINT` sentinel address under EIP-8141, not a
 * configurable/validated set (see `@skandha/types/lib/contracts/FrameTx`).
 *
 * No Arbitrum/Optimism/Mantle L2 `pvgEstimator`s or `BlockscoutAPI`
 * fallback: both were ABI-encoded-`handleOps`-call-shaped
 * (`encodeHandleOps`) or ERC-4337-specific (Blockscout's UserOp indexer),
 * with no frame-tx analogue. Documented capability gap, not a silent
 * regression.
 *
 * No EIP-7702 authorization-tuple handling: `FrameTransaction` has no
 * `eip7702Auth` field.
 */
export class Eth {
  constructor(
    private chainId: number,
    private publicClient: PublicClient,
    private frameTxSimulationService: FrameTxSimulationService,
    private receiptService: ReceiptService,
    private mempoolService: MempoolService,
    private skandhaModule: Skandha,
    private config: NetworkConfig,
    private logger: Logger,
    private metrics: PerChainMetrics | null,
    private getNodeAPI: GetNodeAPI = () => null,
    private explorer?: ExplorerService
  ) {}

  private markupEstimate(
    estimate: bigint,
    percent: bigint,
    flat: bigint
  ): bigint {
    return (
      (estimate * (BigInt(10000) + percent)) / BigInt(10000) + BigInt(flat)
    );
  }

  /**
   * Submits a frame transaction to the mempool.
   *
   * `FrameTxSimulationService.simulate` runs the opcode/storage/signature
   * admission gate (`FrameTxValidationService.validate`) and obtains real
   * gas-usage/payer data from the same single traced simulation call - see
   * that class's header comment for why one call suffices for both.
   *
   * @param tx a full, signed `FrameTransaction`.
   * @returns the transaction's own hash (EIP-2718 `keccak256(0x06 ||
   *   rlp(fields))`), used as the mempool lookup key and, once mined, as the
   *   standard `eth_getTransactionReceipt` key.
   */
  async sendFrameTransaction(
    tx: FrameTransaction,
    source: AdmissionSource = "rpc"
  ): Promise<Hex> {
    const receivedAt = now();
    const collector = new CheckCollector();
    try {
      return await this.admitFrameTransaction(
        tx,
        source,
        collector,
        receivedAt
      );
    } catch (err) {
      this.recordRejection(tx, source, collector, err, receivedAt);
      throw err;
    }
  }

  private recordRejection(
    tx: FrameTransaction,
    source: AdmissionSource,
    collector: CheckCollector,
    err: unknown,
    receivedAt: number
  ): void {
    if (!this.explorer) return;
    // Bookkeeping must never mask the original error: the caller rethrows
    // `err` itself, so nothing in here may throw.
    try {
      let txHash: string;
      try {
        txHash = keccak256(encodeRawFrameTx(tx));
      } catch {
        return; // malformed transaction: nothing to key a record on
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!collector.hasFailure()) {
        collector.fail(EXPLORER_RULES.ADMISSION, message);
      }
      const record = this.explorer.recordAdmission({
        tx,
        txHash,
        source,
        outcome: "rejected",
        checks: collector.toChecks(),
        errorCode: err instanceof RpcError ? err.code : undefined,
        at: receivedAt,
        frameReceipts: collector.getFrameReceipts(),
      });
      // A refused resubmission of an already accepted tx leaves its record
      // untouched, so it must not add a `rejected` event either.
      if (record.outcome === "rejected") {
        this.explorer.recordLifecycle({
          txHash,
          kind: "rejected",
          reason: message,
        });
      }
    } catch (bookkeepingErr) {
      this.logger.error(bookkeepingErr, "explorer bookkeeping failed");
    }
  }

  private async admitFrameTransaction(
    tx: FrameTransaction,
    source: AdmissionSource,
    collector: CheckCollector,
    receivedAt: number
  ): Promise<Hex> {
    if (tx.chainId !== BigInt(this.chainId)) {
      throw collector.failed(
        EXPLORER_RULES.STRUCTURE,
        new RpcError(
          `frame transaction chain id ${tx.chainId} does not match this node's chain id ${this.chainId}`,
          RpcErrorCodes.INVALID_USEROP
        )
      );
    }
    const totalLimitGas = tx.frames.reduce(
      (sum, frame) => sum + frame.limits.execution + frame.limits.state,
      BigInt(0)
    );
    if (totalLimitGas > BigInt(this.config.userOpGasLimit)) {
      throw collector.failed(
        EXPLORER_RULES.GAS_LIMIT,
        new RpcError(
          "Frame transaction's gas limit is too high",
          RpcErrorCodes.INVALID_USEROP
        )
      );
    }
    collector.pass(EXPLORER_RULES.GAS_LIMIT);

    await this.checkRecentRootWindow(tx, collector);

    const { validation } = await this.frameTxSimulationService.simulate(
      tx,
      collector
    );

    const txHash = keccak256(encodeRawFrameTx(tx));

    this.logger.debug("Validating frame transaction before sending to mempool...");
    let replacedTxHash: string | undefined;
    try {
      await this.mempoolService.validateFrameTxReplaceability(tx);

      // `roleStakes` came from the same StakingRegistryService lookups
      // `validate()` already made for its opcode/storage checks - not a
      // second round of on-chain reads. A role absent from the validation
      // prefix (e.g. "sender" in the Self Relay shape) is simply undefined
      // here; MempoolService.addFrameTx's reputation gate tolerates that.
      const added = await this.mempoolService.addFrameTx(
        tx,
        txHash,
        undefined,
        validation.roleStakes.sender,
        validation.roleStakes.factory,
        validation.roleStakes.payer,
        validation.maxCost
      );
      replacedTxHash = added?.replacedTxHash;
    } catch (err) {
      throw collector.failed(
        EXPLORER_RULES.MEMPOOL,
        err instanceof Error ? err : new Error(String(err))
      );
    }
    collector.pass(EXPLORER_RULES.MEMPOOL);
    this.logger.debug("Saved in mempool");

    if (this.explorer) {
      // The tx is already persisted: bookkeeping failures must not turn a
      // successful admission into an error or skip the gossip publish below.
      try {
        this.explorer.recordAdmission({
          tx,
          txHash,
          source,
          outcome: "accepted",
          checks: collector.toChecks(),
          at: receivedAt,
          frameReceipts: collector.getFrameReceipts(),
        });
        if (replacedTxHash) {
          this.explorer.markReplaced(replacedTxHash, txHash);
        }
      } catch (err) {
        this.logger.error(err, "explorer bookkeeping failed");
      }
    }

    this.metrics?.useropsInMempool.inc();

    try {
      const nodeApi = this.getNodeAPI();
      if (nodeApi) {
        // There is exactly one fixed ENTRY_POINT sentinel under EIP-8141
        // (see the class doc comment above), so - unlike the old
        // multi-EntryPoint `sendUserOperation` this mirrors - there is no
        // per-EntryPoint mempool lookup to do; just resolve whichever
        // mempool(s) this node is configured to relay on.
        let supportedMempools = this.config.supportedMempools;
        if (!supportedMempools || supportedMempools.length === 0) {
          if (this.config.standardMempoolId && this.config.canonicalEntryPoint) {
            supportedMempools = [
              {
                mempoolId: this.config.standardMempoolId,
                entryPoint: this.config.canonicalEntryPoint,
              },
            ];
          } else {
            supportedMempools = [];
          }
        }

        const matchingMempool = supportedMempools.find(
          (mempool) =>
            mempool.entryPoint.toLowerCase() === ENTRY_POINT.toLowerCase() &&
            mempool.mempoolId.length > 0
        );

        if (matchingMempool) {
          // Publish if:
          // 1. The frame tx was found to belong to this specific mempool
          //    (validation.mempoolMembership[matchingMempool.mempoolId] is
          //    true - see FrameTxValidationResult's doc comment: no
          //    mempool is privileged as "canonical" here, this is just
          //    membership in whichever one this node relays on), OR
          // 2. We're configured to relay txs with whitelisted entities
          const belongsToMatchingMempool =
            validation.mempoolMembership[matchingMempool.mempoolId] === true;
          const shouldPublish =
            belongsToMatchingMempool ||
            this.config.relayOpsWithWhitelistedEntities;

          if (shouldPublish) {
            const blockNumber = await this.publicClient.getBlockNumber();
            await nodeApi.publishVerifiedFrameTxJSON(
              ENTRY_POINT,
              tx,
              blockNumber.toString(),
              matchingMempool.mempoolId
            );
            this.metrics?.useropsSent?.inc();
          } else {
            // Diagnostic for an otherwise entirely silent no-op: the mempool
            // matched, but this transaction does not belong to it and the
            // node is not configured to relay non-member txs anyway.
            this.logger.debug(
              `Not publishing frame transaction ${txHash} over gossipsub: ` +
                `belongsToMatchingMempool=${belongsToMatchingMempool}, ` +
                `relayOpsWithWhitelistedEntities=${this.config.relayOpsWithWhitelistedEntities}`
            );
          }
        } else {
          // Diagnostic for an otherwise entirely silent no-op: the most common
          // misconfiguration is a `supportedMempools`/`canonicalEntryPoint`
          // still carrying a legacy ERC-4337 EntryPoint address instead of the
          // fixed EIP-8141 ENTRY_POINT sentinel, which disables gossip
          // publishing without any error anywhere.
          this.logger.debug(
            `Not publishing frame transaction ${txHash} over gossipsub: no ` +
              `configured mempool matches entryPoint ${ENTRY_POINT}. Configured ` +
              `mempools: ${JSON.stringify(
                supportedMempools.map((mempool) => ({
                  mempoolId: mempool.mempoolId,
                  entryPoint: mempool.entryPoint,
                }))
              )}`
          );
        }
      }
    } catch (err) {
      this.logger.debug(`Could not send frame transaction over gossipsub: ${err}`);
    }

    return txHash;
  }

  /**
   * EIP-8272: refuses a reference outside the usable slot window before
   * paying for a simulation, under its own explorer rule. Commitment of the
   * root itself is the simulation's job, so with references present the
   * rule's pass is recorded by `FrameTxValidationService.validate` once the
   * simulation accepted them. Without a readable head slot ethrex's own
   * (identical) window check decides.
   */
  private async checkRecentRootWindow(
    tx: FrameTransaction,
    collector: CheckCollector
  ): Promise<void> {
    if (tx.recentRootReferences.length > 0) {
      const headSlot = await getHeadSlot(this.publicClient).catch(
        () => undefined
      );
      const violation =
        headSlot === undefined
          ? null
          : recentRootWindowViolation(tx.recentRootReferences, headSlot);
      if (violation !== null) {
        throw collector.failed(
          EXPLORER_RULES.RECENT_ROOT,
          new RpcError(violation, RpcErrorCodes.INVALID_USEROP)
        );
      }
      return;
    }
    collector.pass(EXPLORER_RULES.RECENT_ROOT);
  }

  /**
   * Estimates gas for a (possibly partial/unsigned) frame transaction.
   * Replaces both the old `estimateUserOperationGas` (dummy-signature
   * estimation) and `estimateUserOperationGasWithSignature` (real-signature
   * estimation): `FrameTxValidationService.validate`'s signature loop only
   * ever iterates `tx.signatures` (see `frameTx.ts`), so a caller that omits
   * `signatures` entirely gets the same "skip real signature verification"
   * convenience the old dummy-ECDSA-signature path provided, while a caller
   * that supplies real signatures gets them genuinely checked - one method
   * now covers both cases instead of two.
   *
   * Each BODY frame's (i.e. a frame after the validation prefix) `limits.
   * execution`/`limits.state` is overridden with a generous placeholder
   * before simulating (mirroring the old code's `callGasLimit: BigInt(10e6)`
   * -style placeholders) so the simulation of the frame(s) whose real gas
   * cost is actually unknown isn't gas-capped by the caller's own guess.
   *
   * Validation-PREFIX frames are deliberately left at the caller-supplied
   * limits instead: `frameTxSimulationService.simulate` internally calls
   * `FrameTxValidationService.validate`, which enforces the real
   * validation-prefix gas caps (`validateStructuralRules`: the per-entity
   * `MAX_VERIFY_GAS_PER_ENTITY`/`MAX_VERIFY_GAS_STAKED_ENTITY` budgets and
   * `MAX_VERIFY_STATE_GAS` in `UserOpValidation/utils/validationPrefix.ts`) over
   * `tx.frames[0..lastPrefixIndex]`. Slapping the same generous placeholder
   * on prefix frames (as this method used to do) always exceeds those caps
   * and makes every estimate call fail regardless of input (fix round #1,
   * B1). `recognizeValidationPrefix` is the same prefix-shape matcher
   * `FrameTxValidationService.validate()` and `erc7562TraceAdapter.ts` use to
   * derive `lastPrefixIndex` - reused here so this method draws the
   * prefix/body boundary identically to the code that will actually enforce
   * it. If the frames don't match any recognized prefix shape at all,
   * `lastPrefixIndex` stays `-1` (every frame treated as "body") and the
   * placeholder is applied uniformly, exactly as before this fix - `simulate`
   * (via `validate`) will then reject with the real "validation prefix not
   * recognized" error instead of a misleading gas-cap violation.
   */
  async estimateFrameTransactionGas(
    tx: Partial<FrameTransaction>
  ): Promise<FrameGasEstimate> {
    if (!tx.sender) {
      throw new RpcError(
        "Frame transaction requires a sender",
        RpcErrorCodes.INVALID_REQUEST
      );
    }
    if (!tx.frames || tx.frames.length === 0) {
      throw new RpcError(
        "Frame transaction requires at least one frame",
        RpcErrorCodes.INVALID_REQUEST
      );
    }

    const placeholderLimit = BigInt(10e6);
    const prefix = recognizeValidationPrefix(tx.frames, tx.sender);
    const lastPrefixIndex = prefix
      ? Math.max(...prefix.frames.map((f) => f.frameIndex))
      : -1;

    const fullTx: FrameTransaction = {
      chainId: tx.chainId ?? BigInt(this.chainId),
      nonceKeys: tx.nonceKeys ?? [BigInt(0)],
      nonceSeq: tx.nonceSeq ?? BigInt(0),
      sender: tx.sender,
      frames: tx.frames.map((frame, index) =>
        index <= lastPrefixIndex
          ? frame
          : {
              ...frame,
              limits: { execution: placeholderLimit, state: placeholderLimit },
            }
      ),
      signatures: tx.signatures ?? [],
      recentRootReferences: tx.recentRootReferences ?? [],
      fees: tx.fees ?? {
        maxPriorityFeePerGas: BigInt(1),
        maxFeePerGas: BigInt(1),
        maxFeePerBlobGas: BigInt(0),
      },
      blobVersionedHashes: tx.blobVersionedHashes ?? [],
    };

    const { simulation } = await this.frameTxSimulationService.simulate(fullTx);
    const gasFee = await this.skandhaModule.getGasPrice();

    const frames = simulation.frameReceipts.map((receipt) => ({
      execution: this.markupEstimate(
        BigInt(receipt.gasUsed.execution),
        BigInt(this.config.cglMarkupPercent),
        BigInt(this.config.cglMarkup)
      ),
      state: this.markupEstimate(
        BigInt(receipt.gasUsed.state),
        BigInt(this.config.vglMarkupPercent),
        BigInt(this.config.vglMarkup)
      ),
    }));

    const cumulativeGasUsed = this.markupEstimate(
      BigInt(simulation.cumulativeGasUsed),
      BigInt(this.config.pvgMarkupPercent),
      BigInt(this.config.pvgMarkup)
    );

    this.metrics?.useropsEstimated.inc();

    return {
      frames,
      cumulativeGasUsed,
      maxFeePerGas: BigInt(gasFee.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(gasFee.maxPriorityFeePerGas),
    };
  }

  /**
   * @param hash the frame transaction's own hash (see `sendFrameTransaction`).
   * @returns the mempool entry (serialized) if the transaction is still
   *   known to this node's mempool, or `null` otherwise. Unlike the old
   *   `getUserOperationByHash`, there is no EntryPoint-event-log or
   *   Blockscout fallback for a transaction that has already been pruned
   *   from the mempool after mining - a real "look it up by hash after it's
   *   gone from the mempool" path would need a frame-tx-aware indexer, which
   *   doesn't exist yet. Documented gap.
   */
  async getFrameTransactionByHash(
    hash: Hex
  ): Promise<FrameTxMempoolEntrySerialized | null> {
    const entry = await this.mempoolService.getEntryByHash(hash);
    return entry ? entry.serialize() : null;
  }

  /**
   * @param hash the frame transaction's own hash.
   * @returns a full `FrameTxReceipt`, backed by `ReceiptService` rather
   *   than an EntryPoint-event-log filter. This does not swallow a "not
   *   found" condition into `null` - `ReceiptService.getReceipt` throws an
   *   `RpcError` for both "not yet mined" and "not a frame transaction",
   *   and this module doesn't reinterpret that contract by string-matching
   *   its message.
   */
  async getFrameTransactionReceipt(hash: Hex): Promise<FrameTxReceipt> {
    return this.receiptService.getReceipt(hash);
  }

  /**
   * eth_chainId
   * @returns EIP-155 Chain ID.
   */
  async getChainId(): Promise<number> {
    if (this.chainId == null) {
      this.chainId = await this.publicClient.getChainId();
    }
    return this.chainId;
  }
}
