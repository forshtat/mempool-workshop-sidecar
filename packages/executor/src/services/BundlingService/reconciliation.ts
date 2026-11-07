import { Hex, PublicClient, toHex } from "viem";
import { Logger } from "@skandha/types/lib/index.js";
import { PerChainMetrics } from "@skandha/monitoring/lib/index.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import RpcError from "@skandha/types/lib/api/errors/rpc-error.js";
import { recentRootWindowViolation } from "@skandha/types/lib/contracts/FrameTx.js";
import { NetworkConfig } from "../../interfaces.js";
import { FrameTxMempoolEntry } from "../../entities/FrameTxMempoolEntry.js";
import { now } from "../../utils/index.js";
import { MempoolService } from "../MempoolService/index.js";
import { frameTxSlotKey } from "../MempoolService/utils.js";
import { getHeadSlot } from "../../utils/headSlot.js";
import { ReceiptService } from "../ReceiptService/index.js";
import { FrameTxSimulationService } from "../FrameTxSimulationService/index.js";
import { FrameTxReceipt } from "@skandha/types/lib/executor/validation/frameTxReceipt.js";
import {
  AccountAccess,
  BlockChanges,
  SlotReads,
  collectChanges,
  isAffected,
} from "./blockChanges.js";

/**
 * Runs once per newly observed block, driven from `BundlingService`'s
 * existing cron (see `tryBundle`) rather than a new subscription. Owns two
 * responsibilities that both only make sense to check against a specific,
 * newly mined block:
 *
 * 1. Inclusion detection for `Submitted` entries. This did not exist before
 *    and its absence was a real bug, not just a gap: nothing anywhere ever
 *    called `updateStatus(entry, OnChain, ...)`, so `BaseRelayer`'s old
 *    `waitForEntry` (which polled for exactly that status) always ran out
 *    its retry budget and marked the entry `Reverted` with a made-up
 *    "execution reverted" reason - including for transactions that were
 *    genuinely included. See `reconcileSubmitted`.
 * 2. Revalidation for `New` entries against newly mined state - entries
 *    admitted when compliant can stop being compliant as other transactions
 *    land (a staked entity un-stakes, an account's code changes, etc.).
 *    ERC-4337's on-chain-event-driven `EventsService` did the analogous job
 *    and was removed with no replacement when this codebase moved off
 *    ERC-4337; this class is that replacement. See `reconcileNew`.
 *
 * Deliberately its own class rather than folded into `MempoolService`
 * (a pure storage/query layer with no `ReceiptService`/
 * `FrameTxSimulationService` dependency today) or `BundlingService` (already
 * owns dispatch/back-pressure/fee-gating). Keeping this separate leaves both
 * of those untouched in shape and gives the block-driven logic - and its
 * future optimization, below - one obvious home.
 */
/** Most `New` entries whose receipt is looked up in one reconciliation pass. */
const MAX_INCLUSION_LOOKUPS_PER_PASS = 50;

/** Most blocks whose access lists one pass reads; past this it revalidates every entry. */
const MAX_ACCESS_LISTS_PER_PASS = BigInt(8);

/** Most `New` entries revalidated in one pass; the rest stay due for the next passes. */
const MAX_REVALIDATIONS_PER_PASS = 50;

export class MempoolReconciler {
  private lastReconciledBlock = BigInt(-1);

  private chainId: bigint | undefined;

  /**
   * Rotating start index into the watch list's own stable (txHash-sorted)
   * order, so each pass's `MAX_INCLUSION_LOOKUPS_PER_PASS` cap covers a
   * different slice rather than the same oldest entries every time - see
   * `reconcileWatchList`'s own doc comment for why a fixed oldest-first
   * order would starve entries beyond the cap. In-memory only: a restart
   * just resets to the front, which costs fairness across that one restart,
   * not correctness (an entry an earlier pass never reached is still on the
   * watch list and gets checked once the cursor reaches it).
   */
  private watchListCursor = 0;

  /**
   * Per-entry aggregated storage-slot access (`FrameTxValidationResult.
   * accessedSlots`), cached in memory only - keyed by the same slot key
   * `MempoolService` derives its DB key from (`frameTxSlotKey`), with the
   * hash of the transaction that read them: a replacement shares the key, not
   * the reads. NOT persisted: an entry without reads for its current hash is
   * simply revalidated, which records them again.
   *
   * `selectCandidatesForRevalidation` intersects it with the EIP-7928 block
   * access lists (`eth_getBlockAccessList`) of the blocks since the last
   * narrowing, so only entries whose recorded reads overlap what those blocks
   * wrote are revalidated.
   */
  private accessedSlotsCache = new Map<
    string,
    { txHash?: string; reads: SlotReads }
  >();

  /**
   * The block (and its hash) up to which block changes were last turned into
   * due entries. Separate from `lastReconciledBlock`, which advances before a
   * pass runs: a pass that throws earlier leaves this behind, so the next
   * pass reads every block since, and a hash that is no longer the parent of
   * the next block (a reorg) makes the next pass revalidate every entry.
   */
  private lastNarrowedBlock = BigInt(-1);

  private lastNarrowedHash: Hex | undefined;

  private passRunning = false;

  /**
   * Keys of `New` entries that block changes can have invalidated and that
   * have not been revalidated since, in the order they became due. A key
   * leaves only once its entry has been revalidated (or it leaves the pool),
   * so neither MAX_REVALIDATIONS_PER_PASS nor a pass that throws part-way can
   * make a later block that touches nothing the entry read skip it.
   */
  private dueForRevalidation = new Set<string>();

  constructor(
    private mempoolService: MempoolService,
    private receiptService: ReceiptService,
    private frameTxSimulationService: FrameTxSimulationService,
    private publicClient: PublicClient,
    private networkConfig: NetworkConfig,
    private metrics: PerChainMetrics | null,
    private logger: Logger
  ) {}

  /**
   * One pass at a time: the cron fires on an interval whether or not the last
   * pass finished, and two passes sharing `dueForRevalidation` could drop an
   * entry's due flag. A skipped tick loses nothing, since the next pass reads
   * every block since the last narrowing.
   */
  async reconcile(): Promise<void> {
    if (this.passRunning) return;
    this.passRunning = true;
    try {
      await this.reconcileOnce();
    } finally {
      this.passRunning = false;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const blockNumber = await this.publicClient.getBlockNumber();
    if (blockNumber <= this.lastReconciledBlock) {
      return;
    }
    this.lastReconciledBlock = blockNumber;

    const pending = await this.mempoolService.fetchPendingUserOps();
    const submitted = pending.filter(
      (entry) => entry.status === MempoolEntryStatus.Submitted
    );
    const newEntries = pending.filter(
      (entry) => entry.status === MempoolEntryStatus.New
    );

    await this.reconcileSubmitted(submitted);
    const notOnChain = await this.reconcileMinedElsewhere(newEntries);
    const rootsUsable = await this.reconcileRecentRoots(notOnChain);
    await this.reconcileNew(
      await this.selectCandidatesForRevalidation(rootsUsable, newEntries)
    );
    await this.mempoolService.enforceBalances(blockNumber);
    await this.reconcileWatchList();
  }

  /**
   * A `New` entry this node never relayed can still have been mined: a peer
   * relayed it (the usual case for a gateway that only gossips), or an earlier
   * submission landed after the entry was requeued. Nothing else would ever
   * notice, and the entry would sit `New` forever. Looks each one up by its
   * transaction hash (which is also its on-chain hash) and moves the ones that
   * landed to `OnChain`/`Reverted`.
   *
   * Bounded: at most MAX_INCLUSION_LOOKUPS_PER_PASS entries, oldest first
   * (the ones most likely to have been mined), so a large pool cannot turn
   * every block into hundreds of RPC calls. Returns the entries that should
   * still be revalidated: everything not found on chain, plus the ones beyond
   * the cap. An entry whose lookup failed for a transport reason is left out
   * of this pass entirely: not knowing is no reason to revalidate, and
   * revalidating through the same unhealthy RPC could cancel it.
   */
  private async reconcileMinedElsewhere(
    entries: FrameTxMempoolEntry[]
  ): Promise<FrameTxMempoolEntry[]> {
    const oldestFirst = [...entries].sort(
      (a, b) =>
        (a.submittedTime ?? a.lastUpdatedTime) -
        (b.submittedTime ?? b.lastUpdatedTime)
    );
    const checked = oldestFirst.slice(0, MAX_INCLUSION_LOOKUPS_PER_PASS);
    const skipped = new Set<FrameTxMempoolEntry>();
    const landed = new Set<FrameTxMempoolEntry>();
    for (const entry of checked) {
      if (!entry.txHash) continue;
      try {
        const receipt = await this.receiptService.getReceipt(
          entry.txHash as Hex
        );
        landed.add(entry);
        if (receipt.status === "success") {
          await this.mempoolService.updateStatus(
            [entry],
            MempoolEntryStatus.OnChain,
            {
              transaction: entry.txHash,
              includer: await this.includerOf(receipt.blockNumber),
            }
          );
        } else {
          await this.mempoolService.updateStatus(
            [entry],
            MempoolEntryStatus.Reverted,
            {
              revertReason: this.describeRevert(receipt),
              includer: await this.includerOf(receipt.blockNumber),
            }
          );
        }
      } catch (err) {
        if (err instanceof RpcError) continue; // no receipt: not mined
        this.logger.error(
          err,
          `Could not check receipt for ${entry.txHash}; leaving it for the next pass`
        );
        skipped.add(entry);
      }
    }
    return entries.filter((e) => !landed.has(e) && !skipped.has(e));
  }

  /**
   * Checks entries this bundler gave up on (cancelled, or replaced away) for
   * late on-chain inclusion by a different block builder - see the
   * explorer-activity-outcomes design spec. Bounded and
   * skip-on-transport-error like `reconcileMinedElsewhere`, but round-robins
   * across passes (see `watchListCursor`'s doc comment) rather than always
   * taking the same oldest-first slice: once the list exceeds
   * `MAX_INCLUSION_LOOKUPS_PER_PASS`, a fixed oldest-first order would let
   * the same entries occupy every pass's budget forever, starving newer
   * ones - which are just as likely, if not more likely, to have landed -
   * until they age out via `MempoolService`'s own `archiveDuration` GC (up
   * to 24h by default). Unlike `reconcileMinedElsewhere` there is no "still
   * revalidate" return value - an entry not found on chain this pass simply
   * stays on the watch list for a later pass to reach.
   */
  private async reconcileWatchList(): Promise<void> {
    const watched = await this.mempoolService.fetchWatchedEntries();
    if (watched.length === 0) return;
    // Sorted by txHash for a stable order across passes (lastUpdatedTime
    // isn't stable here - resolveWatchedEntry doesn't bump it, but nothing
    // else guarantees it never changes either); the cursor then rotates
    // which slice of that stable order this pass covers.
    const sorted = [...watched].sort((a, b) =>
      (a.txHash ?? "").localeCompare(b.txHash ?? "")
    );
    const start = this.watchListCursor % sorted.length;
    const checked = sorted
      .slice(start)
      .concat(sorted.slice(0, start))
      .slice(0, MAX_INCLUSION_LOOKUPS_PER_PASS);
    this.watchListCursor = (start + checked.length) % sorted.length;
    for (const entry of checked) {
      if (!entry.txHash) continue;
      try {
        const receipt = await this.receiptService.getReceipt(entry.txHash as Hex);
        const includer = await this.includerOf(receipt.blockNumber);
        const landed =
          receipt.status === "success"
            ? MempoolEntryStatus.OnChain
            : MempoolEntryStatus.Reverted;
        await this.mempoolService.resolveWatchedEntry(entry, landed, {
          includer,
          revertReason:
            landed === MempoolEntryStatus.Reverted
              ? this.describeRevert(receipt)
              : undefined,
        });
      } catch (err) {
        if (err instanceof RpcError) continue; // no receipt: still not included
        this.logger.error(
          err,
          `Could not check receipt for watched entry ${entry.txHash}; leaving it for the next pass`
        );
      }
    }
  }

  /**
   * For each `Submitted` entry, checks whether it actually landed - and, if
   * so, whether it actually succeeded. This distinction is pure
   * observability: it does not feed back into any bundling, reputation, or
   * requeue decision (a reverted-but-included transaction is exactly as
   * "done" as a successful one from this bundler's own perspective - it
   * landed, so there is nothing left to retry). It exists so
   * `skandha_frameTransactionStatus`/`eth_getFrameTransactionByHash`/the
   * `submittedUserOps` WS event can show a real answer instead of always
   * reporting `OnChain` regardless of outcome - genuinely useful for
   * debugging and demos, not for this bundler's own logic.
   *
   * The privileged ethrex endpoint's own contract (see `PrivilegedRelayer`'s
   * doc comment) is one-shot: a submission is tried against only the very
   * next payload build and never retried. So "no receipt yet" here doesn't
   * mean "still pending, keep waiting" the way it would for a normal
   * mempool transaction - it means this specific submission attempt is
   * already gone for good. The only sensible response is to requeue to
   * `New` for a fresh submission attempt, not to keep polling.
   *
   * A transport/network failure while checking is NOT treated the same as
   * "confirmed no receipt": we don't know the outcome, so the entry is left
   * `Submitted` for the next reconciliation pass to check again, rather than
   * guessing.
   */
  private async reconcileSubmitted(entries: FrameTxMempoolEntry[]): Promise<void> {
    for (const entry of entries) {
      if (!entry.transaction) {
        this.logger.error(
          `Submitted entry ${entry.txHash} has no transaction hash to check`
        );
        continue;
      }

      let receipt: FrameTxReceipt | null;
      try {
        receipt = await this.receiptService.getReceipt(entry.transaction as Hex);
      } catch (err) {
        if (err instanceof RpcError) {
          // Confirmed: no receipt for this hash (or, in theory, one
          // belonging to a non-frame transaction - should never happen for
          // our own submissions). Either way, not included.
          receipt = null;
        } else {
          this.logger.error(
            err,
            `Could not check receipt for ${entry.txHash}; leaving it Submitted`
          );
          continue;
        }
      }

      if (receipt) {
        const landed =
          receipt.status === "success"
            ? MempoolEntryStatus.OnChain
            : MempoolEntryStatus.Reverted;
        const includer = await this.includerOf(receipt.blockNumber);
        await this.mempoolService.updateStatus(
          [entry],
          landed,
          landed === MempoolEntryStatus.OnChain
            ? { transaction: entry.transaction, includer }
            : { revertReason: this.describeRevert(receipt), includer }
        );
        if (this.metrics) {
          // Fires on either outcome: submission-and-inclusion genuinely
          // succeeded either way, it's only execution that differs.
          // `useropsInBundle` is deliberately not observed: it would record
          // a constant 1 now that transactions are relayed individually.
          this.metrics.bundlesSubmitted.inc(1);
          this.metrics.useropsSubmitted.inc(1);
          this.metrics.useropsTimeToProcess.observe(
            Math.ceil(
              (now() - (entry.submittedTime ?? entry.lastUpdatedTime)) / 1000
            )
          );
        }
      } else {
        await this.mempoolService.updateStatus([entry], MempoolEntryStatus.New);
        if (this.metrics) {
          this.metrics.bundlesFailed.inc(1);
        }
      }
    }
  }

  /**
   * A human-readable reason for a landed-but-reverted transaction. There is
   * no textual revert message anywhere on this receipt shape (no
   * `output`/`returnData`/`reason` field - `EthrexFrameTxReceipt` doesn't
   * carry one), so this names which frame(s) did not report `"success"`
   * instead - more useful for debugging than a bare "reverted".
   */
  private describeRevert(receipt: FrameTxReceipt): string {
    const notSucceeded = receipt.frameReceipts
      .map((frame, index) => ({ index, status: frame.status }))
      .filter(({ status }) => status !== "success");
    if (notSucceeded.length === 0) {
      // Defensive: the whole-tx status reported failure but every frame
      // reported success. Shouldn't happen per ethrex's model, but this is
      // observability, not a decision - report what's actually known rather
      // than asserting a specific frame is at fault.
      return "transaction reverted (no individual frame reported non-success)";
    }
    return `frame(s) ${notSucceeded
      .map(({ index, status }) => `${index} (${status})`)
      .join(", ")} did not succeed`;
  }

  /**
   * The including block's `miner`, for a receipt that's confirmed to exist.
   * A failed lookup is non-fatal - it's pure observability, so it must never
   * block the status transition itself (the same tolerance-for-partial-RPC-
   * failure style as `getChainId`).
   */
  private async includerOf(blockNumber: bigint): Promise<`0x${string}` | undefined> {
    try {
      const block = await this.publicClient.getBlock({ blockNumber });
      return block.miner;
    } catch (err) {
      this.logger.error(err, `Could not fetch includer for block ${blockNumber}`);
      return undefined;
    }
  }

  /**
   * This node's chain id, read once. A failed read is not cached and not
   * fatal: the chain id check is skipped for this pass rather than cancelling
   * entries because an RPC call hiccuped.
   */
  private async getChainId(): Promise<bigint | undefined> {
    if (this.chainId === undefined) {
      try {
        this.chainId = BigInt(await this.publicClient.getChainId());
      } catch (err) {
        this.logger.error(err, "Could not read the chain id; skipping the chain id check");
      }
    }
    return this.chainId;
  }

  /**
   * Re-validates every candidate `New` entry and cancels the ones that are
   * no longer ERC-7562-compliant. Also refreshes each surviving entry's
   * cached `accessedSlots` (see the field's own doc comment).
   */
  /**
   * EIP-8272: cancels `New` entries holding a recent-root reference that has
   * left the usable slot window - by slot arithmetic alone, without the
   * simulation `reconcileNew` would otherwise spend to learn the same thing.
   * Returns the rest. Skipped (everything returned) when the head slot
   * cannot be read; revalidation then catches expiry as before.
   */
  private async reconcileRecentRoots(
    entries: FrameTxMempoolEntry[]
  ): Promise<FrameTxMempoolEntry[]> {
    if (!entries.some((entry) => entry.tx.recentRootReferences.length > 0)) {
      return entries;
    }
    const headSlot = await getHeadSlot(this.publicClient).catch(
      () => undefined
    );
    if (headSlot === undefined) return entries;
    const usable: FrameTxMempoolEntry[] = [];
    for (const entry of entries) {
      const violation = recentRootWindowViolation(
        entry.tx.recentRootReferences,
        headSlot
      );
      if (violation === null) {
        usable.push(entry);
        continue;
      }
      await this.mempoolService.updateStatus(
        [entry],
        MempoolEntryStatus.Cancelled,
        {
          revertReason: `${violation}, as of block ${this.lastReconciledBlock}`,
        }
      );
    }
    return usable;
  }

  private async reconcileNew(entries: FrameTxMempoolEntry[]): Promise<void> {
    const chainId = await this.getChainId();
    for (const entry of entries) {
      await this.revalidate(entry, chainId);
      this.dueForRevalidation.delete(this.entryKey(entry));
    }
  }

  private async revalidate(
    entry: FrameTxMempoolEntry,
    chainId: bigint | undefined
  ): Promise<void> {
    if (chainId !== undefined && entry.tx.chainId !== chainId) {
      await this.mempoolService.updateStatus(
        [entry],
        MempoolEntryStatus.Cancelled,
        {
          revertReason: `frame transaction chain id ${entry.tx.chainId} does not match this node's chain id ${chainId}`,
        }
      );
      return;
    }
    try {
      const { validation } = await this.frameTxSimulationService.simulate(
        entry.tx
      );
      const mempoolId = this.networkConfig.standardMempoolId;
      if (!validation.mempoolMembership[mempoolId]) {
        await this.mempoolService.updateStatus(
          [entry],
          MempoolEntryStatus.Cancelled,
          {
            revertReason: `no longer compliant with mempool ${mempoolId} as of block ${this.lastReconciledBlock}`,
          }
        );
        return;
      }
      this.accessedSlotsCache.set(this.entryKey(entry), {
        txHash: entry.txHash,
        reads: validation.accessedSlots,
      });
    } catch (err) {
      await this.mempoolService.updateStatus(
        [entry],
        MempoolEntryStatus.Cancelled,
        {
          revertReason: `revalidation failed as of block ${
            this.lastReconciledBlock
          }: ${(err as Error).message}`,
        }
      );
    }
  }

  /**
   * Which `New` entries to revalidate this pass. Revalidating every entry
   * every block let one sender's pending entries cost the node a simulation
   * each, per block, whether or not anything they read had changed. Now an
   * entry becomes due when the blocks since the last narrowing can have
   * invalidated it (`affectedEntries`), and at most MAX_REVALIDATIONS_PER_PASS
   * due entries are revalidated per pass, longest due first; entries that
   * became due together queue by priority fee, then age. One revalidated
   * rejoins the back of the queue when it is due again, so an entry due every
   * pass cannot hold the budget: every due entry is revalidated within
   * ceil(due / MAX_REVALIDATIONS_PER_PASS) passes.
   *
   * Affected `pending` entries become due even when they are not
   * `candidates` this pass (a receipt lookup failed, say), so a pass that
   * skips one does not lose the changes it read past.
   */
  private async selectCandidatesForRevalidation(
    candidates: FrameTxMempoolEntry[],
    pending: FrameTxMempoolEntry[]
  ): Promise<FrameTxMempoolEntry[]> {
    const live = new Set(pending.map((entry) => this.entryKey(entry)));
    for (const key of this.accessedSlotsCache.keys()) {
      if (!live.has(key)) this.accessedSlotsCache.delete(key);
    }
    for (const key of this.dueForRevalidation) {
      if (!live.has(key)) this.dueForRevalidation.delete(key);
    }
    const byKey = new Map(
      candidates.map((entry) => [this.entryKey(entry), entry])
    );
    const head = await this.header(this.lastReconciledBlock);
    const affected = await this.affectedEntries(pending, head);
    for (const entry of [...affected].sort(byPriorityFeeThenAge)) {
      this.dueForRevalidation.add(this.entryKey(entry));
    }
    this.lastNarrowedBlock = this.lastReconciledBlock;
    this.lastNarrowedHash = head?.hash;

    const picked: FrameTxMempoolEntry[] = [];
    for (const key of this.dueForRevalidation) {
      if (picked.length === MAX_REVALIDATIONS_PER_PASS) break;
      const entry = byKey.get(key);
      if (entry) picked.push(entry);
    }
    const waiting = this.dueForRevalidation.size - picked.length;
    if (waiting > 0) {
      this.logger.debug(
        `Revalidating ${picked.length} entries; ${waiting} stay due`
      );
    }
    return picked;
  }

  /**
   * The entries the blocks since the last narrowing can have invalidated (see
   * `isAffected`), plus those with no recorded reads for their current
   * transaction. All of them when those blocks' changes are unknown (see
   * `changesSinceLastNarrowing`), or when they touched the staking registry:
   * validation reads stake through a separate call, outside the trace that
   * records reads. Also those whose max fee is below the head's base fee,
   * which revalidation cancels, as the full sweep did.
   */
  private async affectedEntries(
    entries: FrameTxMempoolEntry[],
    head: BlockHeader | undefined
  ): Promise<FrameTxMempoolEntry[]> {
    const changes = await this.changesSinceLastNarrowing(head);
    if (!changes || this.touchesStakingRegistry(changes)) return entries;
    const baseFee = head?.baseFeePerGas;
    try {
      return entries.filter(
        (entry) =>
          (baseFee !== undefined && entry.tx.fees.maxFeePerGas < baseFee) ||
          isAffected(entry.tx, this.cachedReads(entry), changes)
      );
    } catch (err) {
      this.logger.error(
        err,
        "Could not match block access lists; revalidating every entry"
      );
      return entries;
    }
  }

  private cachedReads(entry: FrameTxMempoolEntry): SlotReads | undefined {
    const cached = this.accessedSlotsCache.get(this.entryKey(entry));
    return cached !== undefined && cached.txHash === entry.txHash
      ? cached.reads
      : undefined;
  }

  private touchesStakingRegistry(changes: BlockChanges): boolean {
    const registry = this.networkConfig.stakingRegistryAddress?.toLowerCase();
    if (registry === undefined || BigInt(registry) === BigInt(0)) return false;
    return changes.accounts.has(registry) || changes.written.has(registry);
  }

  /**
   * What the blocks after the last narrowed block, up to this pass's block,
   * changed. `undefined` (unknown) on the first pass, after more than
   * MAX_ACCESS_LISTS_PER_PASS blocks, when the chain no longer extends the
   * last narrowed block (a reorg), or when a header or access list cannot be
   * read.
   */
  private async changesSinceLastNarrowing(
    head: BlockHeader | undefined
  ): Promise<BlockChanges | undefined> {
    const from = this.lastNarrowedBlock;
    const last = this.lastReconciledBlock;
    if (
      from < BigInt(0) ||
      last - from > MAX_ACCESS_LISTS_PER_PASS ||
      this.lastNarrowedHash === undefined
    ) {
      return undefined;
    }
    const next =
      last === from + BigInt(1) ? head : await this.header(from + BigInt(1));
    if (next?.parentHash !== this.lastNarrowedHash) return undefined;
    const lists: AccountAccess[][] = [];
    for (let block = from + BigInt(1); block <= last; block++) {
      const list = await this.publicClient
        .request({
          method: "eth_getBlockAccessList",
          params: [toHex(block)],
        } as never)
        .catch((err: unknown) => {
          this.logger.debug(
            err,
            `Could not read the access list of block ${block}; revalidating every entry`
          );
          return undefined;
        });
      if (!Array.isArray(list)) return undefined;
      lists.push(list as AccountAccess[]);
    }
    try {
      return collectChanges(lists);
    } catch (err) {
      this.logger.error(
        err,
        "Could not read block access lists; revalidating every entry"
      );
      return undefined;
    }
  }

  private async header(blockNumber: bigint): Promise<BlockHeader | undefined> {
    try {
      const block = await this.publicClient.getBlock({ blockNumber });
      return block.hash === null
        ? undefined
        : {
            hash: block.hash,
            parentHash: block.parentHash,
            baseFeePerGas: block.baseFeePerGas ?? undefined,
          };
    } catch {
      return undefined;
    }
  }

  private entryKey(entry: FrameTxMempoolEntry): string {
    return frameTxSlotKey(entry.chainId, entry.tx);
  }
}

type BlockHeader = { hash: Hex; parentHash: Hex; baseFeePerGas?: bigint };

function byPriorityFeeThenAge(
  a: FrameTxMempoolEntry,
  b: FrameTxMempoolEntry
): number {
  const feeA = a.tx.fees.maxPriorityFeePerGas;
  const feeB = b.tx.fees.maxPriorityFeePerGas;
  if (feeA !== feeB) return feeA > feeB ? -1 : 1;
  return (
    (a.submittedTime ?? a.lastUpdatedTime) -
    (b.submittedTime ?? b.lastUpdatedTime)
  );
}
