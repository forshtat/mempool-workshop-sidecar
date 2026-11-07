import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import { ReputationStatus } from "@skandha/types/lib/executor";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { getAddress } from "viem";
import { isKeyedNonce } from "@skandha/types/lib/contracts/FrameTx.js";
import { FrameTxMempoolEntry as MempoolEntry } from "../../entities/FrameTxMempoolEntry.js";
import { KnownEntities, NetworkConfig, StakeInfo } from "../../interfaces.js";
import { ReputationService } from "../ReputationService.js";
import { isWhitelistedAs } from "../../utils/whitelist.js";
import { MempoolService } from "./service.js";
import {
  MAX_MEMPOOL_USEROPS_PER_SENDER,
  MAX_PENDING_PER_UNSTAKED_SENDER,
  THROTTLED_ENTITY_MEMPOOL_COUNT,
} from "./constants.js";

// `updateIncludedStatus` (below) deliberately does NOT mirror `updateSeenStatus`'s
// stake-gated sender bump: since an unstaked sender's `opsSeen` never leaves 0,
// `ReputationEntry.isBanned`/`isThrottled`'s `floor(seen / denominator) > included + slack`
// reduces to `0 > included + slack`, which is never true regardless of `included` -
// bumping it unconditionally cannot change that entity's ban/throttle outcome.

// the three roles a `FrameTxMempoolEntry` can resolve, from its
// validation-prefix-derived `sender`/`factory`/`payer` fields. There is no
// `aggregator` concept under EIP-8141.
type EntityTitle = "sender" | "factory" | "payer";
const TITLES: EntityTitle[] = ["sender", "factory", "payer"];

export class MempoolReputationChecks {
  constructor(
    private service: MempoolService,
    private reputationService: ReputationService,
    private networkConfig: NetworkConfig
  ) {}

  /**
   * `senderInfo` is `undefined` for the Self Relay validation-prefix shape
   * (no dedicated "sender" frame - see `FrameTxMempoolEntry`'s class doc
   * comment), not because the caller skipped a lookup. That shape's
   * sender IS its own payer (`resolveRoleAddr`/`FrameTxMempoolEntry.
   * resolveRoles` both resolve `payer` to `tx.sender` when the payer
   * frame's target is null, which is always true for Self Relay), so its
   * count/ban/throttle gating still happens correctly - through the
   * `payerInfo`/"payer" bucket below, against
   * `calculateMaxAllowedMempoolOpsUnstaked` rather than the flat
   * `MAX_MEMPOOL_USEROPS_PER_SENDER` the dedicated "sender" bucket uses.
   * Different threshold formula, same entity, still genuinely gated - not
   * silently skipped the way it was before `senderInfo`/`factoryInfo`/
   * `payerInfo` were wired through from real validation.
   */
  async checkEntityCountInMempool(
    entry: MempoolEntry,
    senderInfo: StakeInfo | undefined,
    factoryInfo: StakeInfo | undefined,
    payerInfo: StakeInfo | undefined
  ): Promise<void> {
    const mEntries = await this.service.fetchPendingUserOps();
    const titles = TITLES;
    const count = [1, 1, 1]; // starting all values from one because `entry` param counts as well
    // What the per-entity cap is checked against: `count` minus every keyed
    // entry in which the entity is that entry's own sender (see `exempt`).
    const cappedCount = [1, 1, 1];
    const stakes = [senderInfo, factoryInfo, payerInfo];
    for (const mEntry of mEntries) {
      const mKeyed = isKeyedNonce(mEntry.tx);
      if (
        senderInfo &&
        getAddress(mEntry.sender) == getAddress(senderInfo.addr)
      ) {
        count[0]++;
        if (!mKeyed) cappedCount[0]++;
      }
      // counts the number of similar factories and payers in the mempool
      for (let i = 1; i < 3; ++i) {
        const mEntity = mEntry[titles[i] as keyof MempoolEntry] as
          | string
          | undefined;
        if (
          stakes[i] &&
          mEntity &&
          getAddress(mEntity) == getAddress(stakes[i]!.addr)
        ) {
          count[i]++;
          if (!(mKeyed && getAddress(mEntity) === getAddress(mEntry.sender))) {
            cappedCount[i]++;
          }
        }
      }
    }
    // EIP-8250: a sender's keyed txs on disjoint keys cannot block each other
    // at the nonce level, so they are not capped per sender - neither through
    // the "sender" bucket nor, for self-pay (Self Relay), through the
    // "payer"/"factory" bucket that is the sender itself. Linear txs keep the
    // cap, counted among linear txs only. A third-party payer/factory is
    // capped as before, keyed or not; ban/throttle status still applies.
    // Keyed txs still count toward the sender-wide cap
    // (`checkSenderPendingCap`).
    const exempt = (stake: StakeInfo): boolean =>
      isKeyedNonce(entry.tx) &&
      getAddress(stake.addr) === getAddress(entry.sender);

    // check for ban
    for (const [index, stake] of stakes.entries()) {
      if (!stake) continue;
      if (
        stake.addr &&
        isWhitelistedAs(this.networkConfig.whitelistedEntities, stake.addr, [
          titles[index]!,
        ])
      ) {
        continue;
      }
      const status = await this.reputationService.getStatus(stake.addr);
      if (status === ReputationStatus.BANNED) {
        throw new RpcError(
          `${titles[index]} ${stake.addr} is banned`,
          RpcErrorCodes.PAYMASTER_OR_AGGREGATOR_BANNED
        );
      }
      if (
        status === ReputationStatus.THROTTLED &&
        count[index] > THROTTLED_ENTITY_MEMPOOL_COUNT
      ) {
        throw new RpcError(
          `${titles[index]} ${stake.addr} is throttled`,
          RpcErrorCodes.PAYMASTER_OR_AGGREGATOR_BANNED
        );
      }
      const reputationEntry =
        index === 0 ? null : await this.reputationService.fetchOne(stake.addr);
      const maxMempoolCount =
        index === 0
          ? MAX_MEMPOOL_USEROPS_PER_SENDER
          : this.reputationService.calculateMaxAllowedMempoolOpsUnstaked(
              reputationEntry!
            );
      if (!exempt(stake) && cappedCount[index] > maxMempoolCount) {
        const checkStake = await this.reputationService.checkStake(stake);
        if (checkStake.code !== 0) {
          throw new RpcError(checkStake.msg, checkStake.code);
        }
      }
    }
    await this.checkSenderPendingCap(entry, mEntries, stakes);
  }

  /**
   * ERC-8421 LIFECYCLE-030: an unstaked sender may have at most
   * MAX_PENDING_PER_UNSTAKED_SENDER pending transactions, keyed or not; a
   * staked one has no sender-wide cap. `exempt` lifts only the small
   * per-sender cap for keyed txs, so without this a self-paying sender could
   * keep any number of keyed txs pending. The sender's stake is the
   * `StakeInfo` of whichever role resolved to its address (the payer, for
   * Self Relay); with none, it counts as unstaked. A sender whitelisted in
   * the config for a role it holds in this transaction (`account` as the
   * sender, `paymaster` when it pays for itself) is not capped, as validation
   * and the checks above waive that role; `checkStake` also passes the admin
   * whitelist.
   */
  private async checkSenderPendingCap(
    entry: MempoolEntry,
    pending: MempoolEntry[],
    stakes: (StakeInfo | undefined)[]
  ): Promise<void> {
    const sender = getAddress(entry.sender);
    const already = pending.filter(
      (m) => getAddress(m.sender) === sender
    ).length;
    if (already < MAX_PENDING_PER_UNSTAKED_SENDER) return;
    const held = stakes.map(
      (s) => s !== undefined && Boolean(s.addr) && getAddress(s.addr) === sender
    );
    const roles = TITLES.filter((_, i) => held[i]);
    const whitelisted = this.networkConfig.whitelistedEntities;
    if (isWhitelistedAs(whitelisted, sender, roles)) return;
    const stake = stakes[held.indexOf(true)] ?? {
      addr: entry.sender,
      stake: 0,
      unstakeDelaySec: 0,
      withdrawTime: 0,
    };
    const { code, msg } = await this.reputationService.checkStake(stake);
    if (code !== 0) {
      throw new RpcError(
        `sender ${entry.sender} has ${already} pending transactions; a sender that is not staked may have at most ${MAX_PENDING_PER_UNSTAKED_SENDER} (${msg})`,
        code
      );
    }
  }

  /**
   * Catches one entity acting as a plain "sender" in one mempool entry
   * while ALSO acting as a "payer"/"factory" for a DIFFERENT entity's entry
   * - the reputation-gaming vector this check exists for (payer/factory
   * reputation counts differently from a plain sender's).
   *
   * Self-pay is explicitly excluded from both directions of that
   * comparison: `payer === sender` within the SAME entry (every Self Relay
   * transaction - `FrameTxMempoolEntry`'s class doc comment) is the same
   * entity in the same entry, not a different entity double-dipping. Without
   * this exclusion, a self-relay sender's own SECOND pending entry (a
   * different nonce, same address) would collide with its first: `sender`
   * would already appear in `otherEntities` (pushed as the first entry's
   * `payer`, itself) and `payer` would already appear in `accounts` (pushed
   * as the first entry's `sender`) - rejecting completely ordinary usage
   * (a self-relay sender with more than one transaction pending at once).
   * `getKnownEntities()` carries the matching half of this exclusion, for
   * the `otherEntities` direction.
   */
  async checkMultipleRolesViolation(entry: MempoolEntry): Promise<void> {
    const { sender, payer, factory } = entry;
    const { otherEntities, accounts } = await this.getKnownEntities();
    if (otherEntities.includes(getAddress(sender))) {
      throw new RpcError(
        `The sender address "${sender}" is used as a different entity in another UserOperation currently in mempool`,
        RpcErrorCodes.INVALID_OPCODE
      );
    }

    if (payer && getAddress(payer) !== getAddress(sender)) {
      if (accounts.includes(getAddress(payer))) {
        throw new RpcError(
          `A Payer at ${payer} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
          RpcErrorCodes.INVALID_OPCODE
        );
      }
    }

    if (factory && getAddress(factory) !== getAddress(sender)) {
      if (accounts.includes(getAddress(factory))) {
        throw new RpcError(
          `A Factory at ${factory} in this UserOperation is used as a sender entity in another UserOperation currently in mempool.`,
          RpcErrorCodes.INVALID_OPCODE
        );
      }
    }
  }

  /**
   * `senderInfo` is `undefined` for the Self Relay shape (see
   * `checkEntityCountInMempool`'s comment on why) - the sender-specific
   * "bump only if staked" branch below is skipped in that case, but
   * `payer`/`factory` are unconditional and unaffected: for Self Relay,
   * `payer` already equals `sender`, so that branch still bumps the same
   * entity's seen-status regardless.
   */
  async updateSeenStatus(
    entry: MempoolEntry,
    senderInfo: StakeInfo | undefined
  ): Promise<void> {
    const { sender, payer, factory } = entry;
    const isStaked =
      senderInfo != null &&
      BigInt(senderInfo.stake) >= this.networkConfig.minStake! &&
      BigInt(senderInfo.unstakeDelaySec) >= this.networkConfig.minUnstakeDelay;

    if (isStaked) {
      await this.reputationService.updateSeenStatus(sender);
    }
    if (payer) {
      await this.reputationService.updateSeenStatus(payer);
    }
    if (factory) {
      await this.reputationService.updateSeenStatus(factory);
    }
  }

  /**
   * Bumps `included` for every distinct entity address this entry names,
   * once each - unlike `updateSeenStatus`, unconditionally (no fresh stake
   * lookup gates the sender here; see this file's header comment for why
   * that's harmless). A `Set` avoids double-counting a Self Relay entry,
   * whose `payer` always equals its `sender`.
   */
  async updateIncludedStatus(entry: MempoolEntry): Promise<void> {
    const { sender, payer, factory } = entry;
    const addresses = new Set<string>([sender]);
    if (payer) addresses.add(payer);
    if (factory) addresses.add(factory);
    for (const address of addresses) {
      await this.reputationService.updateIncludedStatus(address);
    }
  }

  /**
   * Returns a list of addresses of all entities in the mempool. `payer`/
   * `factory` are excluded from `otherEntities` when they equal that same
   * entry's own `sender` (self-pay) - see `checkMultipleRolesViolation`'s
   * doc comment for why: self-pay is not "a different entity," so it must
   * not make a sender's own address collide with itself there.
   */
  private async getKnownEntities(): Promise<KnownEntities> {
    const entities: KnownEntities = {
      accounts: [],
      otherEntities: [],
    };
    const entries = await this.service.fetchPendingUserOps();
    for (const entry of entries) {
      entities.accounts.push(getAddress(entry.sender));
      if (entry.payer && getAddress(entry.payer) !== getAddress(entry.sender)) {
        entities.otherEntities.push(getAddress(entry.payer));
      }
      if (entry.factory && getAddress(entry.factory) !== getAddress(entry.sender)) {
        entities.otherEntities.push(getAddress(entry.factory));
      }
    }
    return entities;
  }
}
