import { describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { FrameTxMempoolEntry } from "../packages/executor/src/entities/FrameTxMempoolEntry";
import { MempoolService } from "../packages/executor/src/services/MempoolService/service";
import { MempoolEntryStatus } from "../packages/types/src/executor";
import {
  APPROVE_SCOPE,
  FRAME_MODE,
  type Frame,
  type FrameTransaction,
} from "../packages/types/src/contracts/FrameTx";

// A4 spike for H-S50 (spec S50): the `OnChain` transition must bump each
// distinct sender/payer/factory `included` count exactly once (self-relay
// counted once via a set).
// Mocks ONLY infrastructure around the unit under test: an in-memory `db`,
// a stub `ReputationService` (records `updateIncludedStatus` calls), and a
// stub event bus. No execution client, no network.

const SENDER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PAYER = "0x2222222222222222222222222222222222222222";
const FACTORY = "0x3333333333333333333333333333333333333333";

function baseFrame(
  mode: number,
  flags: number,
  target: `0x${string}` | null
): Frame {
  return {
    mode: mode as Frame["mode"],
    flags,
    target,
    limits: { execution: BigInt(10_000), state: BigInt(1_000) },
    value: BigInt(0),
    data: "0x",
  };
}

function baseTx(frames: Frame[], sender: string): FrameTransaction {
  return {
    chainId: BigInt(1),
    nonceKeys: [BigInt(0)],
    nonceSeq: BigInt(0),
    sender: sender as `0x${string}`,
    frames,
    signatures: [],
    fees: {
      maxPriorityFeePerGas: BigInt(1),
      maxFeePerGas: BigInt(1),
      maxFeePerBlobGas: BigInt(0),
    },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

function makeService(reputationService: any) {
  const db = {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => null),
    getMany: vi.fn(async () => []),
    del: vi.fn(async () => {}),
  };
  const eventBus = { emit: vi.fn() };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new MempoolService(
    db as any,
    1,
    reputationService,
    eventBus as any,
    {} as any,
    logger as any
  );
  return { service, db, eventBus };
}

describe("H-S50 OnChain bumps included once per distinct address (S50)", () => {
  it(
    "bumps a self-relay sender exactly once on OnChain",
    async () => {
      const reputationService = {
        updateIncludedStatus: vi.fn(async () => {}),
        updateSeenStatus: vi.fn(async () => {}),
      };
      const { service } = makeService(reputationService as any);
      // Self Relay: payer resolves to the sender, so the distinct set is {sender}.
      const entry = new FrameTxMempoolEntry(
        baseTx(
          [baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION_AND_PAYMENT, null)],
          SENDER
        ),
        { txHash: "0xselfrelay" }
      );
      await service.updateStatus([entry], MempoolEntryStatus.OnChain);
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledTimes(1);
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledWith(getAddress(SENDER));
    }
  );

  it(
    "bumps sender, payer and factory exactly once each on OnChain",
    async () => {
      const reputationService = {
        updateIncludedStatus: vi.fn(async () => {}),
        updateSeenStatus: vi.fn(async () => {}),
      };
      const { service } = makeService(reputationService as any);
      // Deploy + Canonical Paymaster: three distinct role addresses.
      const entry = new FrameTxMempoolEntry(
        baseTx(
          [
            baseFrame(FRAME_MODE.DEFAULT, 0, FACTORY),
            baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, SENDER),
            baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, PAYER),
          ],
          SENDER
        ),
        { txHash: "0xthreeroles" }
      );
      await service.updateStatus([entry], MempoolEntryStatus.OnChain);
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledTimes(3);
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledWith(getAddress(SENDER));
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledWith(getAddress(PAYER));
      expect(
        reputationService.updateIncludedStatus
      ).toHaveBeenCalledWith(getAddress(FACTORY));
    }
  );

  it(
    "does not bump included on a non-OnChain transition",
    async () => {
      const reputationService = {
        updateIncludedStatus: vi.fn(async () => {}),
        updateSeenStatus: vi.fn(async () => {}),
      };
      const { service } = makeService(reputationService as any);
      const entry = new FrameTxMempoolEntry(
        baseTx(
          [baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION_AND_PAYMENT, null)],
          SENDER
        ),
        { txHash: "0xsubmitted" }
      );
      await service.updateStatus([entry], MempoolEntryStatus.Submitted, {
        transaction: "0x1234",
      });
      expect(
        reputationService.updateIncludedStatus
      ).not.toHaveBeenCalled();
    }
  );
});
