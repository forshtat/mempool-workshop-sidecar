import { describe, expect, it } from "vitest";
import { recognizeValidationPrefix } from "../packages/executor/src/services/UserOpValidation/utils/validationPrefix";
import {
  APPROVE_SCOPE,
  FRAME_MODE,
  type Frame,
} from "../packages/types/src/contracts/FrameTx";

// A4 spike for H-S38 (spec S38): a DEFAULT frame immediately preceding an
// approving frame with a matching target is `pre_verify`, attributed that
// frame's role; a target mismatch matches nothing.
// Pure unit test: no execution client, no mocks, no network.
// Uses the Deploy + Canonical-Paymaster variant so the leading `deploy` slot
// is occupied and a stray DEFAULT cannot fall back to the deploy position.

const SENDER = "0x1111111111111111111111111111111111111111";
const PAYMASTER = "0x2222222222222222222222222222222222222222";
const FACTORY = "0x3333333333333333333333333333333333333333";
const STRANGER = "0x5555555555555555555555555555555555555555";

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

describe("H-S38 pre_verify target-match and role attribution (S38)", () => {
  it(
    "attributes a target-matching DEFAULT before only_verify the sender role",
    async () => {
      // [deploy(F), pre_verify(DEFAULT, target=P), only_verify(target=P), pay(target=P)]
      const frames = [
        baseFrame(FRAME_MODE.DEFAULT, 0, FACTORY),
        baseFrame(FRAME_MODE.DEFAULT, 0, PAYMASTER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, PAYMASTER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, PAYMASTER),
      ];
      const match = recognizeValidationPrefix(frames, SENDER);
      expect(match).not.toBeNull();
      expect(match!.frames.map((f) => f.role)).toEqual([
        "factory",
        "sender",
        "sender",
        "payer",
      ]);
      expect(match!.frames[1].frameIndex).toBe(1);
      expect(match!.frames[1].role).toBe("sender");
    }
  );

  it(
    "matches nothing when the adjacent DEFAULT target mismatches",
    async () => {
      // Same shape but the middle DEFAULT targets a stranger: it is neither
      // pre_verify (target mismatch) nor a second deploy (leading slot taken).
      const frames = [
        baseFrame(FRAME_MODE.DEFAULT, 0, FACTORY),
        baseFrame(FRAME_MODE.DEFAULT, 0, STRANGER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, PAYMASTER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, PAYMASTER),
      ];
      expect(recognizeValidationPrefix(frames, SENDER)).toBeNull();
    }
  );
});
