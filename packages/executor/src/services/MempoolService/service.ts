import { Mutex } from "async-mutex";
import { IDbController, Logger } from "@skandha/types/lib/index.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import {
  FrameTransaction,
  isKeyedNonce,
} from "@skandha/types/lib/contracts/FrameTx.js";
import { keccak256, toHex } from "viem";
import { ReputationService } from "../ReputationService.js";
import { ExecutorEvent, ExecutorEventBus } from "../SubscriptionService.js";
import { NetworkConfig, StakeInfo } from "../../interfaces.js";
import {
  IFrameTxMempoolEntry,
  FrameTxMempoolEntrySerialized,
} from "../../entities/interfaces.js";
import { FrameTxMempoolEntry as MempoolEntry } from "../../entities/FrameTxMempoolEntry.js";
import { now } from "../../utils/index.js";
import { encodeRawFrameTx } from "../FrameTxService/codec.js";
import { frameTxSlotKey, rawEntryToMempoolEntry } from "./utils.js";
import { frameTxObligations, totalObligations } from "./obligations.js";
import { MempoolReputationChecks } from "./reputation.js";
import { ARCHIVE_PURGE_INTERVAL } from "./constants.js";

/**
 * EIP-8141 frame-transaction mempool. Keyed by slot (`frameTxSlotKey`):
 * `sender:nonce` for linear txs, `sender:keys:nonceSeq` for EIP-8250 keyed
 * ones, with each nonce key held by at most one pending tx
 * (`checkNonceKeyConflict`). Not scoped by `entryPoint` - there is exactly one fixed `ENTRY_POINT`
 * sentinel under EIP-8141, not a per-request configurable address. There is
 * no `EntryPointService` for factory/paymaster resolution -
 * `FrameTxMempoolEntry` resolves `sender`/`payer`/`factory` itself from the
 * transaction's validation prefix.
 *
 * Re-checking an already-admitted entry against newly mined blocks (e.g. an
 * entity that was staked/whitelisted at admission no longer is, or an
 * account's code changed in a way that would now fail the opcode/storage
 * rules) is NOT this service's job - `MempoolService` stays a pure
 * storage/query layer. `BundlingService/reconciliation.ts`'s
 * `MempoolReconciler` owns that, driven off newly observed block numbers,
 * replacing ERC-4337's on-chain-event-driven `EventsService` (removed
 * outright for frame transactions). This is mempool/network hygiene -
 * keeping the standard alt-mempool honest for other bundlers gossiping it -
 * distinct from (and not to be confused with) ERC-4337's
 * bundler-batch-staleness defense, which has no equivalent need here at all
 * (see `FrameTxValidationService.validate`'s comment on that).
 */
export class MempoolService {
  private FRAMETX_COLLECTION_KEY: string;
  private FRAMETX_HASHES_COLLECTION_PREFIX: string;
  private WATCHLIST_COLLECTION_KEY: string;
  private WATCHLIST_PREFIX: string;
  private mutex = new Mutex();
  private reputationCheck: MempoolReputationChecks;

  constructor(
    private db: IDbController,
    private chainId: number,
    private reputationService: ReputationService,
    private eventBus: ExecutorEventBus,
    private networkConfig: NetworkConfig,
    private logger: Logger,
    /**
     * Reads an account's balance at head. Enables per-account balance
     * accounting (`checkBalanceObligations`/`enforceBalances`); without it
     * (unit tests) that accounting is skipped.
     */
    private getBalance?: (address: `0x${string}`) => Promise<bigint>
  ) {
    this.FRAMETX_COLLECTION_KEY = `${chainId}:FRAMETXKEYS`;
    this.FRAMETX_HASHES_COLLECTION_PREFIX = "FRAMETXHASH:";
    this.WATCHLIST_COLLECTION_KEY = `${chainId}:WATCHLISTKEYS`;
    this.WATCHLIST_PREFIX = "WATCHLIST:";
    this.reputationCheck = new MempoolReputationChecks(
      this,
      this.reputationService,
      this.networkConfig
    );

    setInterval(() => {
      void this.deleteOldUserOps();
      void this.deleteOldWatchedEntries();
    }, ARCHIVE_PURGE_INTERVAL); // 5 minutes
  }

  /**
   * View functions
   */

  async dump(): Promise<FrameTxMempoolEntrySerialized[]> {
    return (await this.fetchPendingUserOps()).map((entry) => entry.serialize());
  }

  /** Every stored entry, including archived (`OnChain`+) ones. */
  async listAll(): Promise<MempoolEntry[]> {
    return this.fetchAll();
  }

  async fetchPendingUserOps(): Promise<MempoolEntry[]> {
    return (await this.fetchAll()).filter(
      (entry) => entry.status < MempoolEntryStatus.OnChain
    );
  }

  async fetchManyByKeys(keys: string[]): Promise<MempoolEntry[]> {
    const rawEntries = await this.db
      .getMany<IFrameTxMempoolEntry>(keys)
      .catch(() => []);
    return rawEntries.map(rawEntryToMempoolEntry);
  }

  async find(entry: MempoolEntry): Promise<MempoolEntry | null> {
    return this.findByKey(this.getKey(entry));
  }

  async getEntryByHash(hash: string): Promise<MempoolEntry | null> {
    const key = await this.db
      .get<string>(`${this.FRAMETX_HASHES_COLLECTION_PREFIX}${hash}`)
      .catch(() => null);
    if (!key) return null;
    return this.findByKey(key);
  }

  async getNewEntriesSorted(size: number, offset = 0): Promise<MempoolEntry[]> {
    const allEntries = await this.fetchAll();
    return allEntries
      .filter((entry) => entry.status === MempoolEntryStatus.New)
      .sort(MempoolEntry.compareByCost)
      .slice(offset, offset + size);
  }

  async validateFrameTxReplaceability(tx: FrameTransaction): Promise<boolean> {
    const entry = new MempoolEntry(tx, {
      txHash: keccak256(encodeRawFrameTx(tx)),
    });
    await this.checkNonceKeyConflict(entry);
    return this.validateReplaceability(entry);
  }

  /**
   * Write functions
   */
  async updateStatus(
    entries: MempoolEntry[],
    status: MempoolEntryStatus,
    params?: {
      transaction?: string;
      revertReason?: string;
      includer?: `0x${string}`;
    }
  ): Promise<void> {
    for (const entry of entries) {
      entry.setStatus(status, params);
      await this.update(entry);

      if (status === MempoolEntryStatus.Cancelled) {
        await this.watchForLateInclusion(entry);
      }

      // event bus logic
      if (
        [
          MempoolEntryStatus.Cancelled,
          MempoolEntryStatus.Submitted,
          MempoolEntryStatus.Reverted,
        ].findIndex((st) => st === status) > -1
      ) {
        this.eventBus.emit(ExecutorEvent.submittedUserOps, entry);
      }
      // `onChainUserOps`/`onOnChainUserOps` (SubscriptionService.ts) already
      // existed but nothing ever emitted this event, because nothing ever
      // set `OnChain` - see this class's header comment. `MempoolReconciler`
      // is the first caller. Widened to also fire on `Reverted`: a
      // reverted-but-mined transaction still has a receipt and an includer -
      // `included` means "has a block", independent of the frame-level
      // outcome (see the explorer-activity-outcomes design spec). Note this
      // reaches TWO independent consumers: `ExplorerService.attach` (the
      // explorer) and `SubscriptionService`'s own raw
      // `skandha_subscribe(["onChainUserOps"])` WS channel - both now
      // receive `Reverted` entries too, not just `OnChain` ones.
      if (
        status === MempoolEntryStatus.OnChain ||
        status === MempoolEntryStatus.Reverted
      ) {
        this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
      }
      if (status === MempoolEntryStatus.OnChain) {
        await this.reputationCheck.updateIncludedStatus(entry);
      }
    }
  }

  async clearState(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const keys = await this.fetchKeys();
      for (const key of keys) {
        await this.db.del(key);
      }
      await this.db.del(this.FRAMETX_COLLECTION_KEY);
    });
  }

  async attemptToBundle(entries: MempoolEntry[]): Promise<void> {
    for (const entry of entries) {
      entry.submitAttempts++;
      entry.lastUpdatedTime = now();
      await this.update(entry);
    }
  }

  /**
   * Adds a validated frame transaction to the mempool.
   *
   * `senderInfo`/`factoryInfo`/`payerInfo` (per-entity `StakeInfo`) drive
   * `checkEntityCountInMempool`'s ban/throttle gate and `updateSeenStatus`'s
   * reputation bookkeeping - `Eth.sendFrameTransaction` supplies them from
   * `FrameTxValidationResult.roleStakes`, itself resolved against
   * `StakingRegistryService` during the same `validate()` call, no second
   * lookup. Still individually optional here: a role absent from the
   * validation prefix (e.g. "sender" in the Self Relay shape, where the
   * sender's own authorization folds into the "payer" frame - see
   * `FrameTxMempoolEntry`'s class doc comment) has no `StakeInfo` to give,
   * not because the lookup was skipped. `checkEntityCountInMempool`/
   * `updateSeenStatus` tolerate any subset being present - see their own
   * comments for exactly how each missing piece degrades.
   */
  async addFrameTx(
    tx: FrameTransaction,
    txHash: string,
    hash?: string,
    senderInfo?: StakeInfo,
    factoryInfo?: StakeInfo,
    payerInfo?: StakeInfo,
    maxCost?: bigint
  ): Promise<{ replacedTxHash?: string }> {
    const entry = new MempoolEntry(tx, {
      txHash,
      hash,
      submittedTime: now(),
      maxCost,
    });
    let replacedTxHash: string | undefined;
    await this.mutex.runExclusive(async () => {
      await this.checkNonceKeyConflict(entry);
      const existingEntry = await this.find(entry);
      await this.checkBalanceObligations(entry, existingEntry);
      if (existingEntry) {
        await this.validateReplaceability(entry, existingEntry);
        // A slot whose holder is no longer pending (Cancelled, Reverted, ...)
        // gains a pending transaction, so it takes the same admission checks
        // as an empty slot. Only a pending holder is a real replacement.
        if (existingEntry.status >= MempoolEntryStatus.OnChain) {
          await this.checkAdmission(entry, senderInfo, factoryInfo, payerInfo);
        }
        await this.db.put(this.getKey(entry), {
          ...entry,
          lastUpdatedTime: now(),
        });
        if (existingEntry.txHash) {
          await this.removeFrameTxHash(existingEntry.txHash);
          // Only a still-live entry (New/Pending/Submitted) being displaced
          // needs watching - one that's already Cancelled was watched the
          // moment it became Cancelled (see updateStatus below), and
          // OnChain/Reverted/Finalized are already resolved. Re-watching an
          // already-watched hash would duplicate it (see the dedupe guard
          // in watchForLateInclusionUnlocked too) and, for the
          // resubmit-the-same-cancelled-tx case, would watch a hash that's
          // simultaneously about to become active again below.
          if (existingEntry.status < MempoolEntryStatus.OnChain) {
            await this.watchForLateInclusionUnlocked(existingEntry);
          }
          replacedTxHash = existingEntry.txHash;
        }
        if (entry.txHash) {
          await this.saveFrameTxHash(entry.txHash, entry);
          // This hash might still be sitting on the watch list from an
          // earlier cancellation/replacement (e.g. resubmitting a
          // previously cancelled transaction unchanged) - it's active
          // again now, not something to watch anymore.
          await this.removeFromWatchlistUnlocked(entry.txHash);
        }
        this.logger.debug("Mempool: Frame transaction replaced");
      } else {
        await this.checkAdmission(entry, senderInfo, factoryInfo, payerInfo);
        const frameTxKeys = await this.fetchKeys();
        const key = this.getKey(entry);
        frameTxKeys.push(key);
        await this.db.put(this.FRAMETX_COLLECTION_KEY, frameTxKeys);
        await this.db.put(key, { ...entry, lastUpdatedTime: now() });
        if (entry.txHash) {
          await this.saveFrameTxHash(entry.txHash, entry);
          // Same guard as the replace branch above - this hash might be a
          // stale watch-list leftover from an earlier cancellation whose
          // sender:nonce slot has since been vacated and is now being
          // freshly filled by this same hash.
          await this.removeFromWatchlistUnlocked(entry.txHash);
        }
        this.logger.debug("Mempool: Frame transaction added");
      }
      if (senderInfo || factoryInfo || payerInfo) {
        // `senderInfo` alone may be undefined (Self Relay) - updateSeenStatus
        // itself tolerates that; see its own comment.
        await this.reputationCheck.updateSeenStatus(entry, senderInfo);
      }
      this.eventBus.emit(ExecutorEvent.pendingUserOps, entry);
    });
    return { replacedTxHash };
  }

  /**
   * The reputation gates a newly pending transaction must pass. Any one of
   * the three `StakeInfo`s being present is enough to run the count gate -
   * see checkEntityCountInMempool's own comment for why `senderInfo` alone
   * being undefined (the Self Relay shape) must not skip it entirely: that
   * shape's sender is still gated, just through the `payerInfo`/"payer"
   * bucket instead.
   */
  private async checkAdmission(
    entry: MempoolEntry,
    senderInfo?: StakeInfo,
    factoryInfo?: StakeInfo,
    payerInfo?: StakeInfo
  ): Promise<void> {
    if (senderInfo || factoryInfo || payerInfo) {
      await this.reputationCheck.checkEntityCountInMempool(
        entry,
        senderInfo,
        factoryInfo,
        payerInfo
      );
    }
    await this.reputationCheck.checkMultipleRolesViolation(entry);
  }

  async getPendingFrameTxsByPayer(payer: string): Promise<MempoolEntry[]> {
    return (await this.fetchAll()).filter(
      (entry) =>
        entry.status < MempoolEntryStatus.OnChain &&
        entry.payer.toLowerCase() === payer.toLowerCase()
    );
  }

  async deleteOldUserOps(): Promise<void> {
    const removableEntries = (await this.fetchAll()).filter((entry) => {
      if (entry.status < MempoolEntryStatus.OnChain) return false;
      if (
        entry.lastUpdatedTime + this.networkConfig.archiveDuration * 1000 >
        now()
      ) {
        return false;
      }
      return true;
    });
    for (const entry of removableEntries) {
      await this.remove(entry);
    }
  }

  /**
   * Internal
   */

  private getKey(entry: Pick<IFrameTxMempoolEntry, "tx" | "chainId">): string {
    const { tx, chainId } = entry;
    return frameTxSlotKey(chainId, tx);
  }

  private async fetchAll(): Promise<MempoolEntry[]> {
    const keys = await this.fetchKeys();
    const rawEntries = await this.db
      .getMany<IFrameTxMempoolEntry>(keys)
      .catch(() => []);
    return rawEntries.map(rawEntryToMempoolEntry);
  }

  private async fetchKeys(): Promise<string[]> {
    const frameTxKeys = await this.db
      .get<string[]>(this.FRAMETX_COLLECTION_KEY)
      .catch(() => []);
    return frameTxKeys;
  }

  private async findByKey(key: string): Promise<MempoolEntry | null> {
    const raw = await this.db.get<IFrameTxMempoolEntry>(key).catch(() => null);
    if (raw) {
      return rawEntryToMempoolEntry(raw);
    }
    return null;
  }

  /**
   * EIP-8250: each `(sender, nonce_key)` is held by at most one pending
   * transaction. A keyed tx sharing any key with a pending tx of a different
   * slot (another key set, or the same set at another `nonceSeq`) is
   * rejected: at most one of them could ever be included. Disjoint key sets
   * coexist freely - they cannot block or invalidate each other at the nonce
   * level. The same slot is not a conflict but a replacement, handled by
   * `validateReplaceability`. Linear (`[0]`) txs keep their sequential
   * per-nonce slots and never conflict with keyed ones.
   */
  private async checkNonceKeyConflict(entry: MempoolEntry): Promise<void> {
    if (!isKeyedNonce(entry.tx)) return;
    const slot = this.getKey(entry);
    const sender = entry.tx.sender.toLowerCase();
    const keys = new Set(entry.tx.nonceKeys);
    for (const pending of await this.fetchPendingUserOps()) {
      if (
        pending.tx.sender.toLowerCase() !== sender ||
        !isKeyedNonce(pending.tx) ||
        this.getKey(pending) === slot
      ) {
        continue;
      }
      const shared = pending.tx.nonceKeys.find((k) => keys.has(k));
      if (shared !== undefined) {
        throw new RpcError(
          `Frame transaction nonce key ${toHex(
            shared
          )} is already held by pending transaction ${pending.txHash}`,
          RpcErrorCodes.INVALID_USEROP
        );
      }
    }
  }

  /**
   * Pending frame transactions never owe an account more than its balance:
   * the sum of `frameTxObligations` (payer: max gas cost; sender: top-level
   * frame value) over every pending entry plus this one must fit in each
   * account this one draws on. An entry it would replace (same slot) no
   * longer counts. Balance changes from outside this mempool are caught per
   * block by `enforceBalances`.
   */
  private async checkBalanceObligations(
    entry: MempoolEntry,
    replaced: MempoolEntry | null
  ): Promise<void> {
    if (!this.getBalance) return;
    const replacedKey = replaced ? this.getKey(replaced) : undefined;
    const others = (await this.fetchPendingUserOps()).filter(
      (pending) => this.getKey(pending) !== replacedKey
    );
    const totals = totalObligations(others);
    for (const [address, amount] of frameTxObligations(entry)) {
      const owed = (totals.get(address) ?? BigInt(0)) + amount;
      const balance = await this.getBalance(address as `0x${string}`);
      if (owed > balance) {
        throw new RpcError(
          `${address} cannot cover its pending frame transactions: they would owe ${owed} wei (${amount} for this one), its balance is ${balance} wei`,
          RpcErrorCodes.INVALID_USEROP
        );
      }
    }
  }

  /**
   * Per-block counterpart of `checkBalanceObligations`: a balance can fall
   * through transactions this mempool never saw. For every account whose
   * pending obligations exceed its current balance, cancels its `New`
   * entries newest first until the rest fit. `Submitted` entries count but
   * are left alone - they are already with the execution client. Returns
   * the cancelled entries.
   */
  async enforceBalances(blockNumber: bigint): Promise<MempoolEntry[]> {
    if (!this.getBalance) return [];
    const pending = await this.fetchPendingUserOps();
    const totals = totalObligations(pending);
    const cancelled = new Set<MempoolEntry>();
    for (const [address, total] of totals) {
      const balance = await this.getBalance(address as `0x${string}`);
      let owed = total;
      if (owed <= balance) continue;
      const evictable = pending
        .filter(
          (entry) =>
            entry.status === MempoolEntryStatus.New &&
            !cancelled.has(entry) &&
            frameTxObligations(entry).has(address)
        )
        .sort(
          (a, b) =>
            (b.submittedTime ?? b.lastUpdatedTime) -
            (a.submittedTime ?? a.lastUpdatedTime)
        );
      for (const entry of evictable) {
        if (owed <= balance) break;
        owed -= frameTxObligations(entry).get(address)!;
        cancelled.add(entry);
        await this.updateStatus([entry], MempoolEntryStatus.Cancelled, {
          revertReason: `${address} can no longer cover its pending frame transactions as of block ${blockNumber}: balance ${balance} wei`,
        });
      }
    }
    return [...cancelled];
  }

  private async validateReplaceability(
    newEntry: MempoolEntry,
    oldEntry?: MempoolEntry | null
  ): Promise<boolean> {
    if (!oldEntry) {
      oldEntry = await this.find(newEntry);
    }
    // The very same transaction is not a replacement, whatever its fee or
    // the TTL says: it is a duplicate (usually gossip echoing back what this
    // node already holds). Only while the entry is live: one that is
    // Finalized, Cancelled or Reverted no longer holds its slot (see
    // `canReplace`), so submitting the same transaction again is allowed.
    if (
      oldEntry &&
      oldEntry.status <= MempoolEntryStatus.OnChain &&
      newEntry.txHash !== undefined &&
      newEntry.txHash === oldEntry.txHash
    ) {
      throw new RpcError(
        "Frame transaction already known",
        RpcErrorCodes.INVALID_USEROP
      );
    }
    if (
      !oldEntry ||
      newEntry.canReplaceWithTTL(oldEntry, this.networkConfig.useropsTTL)
    ) {
      return true;
    }
    throw new RpcError(
      "Frame transaction cannot be replaced: fee too low",
      RpcErrorCodes.INVALID_USEROP
    );
  }

  private async update(entry: MempoolEntry): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.db.put(this.getKey(entry), entry);
    });
  }

  private async remove(entry: MempoolEntry | null): Promise<void> {
    if (!entry) {
      return;
    }
    await this.mutex.runExclusive(async () => {
      const key = this.getKey(entry);
      const newKeys = (await this.fetchKeys()).filter((k) => k !== key);
      await this.db.del(key);
      await this.db.put(this.FRAMETX_COLLECTION_KEY, newKeys);
      this.logger.debug(`${entry.txHash} deleted from mempool`);
    });
  }

  private async saveFrameTxHash(
    hash: string,
    entry: MempoolEntry
  ): Promise<void> {
    const key = this.getKey(entry);
    await this.db.put(`${this.FRAMETX_HASHES_COLLECTION_PREFIX}${hash}`, key);
  }

  private async removeFrameTxHash(hash: string): Promise<void> {
    await this.db.del(`${this.FRAMETX_HASHES_COLLECTION_PREFIX}${hash}`);
  }

  /**
   * Entries no longer actively tracked (cancelled, or replaced-away) but
   * still worth checking for late on-chain inclusion by a different block
   * builder - see the explorer-activity-outcomes design spec. Same
   * array-of-keys collection pattern as the active store
   * (`FRAMETX_COLLECTION_KEY`) - `IDbController` has no native prefix scan.
   */
  async fetchWatchedEntries(): Promise<MempoolEntry[]> {
    const hashes = await this.fetchWatchlistHashes();
    const rawEntries = await this.db
      .getMany<IFrameTxMempoolEntry>(hashes.map((h) => `${this.WATCHLIST_PREFIX}${h}`))
      .catch(() => []);
    return rawEntries.map(rawEntryToMempoolEntry);
  }

  /**
   * A watch-list entry turned out to be included after all - by a different
   * block builder than the one this bundler itself submits to, since this
   * bundler already gave up on it (that's how it ended up on the watch list).
   * Removes it from the watch list, sets the landed status/includer on the
   * entry, and emits the same `onChainUserOps` event the live-inclusion path
   * emits (`updateStatus`), so `ExplorerService.attach`'s single listener
   * handles both paths identically - no separate wiring needed downstream.
   *
   * Also updates the active store's own copy of this entry, but ONLY when
   * its `sender:nonce` slot still holds this exact hash - i.e. it was
   * cancelled (still sitting in its own slot), not replaced-away (whose
   * slot now holds a different, newer entry). This keeps
   * `skandha_frameTransactionStatus`/`TxScreen` in agreement with the
   * explorer's "included" outcome instead of still showing `Cancelled`,
   * without ever touching a slot this entry no longer owns.
   */
  async resolveWatchedEntry(
    entry: MempoolEntry,
    status: MempoolEntryStatus.OnChain | MempoolEntryStatus.Reverted,
    params?: { includer?: `0x${string}`; revertReason?: string }
  ): Promise<void> {
    if (!entry.txHash) return;
    await this.mutex.runExclusive(async () => {
      await this.removeFromWatchlistUnlocked(entry.txHash!);
    });
    entry.setStatus(status, { transaction: entry.txHash, ...params });
    const active = await this.find(entry);
    if (active && active.txHash === entry.txHash) {
      await this.update(entry);
    }
    this.eventBus.emit(ExecutorEvent.onChainUserOps, entry);
  }

  async deleteOldWatchedEntries(): Promise<void> {
    const removable = (await this.fetchWatchedEntries()).filter(
      (entry) =>
        entry.lastUpdatedTime + this.networkConfig.archiveDuration * 1000 <= now()
    );
    await this.mutex.runExclusive(async () => {
      for (const entry of removable) {
        if (entry.txHash) await this.removeFromWatchlistUnlocked(entry.txHash);
      }
    });
  }

  /** Caller must already hold `this.mutex` - see `addFrameTx`'s replace branch for why a second, unlocked variant exists alongside `watchForLateInclusion`. */
  private async watchForLateInclusionUnlocked(entry: MempoolEntry): Promise<void> {
    if (!entry.txHash) return;
    const hashes = await this.fetchWatchlistHashes();
    if (hashes.includes(entry.txHash)) return; // already watched - don't duplicate
    await this.db.put(`${this.WATCHLIST_PREFIX}${entry.txHash}`, entry);
    await this.db.put(this.WATCHLIST_COLLECTION_KEY, [...hashes, entry.txHash]);
  }

  private async watchForLateInclusion(entry: MempoolEntry): Promise<void> {
    await this.mutex.runExclusive(async () => {
      await this.watchForLateInclusionUnlocked(entry);
    });
  }

  private async fetchWatchlistHashes(): Promise<string[]> {
    return this.db.get<string[]>(this.WATCHLIST_COLLECTION_KEY).catch(() => []);
  }

  /** Caller must already hold `this.mutex`. */
  private async removeFromWatchlistUnlocked(txHash: string): Promise<void> {
    await this.db.del(`${this.WATCHLIST_PREFIX}${txHash}`);
    const hashes = (await this.fetchWatchlistHashes()).filter((h) => h !== txHash);
    await this.db.put(this.WATCHLIST_COLLECTION_KEY, hashes);
  }
}
