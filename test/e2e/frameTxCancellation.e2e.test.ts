import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  NODE_A,
  CHAIN_ID,
  rpc,
  waitFor,
  spawnNode,
  tailLog,
  startDevnet,
  stopDevnet,
  toWire,
  DEV_GENESIS_WALLET_ADDRESS,
  DEV_GENESIS_PAYMASTER_ADDRESS,
} from "./helpers.js";
import { FRAME_MODE, APPROVE_SCOPE, SIG_SCHEME, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * Proves the explorer's `dropped` outcome (explorer feedback #1 - see
 * docs/superpowers/specs/2026-09-30-explorer-activity-outcomes-design.md)
 * end to end: a transaction is admitted, its payer is then banned via
 * reputation, and the bundler cancels it on its next (manually triggered)
 * bundling pass - all against the fast `--dev` devnet, no real mining
 * needed, matching `frameTxRejection.e2e.test.ts`'s pattern.
 *
 * Uses the Canonical Paymaster shape [only_verify, pay] (not the Self Relay
 * shape) because `BundlingService.shouldRelay`'s banned-entity check only
 * ever looks at the `payer`/`factory` roles, not `sender` - a self-paying
 * sender is explicitly exempt (see that method's own comment).
 */
describe("frame tx e2e: mempool cancellation surfaces as a dropped outcome", () => {
  let tmpDir: string;
  let dirA: string;
  let nodeA: ChildProcess | undefined;

  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-cancellation-"));
    dirA = path.join(tmpDir, "nodeA");
    fs.mkdirSync(dirA, { recursive: true });

    await startDevnet();

    // manual bundling mode (default); --explorer.enable is required for
    // skandha_explorer_listAdmissions below (METHOD_NOT_FOUND otherwise).
    nodeA = spawnNode("nodeA", dirA, NODE_A, [], {}, "manual", ["--explorer.enable"]);
    await waitFor("node A's RPC", 90_000, async () => {
      const r = await rpc(urlA, "eth_chainId");
      return Number(r.result) === CHAIN_ID;
    });
  }, 300_000);

  afterAll(async () => {
    nodeA?.kill("SIGKILL");
    stopDevnet();
  }, 120_000);

  it(
    "cancels an admitted transaction once its payer is banned, and the Activity list shows it dropped",
    async () => {
      // Canonical Paymaster shape, each entity well under
      // MAX_VERIFY_GAS_PER_ENTITY (100_000) so it is admitted cleanly - see
      // frameTxRejection.e2e.test.ts's identical shape for the rejected
      // (over-budget) counterexample.
      const tx: FrameTransaction = {
        chainId: BigInt(CHAIN_ID),
        nonceKeys: [0n],
        nonceSeq: 1n, // contract account - starts at nonce 1, not 0
        sender: DEV_GENESIS_WALLET_ADDRESS,
        frames: [
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.EXECUTION,
            target: null,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.PAYMENT,
            target: DEV_GENESIS_PAYMASTER_ADDRESS,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
        ],
        signatures: [{ scheme: SIG_SCHEME.ARBITRARY, signer: "0x", msg: "0x", signature: "0x" }],
        fees: {
          maxPriorityFeePerGas: 1_000_000_000n,
          maxFeePerGas: 2_000_000_000n,
          maxFeePerBlobGas: 0n,
        },
        blobVersionedHashes: [],
        recentRootReferences: [],
      };

      const sent = await rpc(urlA, "eth_sendFrameTransaction", [toWire(tx)]);
      expect(
        sent.error,
        `expected admission, got an error: ${JSON.stringify(sent)}\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeUndefined();
      const txHash = sent.result as string;

      // Ban the payer: opsSeen=1000, opsIncluded=0 crosses the default ban
      // threshold (minExpectedIncluded = 1000/10 = 100 > 0 + banSlack(50)).
      const banned = await rpc(urlA, "debug_bundler_setReputation", [
        [{ address: DEV_GENESIS_PAYMASTER_ADDRESS, opsSeen: 1000, opsIncluded: 0 }],
        "0x0",
      ]);
      expect(banned.error, `setReputation failed: ${JSON.stringify(banned)}`).toBeUndefined();

      // Manual bundling mode: nothing runs until explicitly told to.
      const bundled = await rpc(urlA, "debug_bundler_sendBundleNow");
      expect(bundled.error, `sendBundleNow failed: ${JSON.stringify(bundled)}`).toBeUndefined();

      await waitFor("the transaction to be cancelled", 30_000, async () => {
        const status = await rpc(urlA, "skandha_frameTransactionStatus", [txHash]);
        return status.result?.status === "Cancelled";
      });

      const activity = await rpc(urlA, "skandha_explorer_listAdmissions", [
        { outcome: "dropped" },
      ]);
      expect(
        activity.result?.items?.some((r: any) => r.txHash === txHash),
        `expected ${txHash} in the dropped outcome list, got: ${JSON.stringify(activity)}`
      ).toBe(true);
    },
    120_000
  );
});
