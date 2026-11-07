import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MempoolService } from "../../../src/services/MempoolService/service.js";
import { ExecutorEventBus } from "../../../src/services/SubscriptionService.js";
import { FrameTransaction, FRAME_MODE, APPROVE_SCOPE } from "@skandha/types/lib/contracts/FrameTx.js";
import { keccak256 } from "viem";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { encodeRawFrameTx } from "../../../src/services/FrameTxService/codec.js";

const SENDER = "0x1111111111111111111111111111111111111111" as const;

function memoryDb() {
  const m = new Map<string, any>();
  return {
    get: async (k: string) => {
      if (!m.has(k)) throw new Error("Not Found");
      return m.get(k);
    },
    put: async (k: string, v: any) => {
      m.set(k, v);
    },
    del: async (k: string) => {
      m.delete(k);
    },
    getMany: async (ks: string[]) => ks.map((k) => m.get(k)).filter(Boolean),
  } as any;
}

const txWithFee = (maxFee: bigint): FrameTransaction => ({
  chainId: 1n,
  nonceKeys: [0n],
  nonceSeq: 0n,
  sender: SENDER,
  frames: [
    {
      mode: FRAME_MODE.VERIFY,
      flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
      target: null,
      limits: { execution: 1n, state: 0n },
      value: 0n,
      data: "0x",
    },
  ],
  signatures: [],
  fees: { maxPriorityFeePerGas: maxFee, maxFeePerGas: maxFee, maxFeePerBlobGas: 0n },
  blobVersionedHashes: [],
  recentRootReferences: [],
});

describe("MempoolService.addFrameTx return value", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const build = () =>
    new MempoolService(
      memoryDb(),
      1,
      { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
      new ExecutorEventBus(),
      { useropsTTL: 0, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );

  it("returns no replacedTxHash for a new transaction", async () => {
    const pool = build();
    const res = await pool.addFrameTx(txWithFee(2n), "0xaaa");
    expect(res.replacedTxHash).toBeUndefined();
  });

  it("returns the old transaction's hash when a newer one takes its sender:nonce slot", async () => {
    const pool = build();
    await pool.addFrameTx(txWithFee(2n), "0xaaa");
    vi.advanceTimersByTime(10); // useropsTTL is 0, so any later update may replace
    const res = await pool.addFrameTx(txWithFee(100n), "0xbbb");
    expect(res.replacedTxHash).toBe("0xaaa");
  });
});

describe("MempoolService.validateFrameTxReplaceability", () => {
  const build = (useropsTTL = 0) =>
    new MempoolService(
      memoryDb(),
      1,
      { updateIncludedStatus: vi.fn().mockResolvedValue(undefined) } as any,
      new ExecutorEventBus(),
      { useropsTTL, archiveDuration: 1 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );
  const hashOf = (tx: FrameTransaction) => keccak256(encodeRawFrameTx(tx));

  it("says an identical resubmission is already known, not that its fee is too low", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
  });

  it("still says already known after the replacement TTL, when any newer transaction could replace it", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const pool = build(1);
      const tx = txWithFee(2n);
      await pool.addFrameTx(tx, hashOf(tx));
      vi.advanceTimersByTime(5_000);
      await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the same transaction be submitted again once its entry was cancelled", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    const entry = await pool.getEntryByHash(hashOf(tx));
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "gave up" });
    await expect(pool.validateFrameTxReplaceability(tx)).resolves.toBe(true);
  });

  it("still says already known for one that is on chain", async () => {
    const pool = build(300);
    const tx = txWithFee(2n);
    await pool.addFrameTx(tx, hashOf(tx));
    const entry = await pool.getEntryByHash(hashOf(tx));
    await pool.updateStatus([entry!], MempoolEntryStatus.OnChain, { transaction: hashOf(tx) });
    await expect(pool.validateFrameTxReplaceability(tx)).rejects.toMatchObject({ message: expect.stringMatching(/already known/i) });
  });

  it("keeps the fee rule for a different transaction in the same sender:nonce slot", async () => {
    const pool = build(300);
    const tx = txWithFee(100n);
    await pool.addFrameTx(tx, hashOf(tx));
    await expect(pool.validateFrameTxReplaceability(txWithFee(101n))).rejects.toMatchObject({
      message: expect.stringMatching(/cannot be replaced: fee too low/),
    });
    await expect(pool.validateFrameTxReplaceability(txWithFee(200n))).resolves.toBe(true);
  });

  it("fee-bumps a keyed transaction with the same key set", async () => {
    const pool = build(300);
    const keyed = { ...txWithFee(100n), nonceKeys: [7n, 9n] };
    await pool.addFrameTx(keyed, hashOf(keyed));
    await expect(
      pool.validateFrameTxReplaceability({ ...txWithFee(200n), nonceKeys: [7n, 9n] })
    ).resolves.toBe(true);
  });

  it("accepts a transaction for an empty slot", async () => {
    await expect(build().validateFrameTxReplaceability(txWithFee(2n))).resolves.toBe(true);
  });
});

describe("MempoolService.addFrameTx - ERC-8421 sender-wide cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const self = { addr: SENDER, stake: 0n, unstakeDelaySec: 0, withdrawTime: 0 };
  const keyed = (key: bigint, fee = 2n): FrameTransaction => ({ ...txWithFee(fee), nonceKeys: [key] });
  const hashOf = (tx: FrameTransaction) => keccak256(encodeRawFrameTx(tx));
  const build = () =>
    new MempoolService(
      memoryDb(),
      1,
      {
        getStatus: vi.fn().mockResolvedValue(0),
        fetchOne: vi.fn().mockResolvedValue({}),
        calculateMaxAllowedMempoolOpsUnstaked: vi.fn().mockReturnValue(1000),
        checkStake: vi.fn().mockResolvedValue({ code: -32505, msg: `${SENDER} is unstaked` }),
        updateSeenStatus: vi.fn().mockResolvedValue(undefined),
        updateIncludedStatus: vi.fn().mockResolvedValue(undefined),
      } as any,
      new ExecutorEventBus(),
      { useropsTTL: 0, archiveDuration: 1, whitelistedEntities: {}, minStake: 1n, minUnstakeDelay: 0 } as any,
      { debug: vi.fn(), error: vi.fn() } as any
    );
  const add = (pool: MempoolService, tx: FrameTransaction) =>
    pool.addFrameTx(tx, hashOf(tx), undefined, undefined, undefined, self);
  const fill = async (pool: MempoolService) => {
    for (let key = 1n; key <= 64n; key++) await add(pool, keyed(key));
  };

  it("refuses resubmitting a cancelled tx while the sender is at the cap", async () => {
    const pool = build();
    await fill(pool);
    const entry = await pool.getEntryByHash(hashOf(keyed(64n)));
    await pool.updateStatus([entry!], MempoolEntryStatus.Cancelled, { revertReason: "test" });
    await add(pool, keyed(65n));
    await expect(add(pool, keyed(64n))).rejects.toThrow(/may have at most 64/);
  });

  it("still lets a pending tx be fee-bumped at the cap", async () => {
    const pool = build();
    await fill(pool);
    vi.advanceTimersByTime(10); // useropsTTL is 0, so any later update may replace
    const res = await add(pool, keyed(1n, 100n));
    expect(res.replacedTxHash).toBe(hashOf(keyed(1n)));
  });
});
