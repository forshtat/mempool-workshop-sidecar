import { describe, expect, it } from "vitest";
import { recognizeValidationPrefix } from "../packages/executor/src/services/UserOpValidation/utils/validationPrefix";
import {
  APPROVE_SCOPE,
  FRAME_MODE,
  type Frame,
} from "../packages/types/src/contracts/FrameTx";

// A4 spike for H-S37 (spec S37): each canonical prefix shape gains up to 2
// independently-optional `pre_verify` insertion points (12 concrete variants),
// matched by one algorithm, not hardcoded patterns.
// Pure unit test: no execution client, no mocks, no network.

const SENDER = "0x1111111111111111111111111111111111111111";
const PAYMASTER = "0x2222222222222222222222222222222222222222";

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

describe("H-S37 pre_verify shape variants recognized (S37)", () => {
  it(
    "recognizes Canonical-Paymaster pre_verify before only_verify with role sender",
    async () => {
      // [pre_verify(DEFAULT, target=P), only_verify(target=P), pay(target=P)]
      const frames = [
        baseFrame(FRAME_MODE.DEFAULT, 0, PAYMASTER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.EXECUTION, PAYMASTER),
        baseFrame(FRAME_MODE.VERIFY, APPROVE_SCOPE.PAYMENT, PAYMASTER),
      ];
      const match = recognizeValidationPrefix(frames, SENDER);
      // Spec S37: the algorithm accepts this variant ...
      expect(match).not.toBeNull();
      // ... with the DEFAULT frame attributed the sender role (S38), and the
      // pay frame as the payer frame.
      expect(match!.payerFrameIndex).toBe(2);
      expect(match!.frames.map((f) => f.role)).toEqual([
        "sender",
        "sender",
        "payer",
      ]);
      expect(match!.frames.map((f) => f.frameIndex)).toEqual([0, 1, 2]);
    }
  );
});
