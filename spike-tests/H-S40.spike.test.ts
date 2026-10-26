import { describe, expect, it } from "vitest";
import { recognizeValidationPrefix } from "../packages/executor/src/services/UserOpValidation/utils/validationPrefix";
import {
  APPROVE_SCOPE,
  FRAME_MODE,
  type Frame,
} from "../packages/types/src/contracts/FrameTx";

// A4 spike for H-S40 — WITHDRAWN by notes/A8-version-and-h-s40.md.
//
// The `it.skip` below is the original A4 assertion. It was wrong against
// EIP-8141: a leading DEFAULT frame IS the `deploy` subclass and
// `[deploy, self_verify]` is one of the four recognized public-mempool shapes,
// so a match is the correct result. The live assertion now records that
// expected behaviour; the real gap (the validator never checks that the deploy
// installed code at tx.sender) is covered by A8-deploy-code.spike.test.ts.
// Pure unit test: no execution client, no mocks, no network.

const SENDER = "0x8888888888888888888888888888888888888888";
const STRANGER = "0x4444444444444444444444444444444444444444";

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

describe("H-S40 stray DEFAULT rejected fail-closed (S40)", () => {
  it.skip(
    "[WITHDRAWN] matches nothing for an adjacent but target-mismatched DEFAULT",
    async () => {
      // [DEFAULT(target=random Q), self_verify(target=sender)]: adjacent but
      // target-mismatched, so per S40 it is neither pre_verify nor deploy.
      const frames = [
        baseFrame(FRAME_MODE.DEFAULT, 0, STRANGER),
        baseFrame(
          FRAME_MODE.VERIFY,
          APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
          SENDER
        ),
      ];
      // Null here is what `FrameTxValidationService.validate` turns into the
      // "frame transaction validation prefix not recognized" rejection.
      expect(recognizeValidationPrefix(frames, SENDER)).toBeNull();
    }
  );
});
