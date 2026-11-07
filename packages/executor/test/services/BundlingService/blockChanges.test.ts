import { describe, it, expect } from "vitest";
import { FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";
import { collectChanges, isAffected, keyedNonceSlot, slotId } from "../../../src/services/BundlingService/blockChanges.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const PAYER = "0x3333333333333333333333333333333333333333";
const TOKEN = "0x4444444444444444444444444444444444444444";

function tx(extra: Partial<FrameTransaction> = {}): FrameTransaction {
  return {
    chainId: 1337n,
    nonceKeys: [7n],
    nonceSeq: 0n,
    sender: SENDER,
    frames: [
      { mode: 1, flags: 1, target: null, limits: { execution: 50_000n, state: 0n }, value: 0n, data: "0x" },
      { mode: 1, flags: 2, target: PAYER, limits: { execution: 50_000n, state: 0n }, value: 0n, data: "0x" },
    ],
    signatures: [],
    fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, maxFeePerBlobGas: 0n },
    blobVersionedHashes: [],
    recentRootReferences: [],
    ...extra,
  } as FrameTransaction;
}

describe("isAffected", () => {
  const reads = { [TOKEN]: new Set(["0x1"]) };

  it("is false when the blocks changed nothing the transaction depends on", () => {
    const changes = collectChanges([[{ address: TOKEN, storageChanges: [{ key: `0x${"0".repeat(63)}2` }] }]]);
    expect(isAffected(tx(), reads, changes)).toBe(false);
  });

  it("matches a read slot however the trace and the access list spell it", () => {
    const traced = { "0xAbCd000000000000000000000000000000000004": new Set(["0x01"]) };
    const changes = collectChanges([
      [{ address: "0xabcd000000000000000000000000000000000004", storageChanges: [{ key: `0x${"0".repeat(63)}1` }] }],
    ]);
    expect(isAffected(tx(), traced, changes)).toBe(true);
  });

  it("is true when the payer's balance changed", () => {
    expect(isAffected(tx(), reads, collectChanges([[{ address: PAYER, balanceChanges: [{}] }]]))).toBe(true);
  });

  it("is true when code changed at an address the validation read", () => {
    expect(isAffected(tx(), reads, collectChanges([[{ address: TOKEN, codeChanges: [{}] }]]))).toBe(true);
  });

  it("is always true with recent-root references or without recorded reads", () => {
    const none = collectChanges([]);
    const refs = [{ sourceId: `0x${"a".repeat(64)}`, slot: 1n, root: `0x${"b".repeat(64)}` }] as FrameTransaction["recentRootReferences"];
    expect(isAffected(tx({ recentRootReferences: refs }), reads, none)).toBe(true);
    expect(isAffected(tx(), undefined, none)).toBe(true);
  });
});

describe("keyedNonceSlot", () => {
  it("matches the NONCE_MANAGER slot the devnet wrote for a keyed transaction", () => {
    // Devnet block 8,337: 0xf148157e…5089973, sender below with nonce key 2, set this slot to 1.
    expect(keyedNonceSlot("0x18203efd907c86567ca68ed47d865b916c81dd46", 2n)).toBe(
      "0x389dc7d6955398ec867018cfefbf85395aed4e798231225900bab9b09748cb12"
    );
  });
});

describe("collectChanges", () => {
  it("keeps written slots and accounts whose balance, nonce or code changed, not reads", () => {
    const changes = collectChanges([
      [
        { address: "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balanceChanges: [{}] },
        { address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", storageChanges: [{ key: "0x01" }] },
        { address: "0xcccccccccccccccccccccccccccccccccccccccc", storageReads: ["0x02"] } as never,
      ],
      [{ address: "0xdddddddddddddddddddddddddddddddddddddddd", nonceChanges: [{}] }],
    ]);
    expect([...changes.accounts]).toEqual([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xdddddddddddddddddddddddddddddddddddddddd",
    ]);
    expect([...changes.slots]).toEqual([slotId("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0x1")]);
  });
});
