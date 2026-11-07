import { Hex, encodeAbiParameters, keccak256 } from "viem";
import {
  FRAME_MODE,
  FrameTransaction,
  NONCE_MANAGER,
  isKeyedNonce,
} from "@skandha/types/lib/contracts/FrameTx.js";
import {
  classifyFrame,
  FRAME_SUBCLASS,
} from "@skandha/types/lib/contracts/frameModes.js";

/** One account's entry in an EIP-7928 block access list (`eth_getBlockAccessList`). */
export type AccountAccess = {
  address: string;
  storageChanges?: { key: string }[];
  balanceChanges?: unknown[];
  nonceChanges?: unknown[];
  codeChanges?: unknown[];
};

/**
 * What a run of blocks changed: accounts whose balance, nonce or code
 * changed, written slots, and the accounts those slots belong to.
 */
export type BlockChanges = {
  accounts: Set<string>;
  slots: Set<string>;
  written: Set<string>;
};

/** Storage reads of one validation, as `FrameTxValidationResult.accessedSlots` records them. */
export type SlotReads = { [address: string]: Set<string> };

export const slotId = (address: string, slot: string | bigint): string =>
  `${address.toLowerCase()}:${BigInt(slot).toString(16)}`;

export function collectChanges(accessLists: AccountAccess[][]): BlockChanges {
  const changes: BlockChanges = {
    accounts: new Set(),
    slots: new Set(),
    written: new Set(),
  };
  for (const access of accessLists.flat()) {
    const address = access.address.toLowerCase();
    const touched = [
      access.balanceChanges,
      access.nonceChanges,
      access.codeChanges,
    ];
    if (touched.some((list) => (list?.length ?? 0) > 0)) {
      changes.accounts.add(address);
    }
    for (const { key } of access.storageChanges ?? []) {
      changes.slots.add(slotId(address, key));
      changes.written.add(address);
    }
  }
  return changes;
}

/** EIP-8250: the NONCE_MANAGER slot holding the sequence of `sender`'s nonce key `key`. */
export function keyedNonceSlot(sender: Hex, key: bigint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [sender, key]
    )
  );
}

/**
 * Whether `changes` can have made `tx` invalid, given the slots its last
 * validation read. A keyed nonce is read by the protocol, not by EVM code, so
 * it is never in `reads` and is checked here by its NONCE_MANAGER slot. Always
 * true without `reads`, and for a transaction whose validity also depends on
 * time rather than state: an expiry frame, or recent-root references.
 */
export function isAffected(
  tx: FrameTransaction,
  reads: SlotReads | undefined,
  changes: BlockChanges
): boolean {
  if (!reads || tx.recentRootReferences.length > 0) return true;
  if (
    tx.frames.some(
      (frame) => classifyFrame(frame) === FRAME_SUBCLASS.EXPIRY_VERIFY
    )
  ) {
    return true;
  }
  const accounts = [
    tx.sender,
    ...tx.frames
      .filter((frame) => frame.mode === FRAME_MODE.VERIFY)
      .map((frame) => frame.target ?? tx.sender),
    ...Object.keys(reads),
  ];
  if (accounts.some((address) => changes.accounts.has(address.toLowerCase())))
    return true;
  for (const [address, slots] of Object.entries(reads)) {
    for (const slot of slots) {
      if (changes.slots.has(slotId(address, slot))) return true;
    }
  }
  return (
    isKeyedNonce(tx) &&
    tx.nonceKeys.some((key) =>
      changes.slots.has(slotId(NONCE_MANAGER, keyedNonceSlot(tx.sender, key)))
    )
  );
}
