import { describe, it, expect, vi } from "vitest";
import { MempoolReputationChecks } from "../../../src/services/MempoolService/reputation.js";
import { ReputationService } from "../../../src/services/ReputationService.js";
import { LocalDbController } from "../../mocks/database.js";

const LINEAR = { nonceKeys: [0n] };
const KEYED = (...keys: bigint[]) => ({ nonceKeys: keys });

describe("MempoolReputationChecks.checkMultipleRolesViolation", () => {
  it("rejects a frame tx whose payer address is already a sender elsewhere in the mempool", async () => {
    const payerAddr = "0x2222222222222222222222222222222222222222";
    const mempoolService = {
      fetchPendingUserOps: vi
        .fn()
        .mockResolvedValue([
          { sender: payerAddr, payer: payerAddr, factory: undefined },
        ]),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, {} as any, {} as any);
    const entry = {
      sender: "0x3333333333333333333333333333333333333333",
      payer: payerAddr,
      factory: undefined,
    } as any;
    await expect(checks.checkMultipleRolesViolation(entry)).rejects.toThrow();
  });

  it("has no aggregator-related method or parameter anywhere on the class", () => {
    const checks = new MempoolReputationChecks({} as any, {} as any, {} as any);
    expect((checks as any).checkAggregatorRoleViolation).toBeUndefined();
  });

  /**
   * Regression test for a real bug found in review: a self-relay sender
   * (payer === sender, FrameTxMempoolEntry's class doc comment) submitting
   * a SECOND pending transaction (a different nonce, same address) used to
   * collide with its own first entry - `sender` already appeared in
   * `otherEntities` (pushed as the first entry's own `payer`, itself) and
   * `payer` already appeared in `accounts` (pushed as the first entry's own
   * `sender`), rejecting completely ordinary usage. Neither direction
   * should throw for self-pay.
   */
  it("does not reject a self-relay sender's own second pending transaction", async () => {
    const selfRelayAddr = "0x4444444444444444444444444444444444444444";
    const mempoolService = {
      fetchPendingUserOps: vi.fn().mockResolvedValue([
        // The sender's own first pending entry (a different nonce).
        { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR },
      ]),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, {} as any, {} as any);
    const secondEntry = {
      sender: selfRelayAddr,
      payer: selfRelayAddr,
      factory: undefined,
    } as any;

    await expect(
      checks.checkMultipleRolesViolation(secondEntry)
    ).resolves.toBeUndefined();
  });

  it("still rejects a genuinely different entity using a self-relay sender's address as its payer", async () => {
    const selfRelayAddr = "0x4444444444444444444444444444444444444444";
    const otherSender = "0x5555555555555555555555555555555555555555";
    const mempoolService = {
      fetchPendingUserOps: vi.fn().mockResolvedValue([
        { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR },
      ]),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, {} as any, {} as any);
    // A different sender designates the self-relay address as its payer -
    // this IS the reputation-gaming pattern the check exists to catch, and
    // must still be rejected: payer (selfRelayAddr) !== this entry's own
    // sender (otherSender), so the self-pay exclusion does not apply.
    const entry = {
      sender: otherSender,
      payer: selfRelayAddr,
      factory: undefined,
    } as any;

    await expect(checks.checkMultipleRolesViolation(entry)).rejects.toThrow(
      /is used as a sender entity/
    );
  });

  it("still rejects a sender address that is a genuinely different entity's payer elsewhere in the mempool", async () => {
    const senderA = "0x6666666666666666666666666666666666666666";
    const payerB = "0x7777777777777777777777777777777777777777";
    const mempoolService = {
      fetchPendingUserOps: vi.fn().mockResolvedValue([
        // A's entry designates B (a different address) as its payer.
        { sender: senderA, payer: payerB, factory: undefined },
      ]),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, {} as any, {} as any);
    // B now tries to submit its own entry as a plain sender - B is already
    // "a different entity" (A's payer) elsewhere, so this must be rejected.
    const entry = { sender: payerB, payer: payerB, factory: undefined } as any;

    await expect(checks.checkMultipleRolesViolation(entry)).rejects.toThrow(
      /is used as a different entity/
    );
  });
});

/**
 * `senderInfo` is `undefined` for the Self Relay validation-prefix shape
 * (no dedicated "sender" frame - `resolveRoleStakes`, frameTx.ts). Before
 * this fix, `checkEntityCountInMempool` unconditionally read
 * `senderInfo.addr` and `MempoolService.addFrameTx`'s caller-side guard was
 * keyed on `senderInfo` alone - so a self-relay entry either crashed
 * admission outright (if the guard were ever removed) or, with the guard
 * in place, silently skipped the entire reputation gate for the most
 * common transaction shape. These tests pin both: no crash, AND the gate
 * genuinely still fires - through the `payerInfo`/"payer" bucket, since
 * Self Relay's payer resolves to the same address as its sender.
 */
describe("MempoolReputationChecks.checkEntityCountInMempool - Self Relay (senderInfo undefined)", () => {
  const selfRelayAddr = "0x4444444444444444444444444444444444444444";
  const payerInfo = { addr: selfRelayAddr, stake: 0n, unstakeDelaySec: 0 };

  it("does not throw when senderInfo is undefined and no other entries exist", async () => {
    const mempoolService = { fetchPendingUserOps: vi.fn().mockResolvedValue([]) } as any;
    const reputationService = {
      getStatus: vi.fn().mockResolvedValue(0), // ReputationStatus.OK
      fetchOne: vi.fn().mockResolvedValue({}),
      calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(10),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, reputationService, {
      whitelistedEntities: {},
    } as any);
    const entry = { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR } as any;

    await expect(
      checks.checkEntityCountInMempool(entry, undefined, undefined, payerInfo)
    ).resolves.toBeUndefined();
  });

  it("still gates a self-relay entity through the payer bucket, not silently skipped", async () => {
    // Mempool already has this same self-relay address as a `payer` on
    // another entry - count[2] ("payer") should reach 2, above the
    // (mocked) allowed threshold of 1, triggering the ban check.
    const mempoolService = {
      fetchPendingUserOps: vi.fn().mockResolvedValue([
        { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR },
      ]),
    } as any;
    const reputationService = {
      getStatus: vi.fn().mockResolvedValue(0), // ReputationStatus.OK
      fetchOne: vi.fn().mockResolvedValue({}),
      calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(1),
      checkStake: vi.fn().mockResolvedValue({ code: 1, msg: "unstaked payer over threshold" }),
    } as any;
    const checks = new MempoolReputationChecks(mempoolService, reputationService, {
      whitelistedEntities: {},
    } as any);
    const entry = { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR } as any;

    await expect(
      checks.checkEntityCountInMempool(entry, undefined, undefined, payerInfo)
    ).rejects.toThrow("unstaked payer over threshold");
    expect(reputationService.checkStake).toHaveBeenCalledWith(payerInfo);
  });
});

describe("MempoolReputationChecks.updateSeenStatus - Self Relay (senderInfo undefined)", () => {
  it("bumps the payer's seen-status (== the sender, for Self Relay) without senderInfo", async () => {
    const selfRelayAddr = "0x5555555555555555555555555555555555555555";
    const reputationService = { updateSeenStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {
      minStake: 0n,
      minUnstakeDelay: 0,
    } as any);
    const entry = { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR } as any;

    await expect(checks.updateSeenStatus(entry, undefined)).resolves.toBeUndefined();
    expect(reputationService.updateSeenStatus).toHaveBeenCalledWith(selfRelayAddr);
    expect(reputationService.updateSeenStatus).toHaveBeenCalledTimes(1);
  });
});

describe("MempoolReputationChecks.updateIncludedStatus", () => {
  it("bumps each of sender, payer and factory once, when all three are distinct addresses", async () => {
    const sender = "0x1111111111111111111111111111111111111111";
    const payer = "0x2222222222222222222222222222222222222222";
    const factory = "0x3333333333333333333333333333333333333333";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender, payer, factory } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(3);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(sender);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(payer);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(factory);
  });

  it("bumps a Self Relay entry's shared sender/payer address exactly once, not twice", async () => {
    const selfRelayAddr = "0x4444444444444444444444444444444444444444";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender: selfRelayAddr, payer: selfRelayAddr, factory: undefined, tx: LINEAR } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(1);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(selfRelayAddr);
  });

  it("bumps only sender when payer and factory are absent", async () => {
    const sender = "0x5555555555555555555555555555555555555555";
    const reputationService = { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any;
    const checks = new MempoolReputationChecks({} as any, reputationService, {} as any);
    const entry = { sender, payer: undefined, factory: undefined } as any;

    await checks.updateIncludedStatus(entry);

    expect(reputationService.updateIncludedStatus).toHaveBeenCalledTimes(1);
    expect(reputationService.updateIncludedStatus).toHaveBeenCalledWith(sender);
  });
});

describe("MempoolReputationChecks.checkEntityCountInMempool - EIP-8250 keyed nonces", () => {
  const sender = "0x4444444444444444444444444444444444444444";
  const thirdPartyPayer = "0x8888888888888888888888888888888888888888";
  const stake = (addr: string) => ({ addr, stake: 0n, unstakeDelaySec: 0 });
  const build = (pending: any[], maxUnstaked = 1) => {
    const reputationService = {
      getStatus: vi.fn().mockResolvedValue(0), // ReputationStatus.OK
      fetchOne: vi.fn().mockResolvedValue({}),
      calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(maxUnstaked),
      checkStake: vi.fn().mockResolvedValue({ code: 1, msg: "over the per-entity cap" }),
    } as any;
    const checks = new MempoolReputationChecks(
      { fetchPendingUserOps: vi.fn().mockResolvedValue(pending) } as any,
      reputationService,
      { whitelistedEntities: {} } as any
    );
    return { checks, reputationService };
  };
  const selfRelay = (tx: object) => ({ sender, payer: sender, factory: undefined, tx });
  const many = (n: number, tx: (i: number) => object) =>
    Array.from({ length: n }, (_, i) => selfRelay(tx(i)));

  it("does not cap a self-relay sender's keyed txs (payer bucket is the sender itself)", async () => {
    const { checks, reputationService } = build(many(20, (i) => KEYED(BigInt(i + 1))));
    await expect(
      checks.checkEntityCountInMempool(selfRelay(KEYED(99n)) as any, undefined, undefined, stake(sender))
    ).resolves.toBeUndefined();
    expect(reputationService.checkStake).not.toHaveBeenCalled();
  });

  it("does not cap keyed txs through the dedicated sender bucket either", async () => {
    const pending = Array.from({ length: 10 }, (_, i) => ({
      sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(BigInt(i + 1)),
    }));
    const { checks } = build(pending, 100);
    await expect(
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(99n) } as any,
        stake(sender), undefined, stake(thirdPartyPayer)
      )
    ).resolves.toBeUndefined();
  });

  it("does not let keyed siblings use up a sender's linear allowance", async () => {
    const { checks } = build(many(20, (i) => KEYED(BigInt(i + 1))));
    await expect(
      checks.checkEntityCountInMempool(selfRelay(LINEAR) as any, undefined, undefined, stake(sender))
    ).resolves.toBeUndefined();
  });

  it("still caps linear txs against other linear txs", async () => {
    const { checks } = build(many(1, () => LINEAR));
    await expect(
      checks.checkEntityCountInMempool(selfRelay(LINEAR) as any, undefined, undefined, stake(sender))
    ).rejects.toThrow("over the per-entity cap");
  });

  it("still caps a third-party payer sponsoring keyed txs", async () => {
    const pending = [{ sender: "0x9999999999999999999999999999999999999999", payer: thirdPartyPayer, factory: undefined, tx: KEYED(1n) }];
    const { checks } = build(pending);
    await expect(
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(2n) } as any,
        undefined, undefined, stake(thirdPartyPayer)
      )
    ).rejects.toThrow("over the per-entity cap");
  });

  it("still rejects a banned sender's keyed tx", async () => {
    const { checks, reputationService } = build([]);
    reputationService.getStatus.mockResolvedValue(2); // ReputationStatus.BANNED
    await expect(
      checks.checkEntityCountInMempool(selfRelay(KEYED(1n)) as any, undefined, undefined, stake(sender))
    ).rejects.toThrow(/banned/);
  });
});

describe("MempoolReputationChecks.checkEntityCountInMempool - ERC-8421 sender-wide cap", () => {
  const sender = "0x4444444444444444444444444444444444444444";
  const thirdPartyPayer = "0x8888888888888888888888888888888888888888";
  const stake = (addr: string) => ({ addr, stake: 0n, unstakeDelaySec: 0, withdrawTime: 0 });
  const build = (pending: any[], staked = false, whitelistedEntities = {}) => {
    const reputationService = {
      getStatus: vi.fn().mockResolvedValue(0), // ReputationStatus.OK
      fetchOne: vi.fn().mockResolvedValue({}),
      calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(1000),
      checkStake: vi.fn().mockResolvedValue(staked ? { code: 0, msg: "" } : { code: -32505, msg: "unstaked" }),
    } as any;
    const checks = new MempoolReputationChecks(
      { fetchPendingUserOps: vi.fn().mockResolvedValue(pending) } as any,
      reputationService,
      { whitelistedEntities } as any
    );
    return { checks, reputationService };
  };
  const selfRelay = (tx: object) => ({ sender, payer: sender, factory: undefined, tx });
  const keyedLanes = (n: number) => Array.from({ length: n }, (_, i) => selfRelay(KEYED(BigInt(i + 1))));
  const add = (checks: MempoolReputationChecks, tx: object = KEYED(999n)) =>
    checks.checkEntityCountInMempool(selfRelay(tx) as any, undefined, undefined, stake(sender));

  it("admits an unstaked sender's 64th pending tx", async () => {
    const { checks, reputationService } = build(keyedLanes(63));
    await expect(add(checks)).resolves.toBeUndefined();
    expect(reputationService.checkStake).not.toHaveBeenCalled();
  });

  it("refuses an unstaked sender's 65th pending keyed tx", async () => {
    const { checks, reputationService } = build(keyedLanes(64));
    await expect(add(checks)).rejects.toThrow(/has 64 pending transactions; a sender that is not staked may have at most 64/);
    expect(reputationService.checkStake).toHaveBeenCalledWith(stake(sender));
  });

  it("counts linear and keyed txs together", async () => {
    const pending = [...keyedLanes(60), ...Array.from({ length: 4 }, () => selfRelay(LINEAR))];
    const { checks } = build(pending);
    await expect(add(checks)).rejects.toThrow(/a sender that is not staked may have at most 64/);
  });

  it("does not count other senders' txs", async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({
      sender: `0x${(i + 1).toString(16).padStart(40, "0")}`, payer: undefined, factory: undefined, tx: KEYED(1n),
    }));
    const { checks } = build([...others, ...keyedLanes(10)]);
    await expect(add(checks)).resolves.toBeUndefined();
  });

  it("lets a staked sender keep more than 64 pending", async () => {
    const { checks, reputationService } = build(keyedLanes(200), true);
    await expect(add(checks)).resolves.toBeUndefined();
    expect(reputationService.checkStake).toHaveBeenCalledWith(stake(sender));
  });

  it("takes a sponsored sender's stake from its sender frame, not from the payer", async () => {
    const pending = Array.from({ length: 64 }, (_, i) => ({ sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(BigInt(i + 1)) }));
    const { checks, reputationService } = build(pending);
    reputationService.checkStake.mockImplementation(async (info: { addr: string }) =>
      info.addr === sender ? { code: 0, msg: "" } : { code: -32505, msg: `${info.addr} is unstaked` }
    );
    await expect(
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(999n) } as any,
        stake(sender), undefined, stake(thirdPartyPayer)
      )
    ).resolves.toBeUndefined();
    expect(reputationService.checkStake).toHaveBeenCalledWith(stake(sender));
  });

  it("does not cap a self-paying sender whitelisted in the config as a paymaster, but does as an account", async () => {
    const asPaymaster = build(keyedLanes(64), false, { paymaster: [sender] });
    await expect(add(asPaymaster.checks)).resolves.toBeUndefined();
    expect(asPaymaster.reputationService.checkStake).not.toHaveBeenCalled();

    const asAccount = build(keyedLanes(64), false, { account: [sender] });
    await expect(add(asAccount.checks)).rejects.toThrow(/may have at most 64/);
  });

  it("does not cap a sponsored sender whitelisted in the config as an account, but does as a paymaster", async () => {
    const pending = Array.from({ length: 64 }, (_, i) => ({ sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(BigInt(i + 1)) }));
    const sponsored = (checks: MempoolReputationChecks) =>
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(999n) } as any,
        stake(sender), undefined, stake(thirdPartyPayer)
      );
    await expect(sponsored(build(pending, false, { account: [sender] }).checks)).resolves.toBeUndefined();
    await expect(sponsored(build(pending, false, { paymaster: [sender] }).checks)).rejects.toThrow(/may have at most 64/);
  });

  it("refuses through the real stake check, and passes a sender on the admin whitelist", async () => {
    const reputation = new ReputationService(new LocalDbController("sender-cap"), 1337, 10, 10, 50, 1_000_000_000n, 0);
    const checks = new MempoolReputationChecks(
      { fetchPendingUserOps: vi.fn().mockResolvedValue(keyedLanes(64)) } as any,
      reputation,
      { whitelistedEntities: {} } as any
    );
    await expect(add(checks)).rejects.toThrow(/may have at most 64 \(0x4444444444444444444444444444444444444444 is unstaked\)/);
    await reputation.addToWhitelist(sender);
    await expect(add(checks)).resolves.toBeUndefined();
  });

  it("skips the ban check for a sender whitelisted in the config as an account", async () => {
    const { checks, reputationService } = build([], false, { account: [sender] });
    reputationService.getStatus.mockResolvedValue(2); // ReputationStatus.BANNED
    await expect(
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(1n) } as any,
        stake(sender), undefined, undefined
      )
    ).resolves.toBeUndefined();
  });

  it("treats a sender no role resolved a stake for as unstaked", async () => {
    const pending = Array.from({ length: 64 }, (_, i) => ({ sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(BigInt(i + 1)) }));
    const { checks, reputationService } = build(pending);
    await expect(
      checks.checkEntityCountInMempool(
        { sender, payer: thirdPartyPayer, factory: undefined, tx: KEYED(999n) } as any,
        undefined, undefined, stake(thirdPartyPayer)
      )
    ).rejects.toThrow(/a sender that is not staked may have at most 64/);
    expect(reputationService.checkStake).toHaveBeenLastCalledWith(expect.objectContaining({ addr: sender, stake: 0 }));
  });
});
