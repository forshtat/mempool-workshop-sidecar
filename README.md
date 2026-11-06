<div align="center">
  <h1>ERC-8421 Mempool Sidecar</h1>
  <p><b>A TypeScript bundler and P2P sidecar for EIP-8141 frame transactions</b></p>
</div>

> [!IMPORTANT]
> This is a fork of [Etherspot's Skandha](https://github.com/etherspot/skandha), an ERC-4337
> Account Abstraction bundler. This fork does not implement ERC-4337 — it targets
> [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141), a proposed native Ethereum transaction type
> that replaces the contract-level `UserOperation`/`EntryPoint` model with protocol-native
> validation and execution.

**🔭 [Explore the public devnet](https://explorer.altmempool.wtf/)** — a live view of the
mempool, admission reports and peers for both instances below. No setup required.

## What this is

The sidecar exposes an `eth_sendFrameTransaction` JSON-RPC API, validates and simulates frame
transactions against an execution client, relays them on-chain, and — optionally — gossips them
between bundler nodes over a libp2p peer-to-peer mempool.

There is no `EntryPoint` contract and no `eth_sendUserOperation`. A frame transaction is validated
and relayed largely as-is, rather than assembled into a batch.

Because EIP-8141 is not yet live on any public network, running the sidecar requires an execution
client that implements it. [ethrex](https://github.com/lambdaclass/ethrex)'s `eip8141-tracer`
branch is currently the only one that does; a standard client such as geth cannot validate or
simulate frame transactions at all.

## Running from source

```sh
bun install
bun run build
cp config.json.default config.json
```

Edit `config.json`:

- point `rpcEndpoint` and `rpcEndpointSubmit` at an EIP-8141-aware execution client
- set `relayers` to the private key(s) that will submit transactions on-chain

Then start the bundler:

```sh
./skandha standalone
```

The RPC API is available at `http://localhost:14337/rpc/`.

For a local devnet to develop against, see [P2P.md](./P2P.md) — it walks through running
[ethrex](https://github.com/lambdaclass/ethrex) via `test/e2e/ethrex-devnet.sh` and connecting
The sidecar to it.

## Running with Docker

```sh
cp config.json.default config.json
# edit config.json
docker build -t skandha .
docker run \
  --mount type=bind,source="$(pwd)"/config.json,target=/usr/app/config.json,readonly \
  -dp 14337:14337 \
  skandha standalone
```

## CLI options

| Flag | Description | Default |
|---|---|---|
| `--configFile <path>` | Path to the config file | `./config.json` |
| `--dataDir <path>` | Path to the data directory | `~/.skandha/db/` |
| `--redirectRpc` | Proxy standard `eth_*` calls straight to the underlying execution client | `false` |
| `--executor.bundlingMode manual\|auto` | Relay transactions on an interval (`auto`), or only on demand (`manual`). Either way the node keeps following the chain, so transactions it holds are marked `OnChain`/`Reverted` when they are mined, including by another node | `auto` |
| `--api.port <port>` | RPC server port | `14337` |
| `--metrics.enable` | Enable Prometheus metrics | `false` |
| `--metrics.host <host>` | Metrics server host | `127.0.0.1` |
| `--metrics.port <port>` | Metrics server port | `8008` |
| `--unsafeMode` | Vestigial — currently only affects EIP-2930 transaction-type selection | `false` |

Run `./skandha standalone --help` or `./skandha node --help` for the full list.

## Configuration

`entryPoints`, `canonicalEntryPoint`, and `supportedMempools[].entryPoint` must all be set to the
fixed EIP-8141 sentinel address below — not a deployed contract. Leaving one of them at a stale
ERC-4337-style address will silently disable gossip publishing when running in `node` mode.

```json
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    {
      "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa"
    }
  ],
  "relayers": ["0x{RELAYER_PRIVATE_KEY}"],
  "rpcEndpoint": "http://localhost:8545"
}
```

`relayers` and a few other fields can also be set via environment variables instead of the config
file — `SKANDHA_RELAYERS`, `SKANDHA_BENEFICIARY`, `SKANDHA_RPC`, and similar.

### Full reference

```jsonc
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa", // must match entryPoints[0]
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    {
      "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa"
    }
  ],
  "relayers": ["0x{RELAYER_PRIVATE_KEY}"],
  "beneficiary": "0x{FEE_COLLECTOR_ADDRESS}", // optional, defaults to the relayer
  "rpcEndpoint": "http://localhost:8545",
  "rpcEndpointSubmit": "", // optional, used only when submitting a relayed transaction
  "minInclusionDenominator": 10, // optional, ERC-7562 reputation parameter
  "throttlingSlack": 10, // optional, ERC-7562 reputation parameter
  "banSlack": 50, // optional, ERC-7562 reputation parameter
  "minStake": 10000000000, // optional, minimum entity stake in wei
  "minUnstakeDelay": 0, // optional, minimum entity unstake delay
  "stakingRegistryAddress": "0x...", // optional, EIP-8421 IStakingRegistry contract address; unset/zero means every entity reads as unstaked
  "maxVerifyGasPerEntity": 100000, // optional, ERC-8421 BUDGET-010 budget for an unstaked entity's validation frames (env SKANDHA_MAX_VERIFY_GAS_PER_ENTITY)
  "maxVerifyGasStakedEntity": 1000000, // optional, ERC-8421 BUDGET-010 budget for a staked entity (env SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY); both are reported by skandha_config.budgets
  "minSignerBalance": 1, // optional, minimum relayer balance (in ETH) before it stops being used as a fee collector
  "multicall": "0xcA11bde05977b3631167028862bE2a173976CA11", // optional, multicall3 contract address
  "estimationStaticBuffer": 21000, // optional, gas added to callGasLimit on estimation
  "receiptLookupRange": 1024, // optional, block range searched by getFrameTransactionByHash/getFrameTransactionReceipt
  "etherscanApiKey": "", // optional, used to fetch gas prices
  "conditionalTransactions": false, // optional
  "gasPriceMarkup": 0, // optional, markup applied to skandha_getGasPrice, in bps (500 = 5%)
  "enforceGasPrice": false, // optional, reject transactions priced below the network gas price
  "enforceGasPriceThreshold": 1000, // optional, allowed shortfall in bps when enforceGasPrice is set
  "eip2930": false, // optional
  "useropsTTL": 300, // optional, mempool entry time-to-live in seconds
  "whitelistedEntities": { // optional, addresses exempt from stake and opcode validation
    "factory": [],
    "paymaster": [],
    "account": []
  },
  "maxConcurrentSubmissions": 10, // optional, maximum in-flight relay submissions
  "bundleInterval": 10000, // interval (ms) between relay passes in auto mode
  "maxSubmitAttempts": 3, // optional, resubmission attempts before an entry is cancelled
  "bundleSize": 4, // optional, maximum transactions relayed per pass
  "pvgMarkup": 0 // optional, gas added on top of the estimated pre-verification gas
}
```

## Keyed nonces and recent roots (EIP-8250 / EIP-8272)

Frame transactions carry an [EIP-8250](https://eips.ethereum.org/EIPS/eip-8250) keyed nonce and,
optionally, [EIP-8272](https://eips.ethereum.org/EIPS/eip-8272) recent-root references. Together
they let one sender, such as a privacy pool contract, have many independent transactions in
flight: each uses its own nonce key (for example derived from a nullifier) and proves against a
root the sender published on chain.

**RPC fields** (`eth_sendFrameTransaction`, `eth_estimateFrameTransactionGas`, all hex):

| Field | Meaning |
| --- | --- |
| `nonceKeys` | 1 to 16 strictly increasing keys. `["0x0"]` is the sender's ordinary account nonce; other keys are tracked in the `NONCE_MANAGER` predeploy (`0x…8250`). Key 0 is only valid on its own. |
| `nonceSeq` | Must equal the current sequence of every key in `nonceKeys`. |
| `recentRootReferences` | Optional, up to 16 `{ sourceId, slot, root }`. Each must be committed in `RECENT_ROOT_ADDRESS` (`0x…8272`) and usable: `1 ≤ head_slot + 1 − slot ≤ 8191`. |
| `nonce` | Legacy shorthand for `nonceKeys: ["0x0"], nonceSeq: nonce`. Send either this or the pair, not both. |

Transactions returned by the RPC (`eth_getFrameTransactionByHash`, `debug_bundler_dumpMempool`)
carry `nonceKeys`/`nonceSeq`/`recentRootReferences`.

**Mempool rules.** This alt-mempool deliberately keeps them minimal:

- **Slots.** A linear (`["0x0"]`) transaction occupies `sender:nonceSeq`, as before. A keyed one
  occupies its exact key set plus `nonceSeq`. A transaction in an occupied slot is a replacement
  and needs a 10% fee bump.
- **One pending transaction per `(sender, key)`.** A keyed transaction sharing any key with a
  pending one in another slot is rejected (`nonce key … is already held by pending transaction …`).
  Disjoint key sets coexist freely, and linear and keyed transactions of one sender do not block
  each other.
- **No per-sender cap on keyed transactions.** They cannot block each other at the nonce level.
  Linear transactions keep the per-sender limit (4), counted among linear transactions only.
  Third-party payers and factories are capped as before.
- **Balances.** Pending transactions never owe an account more than its balance. A payer owes
  each transaction's maximum gas cost, and a sender owes the `value` of its top-level frames.
  Checked at admission, and every block (newest entries are dropped first when a balance falls).
- **Recent roots.** The slot window is checked before simulation, and commitment by the
  simulation. Entries whose reference expires are evicted each block, and ones about to expire
  are not relayed. Failures appear under the explorer's `recent-root` rule.

This changes the P2P wire format: see [P2P.md](./P2P.md#wire-format-version).

## Shared mempool (P2P)

Running `./skandha node` instead of `./skandha standalone` joins a libp2p network that gossips
frame transactions between bundler nodes (gossipsub for propagation, discv5 for peer discovery).
See [P2P.md](./P2P.md) for a full walkthrough — a boot node, a second node peering with it, and a
frame transaction propagating by gossip between them.

## Public devnet

A public EIP-8141 devnet is running at `https://altmempool.forshtat.com`, with real mainnet
contracts (LINK, USDT, BAYC so far) predeployed at fixed addresses for testing against. A second
sidecar instance, `https://altmempoolgateway.forshtat.com`, gossips transactions to it over p2p, so
sending to either one tests the network end to end. See
[devnet-readme.md](./deploy/devnet/devnet-readme.md) for how to connect, and
[deployments/devnet.md](./deployments/devnet.md) for the canonical addresses and how they were
deployed.

**[explorer.altmempool.wtf](https://explorer.altmempool.wtf/)** is a web explorer
for both instances: the live mempool, every admission with the rule-by-rule reason a transaction
was accepted or turned away, and p2p peers — see
[packages/devnet-ui](./packages/devnet-ui/README.md).

## License

Licensed under the [MIT License](./LICENSE).

## Acknowledgements

This project builds on [Etherspot's Skandha](https://github.com/etherspot/skandha) and its use of
[lodestar](https://github.com/ChainSafe/lodestar)'s libp2p networking stack, and on tooling from
[eth-infinitism](https://github.com/eth-infinitism).
