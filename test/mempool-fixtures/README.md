# EELS `mempool_test` fixture runner (playground)

Runs fixtures in the execution-specs PR #4073 format against an EVM backend and compares the pool's verdict with the fixture's `broadcast`.

```
bun test/mempool-fixtures/run.ts <fixture.json|dir> [--rpc http://localhost:8545] [--filter substr]
```

Backend today: an ethrex node exposing `testing_validateTransactionV1` (forshtat/ethrex, branch `sim-overrides`). The fixture's `pre` becomes a State Override Set, so one node serves every fixture without restarts.

Fill the fixtures with the node's chain ID: `uv run fill --fork Bogota tests/mempool --chain-id 1337`.

Limits: the verdict is ethrex's `public-mempool-v1` verdict, not Skandha's. Fixtures from EELS `forks/bogota` use a single `nonce`; the runner re-encodes them for ethrex bogota-devnet-2 (EIP-8250 `nonce_keys`), which is only sound where the signature hash does not matter.
