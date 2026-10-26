# spike-tests — mocked-simulation probes for frame-transaction admission

Research probes, not shipped tests. They are excluded from every existing suite and from CI:
they live at the repo root, use their own config, and only files matching
`spike-tests/**/*.spike.test.ts` are collected. Nothing under `packages/` is modified.

## Run

```sh
bunx vitest run --config spike-tests/vitest.spike.config.ts
```

Single file: append the hypothesis name, e.g.

```sh
bunx vitest run --config spike-tests/vitest.spike.config.ts A12
```

Keep a `timeout 300` wrapper on a cold cache: the first run that pulls the
`MempoolService` import graph into Vite's dep pre-bundling can take ~3 minutes before
the tests themselves execute in under 10 ms.

## Why this config exists

`packages/executor/src/**` imports workspace code through built output, e.g.
`packages/executor/src/modules/eth.ts`: `import RpcError from "@skandha/types/lib/api/errors/rpc-error"`.
No package here ships a built `lib/`, so those specifiers are unresolvable without running
`bun run build`. `vitest.spike.config.ts` instead aliases `@skandha/<pkg>/lib/<path>` (and the
`.js` suffix) onto `packages/<pkg>/src/<path>`, so the probes exercise real implementation code
with no build step and no edit to any package.

The execution client is mocked at its RPC boundary: every probe builds an
`EthrexSimulateFrameTransactionResult` by hand and passes it to the real validator/mempool code.
No network, no Docker, no anvil. (`packages/executor/test/fixtures/*` is deliberately not used —
it spawns `anvil` through `child_process`.)

## Results on `master` @ `2e22ff0`

`Test Files 4 failed | 5 passed | 1 skipped`, `Tests 5 failed | 8 passed | 1 skipped`.

The five failures are marked `it.fails`: they assert behaviour the specification requires and the
code does not implement today, so a green run means "the divergence is still there". If someone
fixes one, that test starts **failing** — which is the signal to flip it back to a plain `it`.

| File | Asserts | Today |
|---|---|---|
| `H-S37` | the four `pre_verify`-inserted prefix variants are recognised | passes |
| `H-S38` | `pre_verify` target match + role attribution | passes (2) |
| `H-S40` | a leading DEFAULT is the `deploy` subclass (EIP-8141) — the original hypothesis was withdrawn in review | passes; the withdrawn assertion is `it.skip` |
| `H-S45` | a `pre_verify` frame whose target has no deployed code is rejected | **`it.fails`** — admitted |
| `H-S50` | `OnChain` bumps each distinct entity's `included` count once | passes (3) |
| `A6` | TIMESTAMP read inside `EXPIRY_VERIFIER` code is not a banned opcode | **`it.fails`** — rejected as `sender uses banned opcode: TIMESTAMP` |
| `A8` | a client-reported `canonicalMempoolViolation` is not discarded (`DeployInstalledNoCode`, `CallToNonexistentOrDelegated`) | **`it.fails`** (2) — both admitted |
| `A12` | a prefix that never sets a payer is rejected | **`it.fails`** — admitted |
| `harness`, `probe-import` | tooling smoke tests (vitest + `ethers` resolve; the alias map loads `Eth` from source) | pass |

The `it.fails` probes share one root cause worth stating plainly, because it is easy to misread
them as four separate bugs: `FrameTxValidationService.validate` deliberately ignores
`canonicalMempoolValid` and re-derives the rules from the trace alone, and its re-derivation does
not cover the deploy-installed-code condition at all, nor a trace that omits a called address.
`A8` and `A12` are the admission side of that; `A6` is the opposite direction (an over-rejection
of a transaction the client permits); `H-S45` depends on an unresolved question about the trace
shape and is the weakest of the five.

## What these are not

No vulnerability is claimed. Each probe is a short input, an expected result, and an observed
one. Where the reachability of a divergence depends on unverified client behaviour it is stated
in the file header rather than assumed.
