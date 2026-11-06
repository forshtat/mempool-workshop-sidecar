# Hegota / EIP-8141 public devnet

A public, demonstration-only Ethereum devnet for trying out **EIP-8141 frame transactions** and an
**alternative (frame-tx) mempool**. It runs an ethrex fork (execution) with Lighthouse (consensus),
plus a sidecar fork that acts as the frame-transaction mempool and relay.

> **This is a throwaway network.** It has no security model, a small faucet, no persistence guarantee,
> and may be reset or redeployed at any time. Do not send anything of value to it. Several admin
> surfaces are deliberately left open (see [Known limitations](#known-limitations)).

- [1. Connecting](#1-connecting)
- [2. Sending your first transactions](#2-sending-your-first-transactions)
- [3. Frame transaction cheat sheet](#3-frame-transaction-cheat-sheet)
- [4. How the devnet is built](#4-how-the-devnet-is-built)
- [5. Non-standard APIs: sidecar](#5-non-standard-apis-sidecar)
- [6. Non-standard APIs: ethrex fork](#6-non-standard-apis-ethrex-fork)
- [7. Running your own node against it](#7-running-your-own-node-against-it)
- [8. Predeployed contracts](#8-predeployed-contracts)
- [Known limitations](#known-limitations)

---

## 1. Connecting

| | |
|---|---|
| **RPC (ethrex)** | `https://altmempool.forshtat.com` |
| **Frame-tx mempool / bundler RPC (the sidecar)** | `https://altmempool.forshtat.com/rpc` |
| **Sidecar WebSocket** | `wss://altmempool.forshtat.com/rpc` |
| **Chain ID** | `1337` (`0x539`) |
| **Block time** | 6 seconds (`SLOT_DURATION_MS=6000`) |
| **Currency** | ETH (devnet, worthless) |
| **Faucet** | "Faucet" button in the explorer, or `skandha_explorer_faucet` - see below |

Both HTTPS routes accept `POST` with a JSON-RPC 2.0 body and send permissive CORS headers
(`access-control-allow-origin: *`), so browser tooling works. Plain HTTP redirects to HTTPS.

Which URL should I use?

- **Root URL (`/`)** talks to ethrex directly. Use it for everything standard (`eth_*`, `net_*`,
  `web3_*`, `txpool_*`), for legacy/1559 transactions, and for the `ethrex_*` and `debug_*`
  methods in [section 6](#6-non-standard-apis-ethrex-fork).
- **`/rpc`** talks to the sidecar. Use it to submit frame transactions into the alt mempool and to
  follow them ([section 5](#5-non-standard-apis-sidecar)). The sidecar also proxies a whitelist of
  standard read methods to ethrex (`eth_blockNumber`, `eth_getBalance`, `eth_call`,
  `eth_getTransactionCount`, `eth_sendRawTransaction`, and so on), but not the whole API - for
  anything unusual, use the root URL. The sidecar answers `-32601` for `eth_syncing` and
  `eth_supportedEntryPoints`.

Quick check:

```sh
curl -s -X POST https://altmempool.forshtat.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# {"id":1,"jsonrpc":"2.0","result":"0x539"}
```

### Getting funds

Ask the faucet: press **Faucet** in the explorer, or call `skandha_explorer_faucet` with your
address (1 ETH, once per hour per address; see
[`docs/sidecar_explorer.md`](../../docs/sidecar_explorer.md#skandha_explorer_faucet)):

```sh
curl -s https://altmempoolgateway.forshtat.com/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_explorer_faucet","params":["0xYourAddress"]}'
```

The faucet account is **not** the genesis account. The genesis account (below) is published in this
repo and also the node's relayer, so anyone can spend it; treat it as an operator key, move most of
its ETH to a private faucet account, and give the node that account's key in `SKANDHA_FAUCET_KEY`.

For reference, the account funded at genesis, with 1,000,000 ETH:

```
address:     0x5544596212F91984C986A919C8026DF0576816f9
private key: 0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15
```

This is a throwaway devnet key, committed on purpose in this repo
(`deploy/devnet/genesis.values.env`, and `MINING_SENDER_PRIVATE_KEY` in `test/e2e/helpers.ts`).
**Never use it, or any key derived from it, on a real network.**

### Testing a staked entity end-to-end

The `NaiveStakingRegistry` is deployed at `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` (see
[Predeployed contracts](#8-predeployed-contracts); canonical record:
[deployments/devnet.md](../../deployments/devnet.md)).

**The registry keys everything off `msg.sender` - stake the role's own address, not just "your
key":**

- A plain EOA `sender` (the Self Relay shape, where `sender` is also its own `payer`) can call
  `addStake` directly from your own funded key - the staked address and the signing key are the
  same thing.
- A `payer`/`factory` **contract** (the Canonical Paymaster shape's pay-frame target, or a
  deploy-frame's factory) can't be staked by you calling `addStake` from your own key - that
  would only stake *your* EOA, not the contract. The contract itself has to call `addStake` as
  part of its own logic (`msg.sender` inside that call is the contract). None of the devnet's
  existing demo wallet/paymaster contracts (`WALLET_INIT_CODE`/`PAYMASTER_INIT_CODE` in
  `test/e2e/helpers.ts`) do this - staking a contract entity needs a purpose-built contract with
  an `addStake` forwarding call, which doesn't exist yet.

Walkthrough (Self Relay shape, the only one directly staked by a plain EOA key):

1. Fund your own key from the faucet (see above).
2. Call `addStake(86400)` (one day, `MIN_UNSTAKE_DELAY` per ERC-8421) on the deployed
   `NaiveStakingRegistry` from that key, sending **more than** `minStake` as `value` - the
   `BALANCE`/`SELFBALANCE` carve-out specifically checks `stake > minStake` (strictly greater),
   not `>=` like every other staked-entity threshold, so staking exactly `minStake` gets you
   every other carve-out but not that one. Check `packages/executor/src/config.ts`'s `minStake`
   default, or your node's actual configured value.
3. Submit a frame transaction using the Self Relay shape (`[self_verify]`) from that same key as
   `tx.sender`.
4. Check the admission's rule report (`skandha_explorer_getTransaction`, if the node has
   `--explorer.enable`, or the RPC error/success itself) for evidence the staked-entity
   carve-outs applied: wider associated-storage access, `BALANCE`/`SELFBALANCE` allowed, and
   `MAX_VERIFY_GAS_STAKED_ENTITY` (not the tighter unstaked `MAX_VERIFY_GAS_PER_ENTITY`) as the
   effective gas cap for that entity's validation frames.
5. `unlockStake()` to initiate a withdrawal, then, after the delay, `withdrawStake(yourAddress)`
   to get the ETH back. Calling `unlockStake()` alone immediately drops every staked-entity
   carve-out from step 4 - the registry's own `withdrawTime` going non-zero disqualifies the
   entity right away, per ERC-8421's STAKING-010, even though the stake itself is still sitting
   in the contract until `withdrawStake` is called. The Reputation tab in the explorer
   (`skandha_explorer_listReputation`) shows this as an "unlocking" label distinct from "staked",
   so you can see the state change without re-running a transaction.

The node's own `config.json` needs `stakingRegistryAddress` (or the
`SKANDHA_STAKING_REGISTRY_ADDRESS` env var) pointing at the deployed address for any of this to
matter - otherwise every entity still reads as unstaked. **Never stake from the shared genesis
key or the published deployer key** (see [Predeployed contracts](#8-predeployed-contracts)) -
anyone holding those keys can `unlockStake`/`withdrawStake` it out from under you.

---

## 2. Sending your first transactions

### 2.1 A plain transfer (mind the gas!)

This network runs the Amsterdam+ resource-based gas model (EIP-2780 / EIP-8037). A transfer to a
**brand-new account** costs an extra 183,600 state gas for creating the account, so the classic
`gas: 21000` **fails** (receipt `status: 0x0`, value not delivered). Budget **at least 204,600**
gas; 250,000 is a comfortable limit. A transfer to an account that already exists still costs
21,000.

```sh
# sign a legacy transfer offline (viem/cast/ethers), with gas: 250000, then:
curl -s -X POST https://altmempool.forshtat.com \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_sendRawTransaction","params":["0x<signed raw tx>"]}'
```

Legacy and EIP-1559 transactions go through ethrex (root URL, or `/rpc`, which redirects
`eth_sendRawTransaction` to ethrex). This also matters for frame transactions: a factory or
paymaster contract has to be deployed with an ordinary transaction first.

### 2.2 A frame transaction

Submit the JSON form of the transaction to the sidecar with `eth_sendFrameTransaction`:

```sh
curl -si -X POST https://altmempool.forshtat.com/rpc \
  -H 'content-type: application/json' \
  --data @frametx.json
```

where `frametx.json` is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_sendFrameTransaction",
  "params": [
    {
      "chainId": "0x539",
      "nonce": "0x6",
      "sender": "0x5544596212F91984C986A919C8026DF0576816f9",
      "frames": [
        { "mode": 1, "flags": 3, "target": null,
          "limits": { "execution": "0x7530", "state": "0x0" }, "value": "0x0", "data": "0x" },
        { "mode": 2, "flags": 0, "target": "0x5544596212F91984C986A919C8026DF0576816f9",
          "limits": { "execution": "0xc350", "state": "0x0" }, "value": "0x1", "data": "0x" }
      ],
      "signatures": [
        { "scheme": 1, "signer": "0x", "msg": "0x",
          "signature": "0x00<r: 32 bytes><s: 32 bytes>" }
      ],
      "fees": {
        "maxPriorityFeePerGas": "0x3b9aca00",
        "maxFeePerGas": "0x77359400",
        "maxFeePerBlobGas": "0x0"
      },
      "blobVersionedHashes": []
    }
  ]
}
```

This is a self-relay: frame 0 is a `VERIFY` frame that approves both execution and payment (the
sender pays its own gas, `flags: 3`), and frame 1 is a `SENDER` frame that moves 1 wei. The
signature is over the canonical signature hash and is packed as
`<1 byte y-parity (0/1)><r><s>`. The helpers that build and sign this exact shape are in the
repo: `buildUnsignedFrameTx`, `signFrameTx` and `toWire` in `test/e2e/helpers.ts`, backed by
`computeSigHash` in `packages/executor/src/services/FrameTxService/codec.ts`.

The response is the transaction hash. Follow it:

```sh
# Sidecar view: Submitted -> OnChain (typically ~10 s)
curl -s -X POST https://altmempool.forshtat.com/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"skandha_frameTransactionStatus","params":["0x<hash>"]}'

# Per-frame receipt
curl -s -X POST https://altmempool.forshtat.com/rpc -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getFrameTransactionReceipt","params":["0x<hash>"]}'

# ethrex's own receipt (block number, gasUsed, frameReceipts[])
curl -s -X POST https://altmempool.forshtat.com -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["0x<hash>"]}'
```

A frame transaction of exactly this shape was verified live against this devnet
(`0xc814c6cbce00a9375e98f8213cfbb795315f271e3516ec37c2e788c2e8d6bdb3`, block `0x10d18`, both
frames `success`).

### 2.3 Dry-run before you send

Two ways to check a frame transaction without submitting it:

- `eth_estimateFrameTransactionGas` on `/rpc` - per-frame gas limits with markup applied.
- `ethrex_simulateFrameTransaction` on the root URL - ethrex's own admission check plus full
  execution, optionally with a validation trace. Takes the RLP-encoded raw transaction
  (`0x06 || rlp(...)`), not the JSON form. See [section 6](#61-ethrex_simulateframetransaction).

---

## 3. Frame transaction cheat sheet

Enough to read the examples; the protocol itself is EIP-8141 (draft).

**Frame `mode`** (`FRAME_MODE`):

| Value | Name | Meaning |
|---|---|---|
| `0` | `DEFAULT` | Ordinary call frame |
| `1` | `VERIFY` | Validation frame. Must call `APPROVE` to grant the scope in `flags`; part of the *validation prefix* the mempool simulates |
| `2` | `SENDER` | Body frame, executed with `tx.sender` as caller |

**Frame `flags`** (`APPROVE_SCOPE`): bits 0-1 are the approval scope - `0` none, `1` payment,
`2` execution, `3` execution and payment. Bit 2 (`0x4`) is the atomic-batch flag.

**`target: null`** resolves to `tx.sender`.

**Frame `limits`**: `execution` and `state` gas are limited separately, per frame. A frame that
creates a new account needs a non-zero `state` limit; with `state: 0` such a frame silently fails
and drags the transaction's top-level result to failure. Sending value to an *existing* account
(as in the example above) needs no state gas.

**Signature `scheme`** (`SIG_SCHEME`): `0` ARBITRARY (no crypto check; the signer's contract logic
decides), `1` SECP256K1, `2` P256. `signer: "0x"` means `tx.sender`; `msg: "0x"` means the
canonical signature hash.

**Recognised validation-prefix shapes** include the self-relay shape above and the *canonical
paymaster* shape `[VERIFY(EXECUTION) on sender, VERIFY(PAYMENT) on paymaster, SENDER…]`. The
mempool rules (banned opcodes, associated storage, staking/reputation per role) are derived from
ERC-7562 and specified in `docs/plans/2026-09-02-erc7562-native-aa-mempool-spec.md`.

### Primitive demo contracts

For trying the factory/paymaster paths, `test/e2e/helpers.ts` contains two deliberately trivial,
signature-less contracts (`APPROVE` is opcode `0xaa`):

| Contract | Init code | Runtime |
|---|---|---|
| `WALLET_INIT_CODE` | `0x6007600c60003960076000f3600260006000aa` | unconditional `APPROVE(EXECUTION)` |
| `PAYMASTER_INIT_CODE` | `0x6007600c60003960076000f3600160006000aa` | unconditional `APPROVE(PAYMENT)` |

Gotchas (each cost a CI round to find):

- **A `SENDER` frame that creates an account needs a `state` limit above 0.** Under the Amsterdam
  rules a value transfer to an address with no account yet charges *state* gas, a budget separate
  from `execution`. With `limits.state = 0` the frame halts and burns its whole execution limit
  (a 500,000 `execution` limit was consumed, status reverted), so raising only `execution` does
  not help. `limits: { execution: 0x7a120, state: 0x30d40 }` succeeded for a 1 wei transfer to a
  fresh address (the body frame itself used about 3,000 gas). Transfers to existing accounts do
  not need it.
- **More nonce keys cost more validation gas.** A `VERIFY` frame with 7 nonce keys ran out of gas
  at `0x7530` (30,000) and succeeded at `0x13880` (80,000). An unstaked sender's verification gas
  budget (`MAX_VERIFY_GAS_PER_ENTITY`) is 100,000, so the headroom shrinks toward the 16-key
  maximum. A staked sender gets `MAX_VERIFY_GAS_STAKED_ENTITY` (1,000,000) instead.
- **Fund a paymaster via the `value` of its `CREATE`**, never by a later plain transfer. Any
  external call, even an empty-calldata transfer, runs the contract's runtime code, which calls
  `APPROVE` outside a frame context and halts - so the transfer silently reverts.
- A freshly `CREATE`d contract account starts at **nonce 1**, not 0. Use `nonce: "0x1"` for the
  first frame transaction from such a wallet.
- Give a wallet contract a non-zero balance if a `SENDER` frame transfers value from it.

---

## 4. How the devnet is built

### 4.1 Topology

```
                  Internet
                     |
        altmempool.forshtat.com  (A -> 34.67.41.151, static IP, DNS-only)
                     |  :80/:443
   +-----------------+---------------- GCP VM "eip8141-miner" (e2-standard-4, us-central1-a) --+
   |                 v                                                                        |
   |            Caddy (auto TLS, Let's Encrypt)                                                |
   |              |  /rpc*  -> localhost:14337                                                 |
   |              |  else   -> localhost:8545                                                  |
   |              v                          v                                                 |
   |   The sidecar (systemd, bun)  ------>  ethrex (docker)  <--Engine API :8551-->  Lighthouse   |
   |   node mode, auto bundling   JSON-RPC :8545                 beacon-1 + beacon-2 + VC      |
   |   :14337 RPC/WS, :4337 p2p                                                                |
   +------------------------------------------------------------------------------------------+
        ^ :4337 tcp/udp (sidecar p2p, open)              ^ :8545 (ethrex RPC, also open directly)
```

Everything runs on one VM, `eip8141-miner`, in GCP project `hegota-mempool-devnet`.

| Component | How it runs | Notes |
|---|---|---|
| **ethrex** | Docker, image `ghcr.io/forshtat/ethrex:eip8141-tracer-latest` | Fork of ethrex with EIP-8141 frame transactions, a native ERC-7562 frame tracer and two `ethrex_*` RPC methods. Sync mode `full`. Branch `eip8141-tracer` of `forshtat/ethrex`. |
| **Lighthouse** | Docker, `ethpandaops/lighthouse:focil` | Two beacon nodes plus one validator client with 32 validators. Two beacon nodes because a solo Lighthouse can never leave `SyncState::Stalled` (needs a synced peer) and so never builds a first block; the second, validator-less node satisfies the peer requirement. |
| **Sidecar** | systemd unit `skandha-miner`, `bun … skandha.js node` | Heavily modified fork of an ERC-4337 bundler that handles EIP-8141 frame transactions instead of ERC-4337 UserOperations. `--executor.bundlingMode auto`, `--redirectRpc`, RPC and WS on `:14337`, libp2p on `:4337`. Branch `master` of `forshtat/mempool-workshop-sidecar`. |
| **Caddy** | systemd | TLS termination and the path-based routing shown above. |
| **Genesis** | one-shot containers `ethpandaops/ethereum-genesis-generator:6.1.6` and `eth2-val-tools` | Genesis files and validator keystores generated once at first bring-up. |

Files: `deploy/devnet/docker-compose.yml`, `genesis.values.env` and the operator runbook in
`deploy/devnet/README.md`. A second VM, `eip8141-gateway` (e2-micro), runs a gateway sidecar node
that accepts frame transactions and gossips them over p2p to the miner (see "Gateway node" there).

### 4.2 Fork schedule

`mainnet` preset, 6-second slots (a 192-second epoch), genesis on 2026-09-16 22:08:27 UTC.

| Fork (CL name / EL name) | When | Timestamp |
|---|---|---|
| Fulu / Osaka (+ BPO1, BPO2) | genesis | `0` |
| Gloas / **Amsterdam** | epoch 1 | `1789596999` |
| Heze / **Hegota** (frame transactions, EL name `bogota`) | epoch 2 | `1789597191` |

All fork boundaries are long past; the chain is at Hegota now. EIP-8282 deposit/exit predeploys
are deployed at genesis (needed for an Amsterdam chain to keep producing blocks).

### 4.3 Life of a frame transaction

1. A client calls `eth_sendFrameTransaction` on the sidecar (`/rpc`).
2. The sidecar makes one `ethrex_simulateFrameTransaction` call with `{"trace": true}`
   ([6.1](#61-ethrex_simulateframetransaction)), recognises the validation-prefix shape from the
   frames, and enforces the ERC-7562-derived rules (opcodes, storage access, per-role staking and
   reputation) against the returned trace. Failures are rejected with a JSON-RPC error.
3. The transaction enters the sidecar's mempool (status `Pending`) and is gossiped to sidecar peers
   over libp2p (gossipsub topic per mempool, discv5 discovery).
4. In `auto` mode, `BundlingService` runs every 10 s and hands each ready transaction to the
   `PrivilegedRelayer`, which calls **`ethrex_submitPrivilegedFrameTransaction`** on the local
   ethrex node (status `Submitted`). ethrex forces it into the very next payload build,
   bypassing its own public mempool.
5. Once a block includes it, `MempoolReconciler` reads the real receipt and sets `OnChain`
   (or `Reverted`).

Consequence worth knowing: ethrex's own mempool is not the alt mempool. A frame transaction can
also be sent to ethrex directly with `eth_sendRawTransaction` (type `0x06`), where ethrex applies
its own validation, but the point of this devnet is the sidecar path.

### 4.4 Ports and firewall (GCP)

| Port | Open to | What |
|---|---|---|
| 80, 443/tcp | world | Caddy (`eip8141-miner-web`) |
| 8545/tcp | world | ethrex RPC, direct and unencrypted (`eip8141-miner-rpc`) |
| 4337/tcp+udp | world | sidecar libp2p (`eip8141-miner-p2p`) |
| 14337/tcp | nobody directly | sidecar RPC/WS, reachable only via Caddy `/rpc` |
| 22/tcp | world | SSH (GCP default rule) |

---

## 5. Non-standard APIs: sidecar

All on `https://altmempool.forshtat.com/rpc` (HTTP `POST`; WebSocket at the same path). The
ERC-4337 UserOperation methods (`eth_sendUserOperation`, `eth_estimateUserOperationGas`,
`eth_getUserOperationByHash`, `eth_getUserOperationReceipt`, `eth_supportedEntryPoints`,
`skandha_userOperationStatus`, `skandha_feeHistory`) **do not exist** in this fork.

### Frame-transaction methods

| Method | Params | Result |
|---|---|---|
| `eth_sendFrameTransaction` | `[tx]` - full signed transaction, JSON form ([2.2](#22-a-frame-transaction)) | Transaction hash. Errors if the transaction fails simulation or the mempool rules. Total frame gas limit is capped by the node's `userOpGasLimit`. |
| `eth_estimateFrameTransactionGas` | `[partialTx]` - needs `sender` and `frames`; `signatures`, `fees`, `nonce` optional | `{ frames: [{execution, state}], cumulativeGasUsed, maxFeePerGas, maxPriorityFeePerGas }`, hex. Frames in the validation prefix keep their limits; body frames are simulated with a large placeholder limit, then the measured usage is returned with markup applied. |
| `eth_getFrameTransactionByHash` | `[hash]` | The mempool entry, or `null` if not in this node's mempool. There is no lookup after the entry has been pruned. |
| `eth_getFrameTransactionReceipt` | `[hash]` | `{ status: "success"\|"reverted", payer, cumulativeGasUsed, frameReceipts: [{status, gasUsed: {execution, state}, logs}] }`. Errors if the transaction is not yet mined or is not a frame transaction. |
| `skandha_frameTransactionStatus` | `[hash]` | `{ tx, sender, payer, factory?, status, transaction?, reason? }`. `status` is one of `New`, `Pending`, `Submitted`, `OnChain`, `Finalized`, `Cancelled`, `Reverted`. `transaction` appears once submitted; `reason` only for `Reverted`; `factory` only if the prefix has a deploy-role frame. Errors with "Frame transaction not found" for unknown hashes. |

More detail: `docs/sidecar_frameTransactionStatus.md`.

### Other sidecar methods

| Method | Result |
|---|---|
| `skandha_getGasPrice` | `{ maxPriorityFeePerGas, maxFeePerGas }` suggested for this chain |
| `skandha_config` | Node configuration: chain id, flags (`redirectRpc`, `testingMode`), the fixed entry-point sentinel `0x00000000000000000000000000000000000000aa`, relayer address, reputation/staking parameters, gas markup settings. Returned as-is, not hexlified. |
| `skandha_connectedPeers` | List of connected sidecar p2p peers (empty if none) |
| `skandha_subscribe` / `skandha_unsubscribe` | WebSocket push subscriptions. Event types: `pendingUserOps`, `submittedUserOps`, `onChainUserOps` (names kept from the original 4337 implementation; payload is now `{ tx, txHash, sender, payer, factory? }`). See `docs/sidecar_subscribe.md`. |

Also worth knowing: `eth_chainId` and `web3_clientVersion` (`skandha/v4.1.1-`) are answered
locally; the rest of the standard read surface is proxied to ethrex (`--redirectRpc`).

### `debug_bundler_*`

`debug_bundler_dumpMempool`, `dumpMempoolRaw`, `clearState`, `clearMempool`, `clearReputation`,
`setReputation`, `dumpReputation`, `setBundlingMode`, `setBundleInterval`, `sendBundleNow`,
`setMempool`, `getStakeStatus`. In the upstream bundler these are restricted to requests from localhost.
**On this devnet they are reachable from the internet**, because Caddy connects from localhost.
`debug_bundler_dumpMempool` is a handy way to see what is currently pending. Please do not call
the `clear*` or `set*` methods unless you mean to affect everyone using the devnet. See
[Known limitations](#known-limitations).

---

## 6. Non-standard APIs: ethrex fork

All on the root URL `https://altmempool.forshtat.com`. The node runs with
`--http.api eth,net,web3,ethrex,debug,admin,txpool`.

### 6.1 `ethrex_simulateFrameTransaction`

Dry-runs a frame transaction without submitting it: the same admission checks ethrex's mempool
runs (EIP-8141 static constraints, signature authentication, the validation-prefix simulation),
followed by a full multi-frame execution.

Params: `[rawTx, block?, options?]`

- `rawTx` - the RLP-encoded type-`0x06` transaction, hex (`0x06 || rlp(fields)`). Not the JSON
  form. `encodeRawFrameTx` in `packages/executor/src/services/FrameTxService/codec.ts` produces it.
- `block` - block identifier to simulate against, default `latest`.
- `options` - `{ "trace": true }` additionally returns the full ERC-7562 frame trace. Absent,
  `null` or `{"trace": false}` skips it.

Result (camelCase):

| Field | Meaning |
|---|---|
| `valid` | All frame-specific admission gates passed. Necessary but not sufficient for mempool admission: linear-nonce, fee-floor, wire-size and per-sender-pending checks are not replayed. |
| `prefixShape` | Recognised validation-prefix shape name, or `null` |
| `payer` | Payer established by the prefix (paymaster or self-funded sender), or `null` |
| `maxCost` | Max cost in wei (hex); always present |
| `violation` | Why it is invalid; `null` when `valid` |
| `gasUsed` | Total gas across frames (hex); `null` if not executed |
| `frames` | `[{ gasUsed, succeeded }]` per frame; `null` if not executed |
| `executionStatus` | `"success"` or `"reverted"`; `null` if not executed |
| `executionError` | Why full execution could not run or complete |
| `erc7562Trace` | Only with `{"trace": true}` and a successful execution: one entry per frame with opcode counts, accessed storage and transient-storage slots, `EXTCODE*` accesses, contract sizes and Keccak preimages |
| `erc7562TraceError` | Set if tracing was requested and the trace pass itself failed |

### 6.2 `ethrex_submitPrivilegedFrameTransaction`

Params: `[rawTx]` (RLP-encoded type-`0x06`, hex). Forces the transaction into the **very next**
payload build, bypassing ethrex's mempool admission entirely: no fee-competitiveness check, no
paymaster reservation accounting, no expiry check, no spam protection. There is no retry - if the
next payload build does not pick it up, it is dropped. This is the method the sidecar's
`PrivilegedRelayer` uses. It is **fully unauthenticated**, and on this devnet the port is public,
so anyone can call it. It is a demo shortcut, not something to copy into a real deployment.

### 6.3 Frame transactions in standard methods

- `eth_sendRawTransaction` accepts type-`0x06` frame transactions (applying ethrex's own
  validation) once the chain is at Hegota.
- `eth_getTransactionReceipt` on a frame transaction adds a `frameReceipts` array:
  `[{ status, gasUsed, stateGasUsed, logs }]`, alongside the usual receipt fields.

### 6.4 Tracing (`debug_trace*`)

`debug_traceTransaction`, `debug_traceCall`, `debug_traceBlockByNumber` and
`debug_traceBlockByHash` take a `tracer` option. Besides the usual `callTracer` (the default,
diverging from geth's per-opcode default), `prestateTracer` and `opcodeTracer`, this fork adds
**`erc7562FrameTracer`**: a native ERC-7562 / EIP-8141 validation-diagnostics tracer whose output
is an *array*, one entry per frame-transaction frame (opcode counts, accessed slots, `EXTCODE*`
accesses, contract sizes, Keccak preimages). The name is deliberately not `erc7562Tracer`: geth
uses that for a differently shaped, single-call-tree tracer, and reusing the name would silently
break clients that point at both. The sidecar does not call `debug_traceCall` for admission; it gets
the same trace data from a single `ethrex_simulateFrameTransaction` call with `{"trace": true}`
([6.1](#61-ethrex_simulateframetransaction)).

Standard `debug_*` (raw headers/blocks/receipts, execution witness, `debug_chainConfig`, …) is
enabled too, and so are `txpool_*` and `admin_*`.

---

## 7. Running your own node against it

You can run your own frame-tx-aware sidecar node and peer it with this devnet's mempool.

```sh
git clone https://github.com/forshtat/mempool-workshop-sidecar && cd mempool-workshop-sidecar
bun install && bun run build
```

Then point a node at an execution client for chain 1337 (your own, or this devnet's RPC; note
that a node in `auto` mode submits transactions via `ethrex_submitPrivilegedFrameTransaction`,
which needs to be your own trusted ethrex) with a `config.json` like:

```json
{
  "entryPoints": ["0x00000000000000000000000000000000000000aa"],
  "canonicalEntryPoint": "0x00000000000000000000000000000000000000aa",
  "standardMempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
  "supportedMempools": [
    { "mempoolId": "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk",
      "entryPoint": "0x00000000000000000000000000000000000000aa" }
  ],
  "rpcEndpoint": "http://localhost:8545",
  "rpcEndpointSubmit": "http://localhost:8545"
}
```

and start it in `node` mode with this devnet's ENR as a boot node:

```sh
./skandha node --configFile config.json --dataDir ./skandha-data \
  --p2p.bootEnrs "enr:-J24QE4VOKvF8WltEOqNU4sqKlHVzEz7WV7BO-ORS94DfkePcMPk8ls3wUhxwO3BETKdlwtYS98Jd3DRAOEQwN1pzCUBiGNoYWluX2lkiDkFAAAAAAAAgmlkgnY0gmlwhCJDKZeJc2VjcDI1NmsxoQMQmr1qrPNfG8RDuHZ7COiKQhwOr03WtSxnHm9Xbwxu7IN0Y3CCEPGDdWRwghDx"
```

(The ENR advertises `34.67.41.151`, UDP/TCP `4337`. `--p2p.retainPeerId` on the devnet keeps it
stable across restarts. Flag names follow `P2P.md`; check `./skandha node --help` if your
checkout differs.) Peers are visible afterwards through `skandha_connectedPeers`.

---

## 8. Predeployed contracts

Real mainnet contracts, deployed by replaying their original deployment transactions, so their
bytecode is the mainnet bytecode. Addresses are on this devnet (chain ID 1337) and differ from
mainnet's. One exception: `NaiveStakingRegistry` (last row) has no mainnet equivalent - it's
freshly-compiled, custom bytecode (see
[Testing a staked entity end-to-end](#testing-a-staked-entity-end-to-end)).

| Contract | Address | Notes |
|---|---|---|
| LINK (Chainlink token) | `0x7BF399a347FC0757e668058f11D3B696932353e4` | 1,000,000,000 LINK, all held by the deployer |
| USDT (Tether) | `0xdb6785eB39E80a1770699C5dF8Ab7d4AC683b4D9` | 6 decimals. 1,000,000,000 USDT minted to the deployer, who owns the token and can mint more with `issue(amount)` |
| BAYC (Bored Ape Yacht Club) | `0x4F07c6E07C502f43373E5ecb42adBb92b41e192d` | Sale is open: `mintApe(n)` costs 0.08 ETH per ape, 10,000 max |
| Tornado Cash (0.1 ETH pool) | `0xF8d72424D07721aB219cdbd2852657F3301673fC` | Deposit 0.1 ETH with `deposit(bytes32 commitment)`, withdraw with a real zk proof via `withdraw(...)`. Replayed exactly as it was on Dec 2019, before a later mainnet governance verifier swap — deposits and withdrawals work the same either way. Depends on its own Hasher (`0x4500a5B572903a1DE1615d13A366cF2B324675E2`) and Verifier (`0xECD2eE825ebCA4D6BEbD269FCA033229addf9f01`), also predeployed at fixed addresses. Both deposit and a real end-to-end zero-knowledge withdrawal have been verified live. |
| USDC | `0xEFe0D421fD473564c9C9b0cDCeB194cF476D6AF5` | Real, current USDC (permit/EIP-3009 gasless-transfer support included). 1,000,000,000 USDC minted to the deployer, who holds every role and can mint more with `configureMinter`/`mint`. |
| WETH9 | `0x1b7d32025F7cA633943BbCC9Ec61a98ef66187b6` | Canonical WETH9. No premint — `deposit()` real devnet ETH to get some. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Uniswap's Permit2, at its **real mainnet address** — the only contract here that shares its address with mainnet, since its deployer (Arachnid's proxy) is already at the same address in genesis. |
| Uniswap v4 PoolManager | `0x6bF9Aa9c04fd001385742d61f6818C3236429848` | The core v4 singleton, real bytecode. |
| Uniswap v4 PositionManager | `0x5bF24B2CD6f4cc0057F4BeD53264d591620Af57B` | Mint/manage liquidity positions (ERC-721 NFTs). Real bytecode; NFT `tokenURI()` metadata rendering won't work (its descriptor contract isn't predeployed here), everything else does. |
| Uniswap v4 StateView | `0xd89a052862AaA34f0B6cc7f3B6a9D080584a43FB` | Read-only pool-state helper, real bytecode. |
| Uniswap v4 Quoter | `0xeEa49CC6419125E2f706bf7f95Cf34ac7e93087D` | Off-chain swap-quote simulation, real bytecode. |
| Universal Router | `0x5e2250a42608a5cc9f62e23ab24824ee25b5e2be` | Real bytecode. v4 swaps/quotes/liquidity commands work; legacy v2/v3 swap commands and cross-chain bridging commands don't (those dependencies aren't predeployed here). |
| Railgun (shielded-pool contracts) | `0x06a7dfbc3b95dcdfeca1c2cf8dbb0c8fdb194213` | Real `RailgunSmartWallet` logic, all 91 real Groth16 verifying keys registered so every shield/unshield circuit shape is supported. Real fees: 0.25% shield, 0.25% unshield. Depends on two Poseidon hashing libraries, also predeployed. Both `shield()` and a real private `transact()` unshield (genuine Groth16 proof, using the `@railgun-community/engine` SDK) have been verified live end-to-end. |
| NaiveStakingRegistry (ERC-8421 IStakingRegistry) | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` | Naive, no-slashing implementation - `addStake(unstakeDelaySec)` with real ETH value, `unlockStake()`, `withdrawStake(to)`. The deployer already has a small smoke-test stake (0.001 ETH, 1-day unstake delay) from deployment itself. |

Everything above is owned by the **deployer**, a throwaway key published on purpose, with four
deliberate exceptions detailed in [deployments/devnet.md](../../deployments/devnet.md): Tornado
Cash's admin-only functions stay bound to the real historical mainnet deployer's key, which
nobody here controls; USDC's proxy admin role (not the token's own roles, which the deployer does
hold) was renounced to a burn address after upgrading it, a real requirement of the proxy pattern
it uses, not a choice; the Uniswap v4 PoolManager's `owner` (protocol-fee administration
only, never needed for ordinary pool use) is baked into its bytecode as the real mainnet
Uniswap governance address; and NaiveStakingRegistry has no owner/admin concept at all - every
function only ever touches `msg.sender`'s own deposit, by design, so there is nothing for the
deployer (or anyone else) to own:

```
address:     0xa071C572d39ef9C2f6e09450570bC36A85a5CDc0
private key: 0xcbb754e47d54ec3bf76954e8e4df02e68d1484c703e47d29f189e32904545191
```

Anyone holding this key can administer these contracts (mint USDT, pause, blacklist). Never use
it on a real network. To get tokens, send a transfer from the deployer, or fund your own key
from the shared account in [Getting funds](#getting-funds).

The tool that deployed all of the above, and the full canonical-addresses record with detailed
notes, are in [deployments/devnet.md](../../deployments/devnet.md).

---

## Known limitations

To see all of the following at work, run the [traffic playground](playground/README.md), which sends
about 60 frame transactions of every kind to both nodes.

- **Open admin surfaces.** Left open on purpose for a demo network; be considerate:
  - `ethrex_submitPrivilegedFrameTransaction` has no authentication.
  - ethrex's full `debug_*` namespace is public, including state-mutating methods such as
    `debug_setHead`.
  - the sidecar's `debug_bundler_*` methods bypass the localhost-only gate because they arrive via
    the reverse proxy.
  - `http://34.67.41.151:8545` exposes ethrex over plain HTTP alongside the HTTPS URL.
- **One transaction in flight per sender.** A node accepts only a sender's current on-chain nonce
  (`Nonce mismatch: expected N, got M` for any other): no queueing of future nonces and no gaps.
  Send a sender's next transaction after the previous one has landed. A same-nonce transaction with
  a fee at least 10% higher (both fees) replaces one that is still pending.
- **Status is per node.** The gateway forwards transactions to the miner and only follows the chain
  (it never relays), so its view shows `New` until the miner has included one, then `OnChain` or
  `Reverted`. The miner's view goes `New`, `Submitted`, `OnChain`.
- **Validation frames are read-only.** A frame in the validation prefix that writes state or sends
  value reverts in the VM ("validation prefix frame reverted"), so the OP-061 rule (no value in
  nested calls) is rarely what rejects such a transaction. ethrex gives the same message for no
  funds, out of gas, a loop and a revert; the sidecar adds the payer's balance or the frame gas limits
  when it can (see [`docs/ethrex-requests.md`](../../docs/ethrex-requests.md)).
- **Faucet is small and in memory**: per-address and global limits reset on restart (see [Getting funds](#getting-funds)).
- **Gas for new accounts** is ~204,600, not 21,000 ([2.1](#21-a-plain-transfer-mind-the-gas)).
- **Privileged submission is one-shot.** If a transaction misses the next payload build, the sidecar
  re-submits it on its next 10-second pass, up to three attempts (`maxSubmitAttempts`), then cancels
  it with the reason "relayed N times without being included in a block"; expect an occasional
  extra block of latency. Sending it again after a cancellation is allowed.
- **No frame-transaction lookup after pruning.** `eth_getFrameTransactionByHash` returns `null`
  once the entry has left the sidecar's mempool; use ethrex's `eth_getTransactionReceipt` or the sidecar's
  `eth_getFrameTransactionReceipt` for mined transactions.
- **Two sidecar nodes.** The miner is at `https://altmempool.forshtat.com/rpc`; the gateway at
  `https://altmempoolgateway.forshtat.com/rpc` (WebSocket at `wss://…/rpc`) gossips to it. You can also run your own
  ([section 7](#7-running-your-own-node-against-it)).
- **Not resilient to reboots (yet).** The chain's Docker containers do not have a restart policy,
  so a VM restart takes the devnet down until it is brought back up by hand.
- **May be reset.** A redeploy with a new genesis changes the chain state; chain ID stays 1337.
- **The client code moves.** The ethrex image tag `eip8141-tracer-latest` follows the branch, so
  behaviour can change between visits; `web3_clientVersion` on the root URL tells you the exact
  build.
