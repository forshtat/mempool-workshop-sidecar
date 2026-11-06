import { describe, it, expect, vi } from "vitest";
import {
  recognizeValidationPrefix,
  computeEntityVerifyGas,
  checkVerifyGasBudgets,
  DEFAULT_VERIFY_GAS_BUDGETS,
  MAX_VERIFY_GAS_PER_ENTITY,
  MAX_VERIFY_GAS_STAKED_ENTITY,
} from "../../../../src/services/UserOpValidation/utils/validationPrefix.js";
import {
  FRAME_MODE,
  APPROVE_SCOPE,
  Frame,
  FrameTransaction,
  SIG_SCHEME,
  SignatureEntry,
} from "@skandha/types/lib/contracts/FrameTx.js";

// ERC-8421 [BUDGET-010]: "A node MUST track the sum of `limits.execution`
// separately per entity, over that entity's own validation frames. The
// `pre_verify` frame counts toward the entity of the approving frame it
// immediately precedes. The intrinsic cost of validating `tx.signatures`
// counts toward the `tx.sender`. For unstaked entities, that sum MUST NOT
// exceed MAX_VERIFY_GAS_PER_ENTITY. For staked entities, that sum MUST NOT
// exceed MAX_VERIFY_GAS_STAKED_ENTITY."

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER = "0x5555555555555555555555555555555555555555" as const;
const FACTORY = "0x3333333333333333333333333333333333333333" as const;

const verify = (flags: number, execution: bigint, target: `0x${string}` | null = null): Frame => ({
  mode: FRAME_MODE.VERIFY,
  flags,
  target,
  limits: { execution, state: 0n },
  value: 0n,
  data: "0x",
});
const selfVerify = (execution: bigint) => verify(APPROVE_SCOPE.EXECUTION_AND_PAYMENT, execution);
const onlyVerify = (execution: bigint) => verify(APPROVE_SCOPE.EXECUTION, execution);
const pay = (execution: bigint, target: `0x${string}` = PAYER) => verify(APPROVE_SCOPE.PAYMENT, execution, target);
const expiryVerify = (execution: bigint) => verify(APPROVE_SCOPE.NONE, execution);
const defaultFrame = (execution: bigint, target: `0x${string}` | null): Frame => ({
  mode: FRAME_MODE.DEFAULT,
  flags: 0,
  target,
  limits: { execution, state: 0n },
  value: 0n,
  data: "0x",
});
const body = (): Frame => ({
  mode: FRAME_MODE.SENDER,
  flags: 0,
  target: "0x4444444444444444444444444444444444444444",
  limits: { execution: 5_000_000n, state: 0n },
  value: 0n,
  data: "0x",
});

const sig = (scheme: number): SignatureEntry =>
  ({ scheme, signer: "0x2222222222222222222222222222222222222222", msg: "0x", signature: "0x" }) as SignatureEntry;

const tx = (frames: Frame[], signatures: SignatureEntry[] = []): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames,
  signatures,
  fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const usageOf = (t: FrameTransaction) => {
  const prefix = recognizeValidationPrefix(t.frames, t.sender);
  expect(prefix).not.toBeNull();
  return computeEntityVerifyGas(t, prefix!);
};

const stakedSet = (...addrs: string[]) =>
  vi.fn(async (a: string) => addrs.some((x) => x.toLowerCase() === a.toLowerCase()));

describe("BUDGET-010 constants", () => {
  it("default to ERC-8421 §Constants", () => {
    expect(MAX_VERIFY_GAS_PER_ENTITY).toBe(100_000n);
    expect(MAX_VERIFY_GAS_STAKED_ENTITY).toBe(1_000_000n);
    expect(DEFAULT_VERIFY_GAS_BUDGETS).toEqual({ perEntity: 100_000n, stakedEntity: 1_000_000n });
  });
});

describe("computeEntityVerifyGas (BUDGET-010 attribution)", () => {
  it("Self Relay: the self_verify frame and the signature cost are one entity, tx.sender", () => {
    const u = usageOf(tx([selfVerify(150_000n), body()], [sig(SIG_SCHEME.SECP256K1)]));
    expect(u.entities).toHaveLength(1);
    expect(u.entities[0]).toMatchObject({
      address: SENDER,
      roles: ["sender", "payer"],
      frameIndices: [0],
      execution: 150_000n,
      signatureCost: 2_800n,
      total: 152_800n,
    });
    expect(u.unattributed).toEqual([]);
  });

  it("Canonical Paymaster: sender and payer are tracked separately; the signature cost counts toward the sender only", () => {
    const u = usageOf(tx([onlyVerify(90_000n), pay(300_000n), body()], [sig(SIG_SCHEME.SECP256K1), sig(SIG_SCHEME.ARBITRARY)]));
    expect(u.entities.map((e) => [e.address, e.roles, e.execution, e.signatureCost, e.total])).toEqual([
      [SENDER, ["sender"], 90_000n, 2_900n, 92_900n],
      [PAYER, ["payer"], 300_000n, 0n, 300_000n],
    ]);
  });

  it("a pre_verify frame counts toward the entity of the approving frame it precedes", () => {
    // [only_verify, pre_verify(PAYER), pay(PAYER)]
    const u = usageOf(tx([onlyVerify(10_000n), defaultFrame(70_000n, PAYER), pay(40_000n), body()]));
    const payer = u.entities.find((e) => e.address === PAYER)!;
    expect(payer.frameIndices).toEqual([1, 2]);
    expect(payer.execution).toBe(110_000n);
    expect(u.entities.find((e) => e.address === SENDER)!.execution).toBe(10_000n);
  });

  it("a pre_verify before self_verify counts toward tx.sender", () => {
    const u = usageOf(tx([defaultFrame(60_000n, null), selfVerify(50_000n), body()], [sig(SIG_SCHEME.SECP256K1)]));
    expect(u.entities).toHaveLength(1);
    expect(u.entities[0].total).toBe(112_800n);
  });

  it("the deploy frame is the factory's own entity", () => {
    const u = usageOf(tx([defaultFrame(200_000n, FACTORY), selfVerify(20_000n), body()]));
    expect(u.entities.map((e) => [e.address, e.roles, e.total])).toEqual([
      [FACTORY, ["factory"], 200_000n],
      [SENDER, ["sender", "payer"], 20_000n],
    ]);
  });

  it("a pay frame that targets tx.sender is the same entity as the sender (keyed by address, not role)", () => {
    const u = usageOf(tx([onlyVerify(60_000n), pay(60_000n, SENDER), body()]));
    expect(u.entities).toHaveLength(1);
    expect(u.entities[0]).toMatchObject({ address: SENDER, roles: ["sender", "payer"], total: 120_000n });
  });

  it("a leading expiry_verify frame is attributed to no entity (ERC-8421 Definitions 4)", () => {
    const u = usageOf(tx([expiryVerify(5_000n), selfVerify(40_000n), body()]));
    expect(u.unattributed).toEqual([{ frameIndex: 0, execution: 5_000n }]);
    expect(u.entities).toHaveLength(1);
    expect(u.entities[0].total).toBe(40_000n);
  });

  it("execution-body frames never count", () => {
    const u = usageOf(tx([selfVerify(1_000n), body(), body()]));
    expect(u.entities[0].total).toBe(1_000n);
  });
});

describe("checkVerifyGasBudgets (BUDGET-010 limits)", () => {
  it("rejects an unstaked entity over MAX_VERIFY_GAS_PER_ENTITY, naming it, its sum, the limit and its stake status", async () => {
    const r = await checkVerifyGasBudgets(usageOf(tx([selfVerify(150_000n), body()], [sig(SIG_SCHEME.SECP256K1)])), stakedSet());
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.reason).toMatch(/^BUDGET-010: /);
      expect(r.reason).toContain(SENDER);
      expect(r.reason).toContain("152800");
      expect(r.reason).toMatch(/exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity/);
      expect(r.entity?.address).toBe(SENDER);
    }
  });

  it("admits the same prefix when the entity is staked", async () => {
    const isStaked = stakedSet(SENDER);
    const r = await checkVerifyGasBudgets(usageOf(tx([selfVerify(150_000n), body()], [sig(SIG_SCHEME.SECP256K1)])), isStaked);
    expect(r).toEqual({ valid: true, summary: "sender+payer 152800/1000000 (staked)" });
    expect(isStaked).toHaveBeenCalledWith(SENDER);
  });

  it("rejects over MAX_VERIFY_GAS_STAKED_ENTITY even when staked, without a stake lookup", async () => {
    const isStaked = stakedSet(SENDER);
    const r = await checkVerifyGasBudgets(usageOf(tx([selfVerify(1_100_000n), body()])), isStaked);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000, the limit even for a staked entity/);
    expect(isStaked).not.toHaveBeenCalled();
  });

  it("accepts exactly MAX_VERIFY_GAS_STAKED_ENTITY when staked and exactly MAX_VERIFY_GAS_PER_ENTITY when unstaked", async () => {
    expect((await checkVerifyGasBudgets(usageOf(tx([selfVerify(1_000_000n)])), stakedSet(SENDER))).valid).toBe(true);
    expect((await checkVerifyGasBudgets(usageOf(tx([selfVerify(100_000n)])), stakedSet())).valid).toBe(true);
    expect((await checkVerifyGasBudgets(usageOf(tx([selfVerify(100_001n)])), stakedSet())).valid).toBe(false);
  });

  it("does not look up stake for entities within the unstaked budget", async () => {
    const isStaked = stakedSet();
    const r = await checkVerifyGasBudgets(usageOf(tx([onlyVerify(50_000n), pay(50_000n), body()])), isStaked);
    expect(r.valid).toBe(true);
    expect(isStaked).not.toHaveBeenCalled();
  });

  it("the signature cost alone can push tx.sender over its budget", async () => {
    // 99,999 + P256 6,700 = 106,699 > 100,000
    const r = await checkVerifyGasBudgets(
      usageOf(tx([onlyVerify(99_999n), pay(1_000n), body()], [sig(SIG_SCHEME.P256)])),
      stakedSet()
    );
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain("signature-verification cost 6700");
  });

  it("PoolPayer shape: an unstaked sender within 100k and a staked payer at 300k pass", async () => {
    const r = await checkVerifyGasBudgets(
      usageOf(tx([onlyVerify(90_000n), pay(300_000n), body()], [sig(SIG_SCHEME.SECP256K1)])),
      stakedSet(PAYER)
    );
    expect(r).toEqual({ valid: true, summary: "sender 92800/100000, payer 300000/1000000 (staked)" });
  });

  it("the payer's stake does not lift the sender: an unstaked sender over 100k fails even with a staked payer", async () => {
    const r = await checkVerifyGasBudgets(usageOf(tx([onlyVerify(150_000n), pay(300_000n), body()])), stakedSet(PAYER));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.entity?.address).toBe(SENDER);
  });

  it("an unstaked payer at 300k fails and is the entity named", async () => {
    const r = await checkVerifyGasBudgets(usageOf(tx([onlyVerify(50_000n), pay(300_000n), body()])), stakedSet(SENDER));
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.entity?.address).toBe(PAYER);
      expect(r.reason).toMatch(/^BUDGET-010: payer 0x5555/);
    }
  });

  it("a staked factory may spend up to 1M in its deploy frame while the unstaked sender stays bounded", async () => {
    const t = tx([defaultFrame(400_000n, FACTORY), selfVerify(20_000n), body()]);
    expect((await checkVerifyGasBudgets(usageOf(t), stakedSet(FACTORY))).valid).toBe(true);
    expect((await checkVerifyGasBudgets(usageOf(t), stakedSet(SENDER))).valid).toBe(false);
  });

  it("an expiry_verify frame belongs to no entity: held to the unstaked budget even if the sender is staked", async () => {
    const r = await checkVerifyGasBudgets(usageOf(tx([expiryVerify(150_000n), selfVerify(10_000n), body()])), stakedSet(SENDER));
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toMatch(/expiry_verify frame 0 .*\(attributed to no entity/);
    // ...and its gas is not added to the sender's own sum
    const ok = await checkVerifyGasBudgets(usageOf(tx([expiryVerify(60_000n), selfVerify(60_000n), body()])), stakedSet());
    expect(ok.valid).toBe(true);
  });

  it("honours operator-configured budgets (e.g. the landing page's 250k / 2.5M)", async () => {
    const budgets = { perEntity: 250_000n, stakedEntity: 2_500_000n };
    expect((await checkVerifyGasBudgets(usageOf(tx([selfVerify(200_000n)])), stakedSet(), budgets)).valid).toBe(true);
    expect((await checkVerifyGasBudgets(usageOf(tx([selfVerify(2_000_000n)])), stakedSet(SENDER), budgets)).valid).toBe(true);
    const r = await checkVerifyGasBudgets(usageOf(tx([selfVerify(300_000n)])), stakedSet(), budgets);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reason).toContain("MAX_VERIFY_GAS_PER_ENTITY 250000");
  });
});
