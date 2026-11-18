import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { MempoolReputationChecks } from "../../../src/services/MempoolService/reputation.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { MempoolEntryStatus, ReputationStatus } from "@skandha/types/lib/executor";

// ERC-8421 REPUTATION-040: "Admitting a replacement is not a new occurrence of `seen`".

const SENDER = "0x1111111111111111111111111111111111111111" as const;
const PAYER_A = "0x2222222222222222222222222222222222222222" as const;
const PAYER_B = "0x3333333333333333333333333333333333333333" as const;

function memoryDb() {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => {
      if (!m.has(k)) throw new Error("Not Found");
      return m.get(k);
    },
    put: async (k: string, v: any) => void m.set(k, v),
    del: async (k: string) => void m.delete(k),
    getMany: async (ks: string[]) => ks.map((k) => m.get(k)).filter(Boolean),
  } as any;
}

const tx = (maxFee: bigint, nonceKey = 7n): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [nonceKey],
  nonceSeq: 0n,
  sender: SENDER,
  frames: [{ mode: FRAME_MODE.VERIFY, flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT, target: null, limits: { execution: 1n, state: 0n }, value: 0n, data: "0x" }],
  signatures: [],
  fees: { maxPriorityFeePerGas: maxFee, maxFeePerGas: maxFee, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

const payerInfo = { addr: SENDER, stake: 0n, unstakeDelaySec: 0, withdrawTime: 0n } as any;

function build() {
  const reputation = {
    updateSeenStatus: vi.fn().mockResolvedValue(undefined),
    removeSeenStatus: vi.fn().mockResolvedValue(undefined),
    updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(ReputationStatus.OK),
    fetchOne: vi.fn().mockResolvedValue({ opsSeen: 0, opsIncluded: 0 }),
    calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(100),
    checkStake: vi.fn().mockResolvedValue({ code: 0, msg: "" }),
  };
  const pool = new MempoolService(
    memoryDb(),
    1,
    reputation as any,
    new ExecutorEventBus(),
    { useropsTTL: 0, archiveDuration: 1, whitelistedEntities: { payer: [], account: [], factory: [], paymaster: [], external: [] }, minStake: 0n, minUnstakeDelay: 0 } as any,
    { debug: vi.fn(), error: vi.fn() } as any
  );
  const add = (t: FrameTransaction, hash: `0x${string}`) => pool.addFrameTx(t, hash, undefined, undefined, undefined, payerInfo);
  return { pool, reputation, add };
}

describe("REPUTATION-040: replacements and seen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("counts a new admission once", async () => {
    const { add, reputation } = build();
    await add(tx(2n), "0xaaa");
    expect(reputation.updateSeenStatus).toHaveBeenCalledTimes(1);
  });

  it("does not count fee-bump replacements", async () => {
    const { add, reputation } = build();
    await add(tx(2n), "0xaaa");
    let fee = 2n;
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(10);
      fee *= 2n;
      await add(tx(fee), `0xb${i}`);
    }
    expect(reputation.updateSeenStatus).toHaveBeenCalledTimes(1);
    expect(reputation.removeSeenStatus).not.toHaveBeenCalled();
  });

  it("counts different nonce keys separately: they are not replacements", async () => {
    const { add, reputation } = build();
    await add(tx(2n, 1n), "0xaaa");
    await add(tx(2n, 2n), "0xbbb");
    expect(reputation.updateSeenStatus).toHaveBeenCalledTimes(2);
  });

  it("counts a resubmission after the old entry was cancelled as a new admission", async () => {
    const { pool, add, reputation } = build();
    await add(tx(2n), "0xaaa");
    const [entry] = await pool.fetchPendingUserOps();
    await pool.updateStatus([entry], MempoolEntryStatus.Cancelled, { revertReason: "evicted" });
    vi.advanceTimersByTime(10);
    await add(tx(100n), "0xbbb");
    expect(reputation.updateSeenStatus).toHaveBeenCalledTimes(2);
  });
});

describe("updateSeenOnReplacement", () => {
  const reputation = () => ({ updateSeenStatus: vi.fn().mockResolvedValue(undefined), removeSeenStatus: vi.fn().mockResolvedValue(undefined) });
  const checks = (r: any) => new MempoolReputationChecks({} as any, r, {} as any);

  it("does nothing when no role changed, ignoring address case", async () => {
    const r = reputation();
    await checks(r).updateSeenOnReplacement({ payer: PAYER_A } as any, { payer: PAYER_A.toUpperCase().replace("0X", "0x") } as any);
    expect(r.updateSeenStatus).not.toHaveBeenCalled();
    expect(r.removeSeenStatus).not.toHaveBeenCalled();
  });

  it("moves seen when the payer changes", async () => {
    const r = reputation();
    await checks(r).updateSeenOnReplacement({ payer: PAYER_A } as any, { payer: PAYER_B } as any);
    expect(r.removeSeenStatus).toHaveBeenCalledWith(PAYER_A);
    expect(r.updateSeenStatus).toHaveBeenCalledWith(PAYER_B);
  });

  it("moves seen when a factory is added or removed", async () => {
    const added = reputation();
    await checks(added).updateSeenOnReplacement({ payer: PAYER_A } as any, { payer: PAYER_A, factory: PAYER_B } as any);
    expect(added.updateSeenStatus).toHaveBeenCalledWith(PAYER_B);
    expect(added.removeSeenStatus).not.toHaveBeenCalled();
    const removed = reputation();
    await checks(removed).updateSeenOnReplacement({ payer: PAYER_A, factory: PAYER_B } as any, { payer: PAYER_A } as any);
    expect(removed.removeSeenStatus).toHaveBeenCalledWith(PAYER_B);
    expect(removed.updateSeenStatus).not.toHaveBeenCalled();
  });
});
