import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  NODE_A,
  RECIPIENT,
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
  DEV_GENESIS_BANNED_OPCODE_WALLET_ADDRESS,
} from "./helpers.js";
import { FRAME_MODE, APPROVE_SCOPE, SIG_SCHEME, FrameTransaction } from "@skandha/types/lib/contracts/FrameTx.js";

/**
 * Two negative-admission demonstrations, both against the fast `--dev`
 * devnet (Hegota active from genesis - no real mining needed, since a
 * rejected transaction is never supposed to reach a block):
 *
 * 1. A validation-prefix contract that uses an ERC-7562 [OP-011] banned
 *    opcode (TIMESTAMP) - proves the real per-frame ERC-7562 trace pipeline
 *    (ethrex's native tracer, surfaced through `FrameTxSimulationService`/
 *    `FrameTxValidationService`) actually observes and enforces the
 *    banned-opcode set against real execution, not a stub that always
 *    passes. In practice ethrex's own tracer (`FrameSimViolation::
 *    BannedOpcode`) flags this before `FrameTxValidationService`'s own
 *    downstream `checkEntityCompliance` banned-opcode check gets a chance
 *    to - see the assertion below for exactly which layer's message this
 *    observes.
 *
 * 2. A transaction that is fully ERC-7562-clean (the same unconditional-
 *    APPROVE wallet/paymaster contracts the real-inclusion e2e test already
 *    proved work end-to-end) but whose unstaked sender declares more
 *    `limits.execution` than ERC-8421's per-entity budget
 *    (`MAX_VERIFY_GAS_PER_ENTITY`, 100_000, BUDGET-010) allows. That budget
 *    is a mempool admission rule, not a protocol/consensus validity rule
 *    ethrex itself enforces - ethrex would mine this transaction fine.
 *    Rejecting it anyway, on a tx with no banned opcodes and no forbidden
 *    storage access, is exactly what distinguishes the sidecar's mempool as an
 *    EIP-8141-*specific* alternative mempool rather than a thin relay that
 *    only defers to the execution client's own judgment.
 */
describe("frame tx e2e: admission-time rejection", () => {
  let tmpDir: string;
  let dirA: string;
  let nodeA: ChildProcess | undefined;

  const urlA = `http://127.0.0.1:${NODE_A.api}/rpc/`;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skandha-e2e-rejection-"));
    dirA = path.join(tmpDir, "nodeA");
    fs.mkdirSync(dirA, { recursive: true });

    await startDevnet();

    nodeA = spawnNode("nodeA", dirA, NODE_A, []);
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
    "rejects a validation-prefix frame that uses an ERC-7562 banned opcode",
    async () => {
      // Self Relay shape: [self_verify, SENDER]. The self_verify frame's
      // contract calls TIMESTAMP before APPROVE(EXECUTION_AND_PAYMENT) -
      // see DEV_GENESIS_BANNED_OPCODE_WALLET_ADDRESS's doc comment
      // (helpers.ts) for why this is a genesis-preloaded address rather
      // than a live CREATE deploy.
      const tx: FrameTransaction = {
        chainId: BigInt(CHAIN_ID),
        nonceKeys: [0n],
        nonceSeq: 1n, // contract account - starts at nonce 1, not 0
        sender: DEV_GENESIS_BANNED_OPCODE_WALLET_ADDRESS,
        frames: [
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
            target: null,
            limits: { execution: 30_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.SENDER,
            flags: APPROVE_SCOPE.NONE,
            target: RECIPIENT,
            limits: { execution: 50_000n, state: 0n },
            value: 1n,
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
        `expected rejection for a banned-opcode validation frame, got: ${JSON.stringify(sent)}\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeDefined();
      // ethrex's own native ERC-7562 tracer (crates/vm/levm/src/
      // validation_observer.rs's FrameSimViolation::BannedOpcode) flags
      // TIMESTAMP (opcode 0x42 = 66) during the traced simulation pass
      // itself, before FrameTxValidationService's own downstream
      // checkEntityCompliance banned-opcode check ever runs -
      // FrameTxValidationService.validate()'s fail-closed
      // `!simResult.valid` branch surfaces that native violation verbatim.
      // Either layer catching it proves the same thing this test exists to
      // demonstrate: the trace is real and actually walked, not a stub.
      expect(sent.error!.message).toMatch(/BannedOpcode\(66\)|uses banned opcode: TIMESTAMP/);
    },
    120_000
  );

  it(
    "rejects an ERC-7562-clean frame transaction whose unstaked sender exceeds MAX_VERIFY_GAS_PER_ENTITY",
    async () => {
      // Canonical Paymaster shape [only_verify, pay] - both frames are the
      // same unconditional-APPROVE contracts the real-inclusion e2e test
      // proved land on-chain successfully (genesis-preloaded copies - see
      // DEV_GENESIS_WALLET_ADDRESS's doc comment in helpers.ts); no banned
      // opcode, no forbidden storage access. Only difference: the
      // unstaked sender's only_verify frame declares more limits.execution
      // than MAX_VERIFY_GAS_PER_ENTITY (100_000). The budget is per entity
      // (ERC-8421 BUDGET-010), so the payer's frame does not count toward
      // it: 60_000 on each frame, as this test used before, is admitted.
      const tx: FrameTransaction = {
        chainId: BigInt(CHAIN_ID),
        nonceKeys: [0n],
        nonceSeq: 1n,
        sender: DEV_GENESIS_WALLET_ADDRESS,
        frames: [
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.EXECUTION,
            target: null,
            limits: { execution: 120_000n, state: 0n }, // > MAX_VERIFY_GAS_PER_ENTITY, the sender is unstaked
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.VERIFY,
            flags: APPROVE_SCOPE.PAYMENT,
            target: DEV_GENESIS_PAYMASTER_ADDRESS,
            limits: { execution: 60_000n, state: 0n },
            value: 0n,
            data: "0x",
          },
          {
            mode: FRAME_MODE.SENDER,
            flags: APPROVE_SCOPE.NONE,
            target: RECIPIENT,
            limits: { execution: 50_000n, state: 0n },
            value: 1n,
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
        `expected rejection for exceeding MAX_VERIFY_GAS_PER_ENTITY, got: ${JSON.stringify(sent)}\n--- node A log ---\n${tailLog(dirA, "nodeA")}`
      ).toBeDefined();
      expect(sent.error!.message).toMatch(/unstaked sender .*exceeds MAX_VERIFY_GAS_PER_ENTITY/);
    },
    120_000
  );
});
