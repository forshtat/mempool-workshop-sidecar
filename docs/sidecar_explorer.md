## skandha_explorer_*

A read-only JSON-RPC surface for a devnet explorer UI. It answers three questions the regular RPC
methods cannot: *why did this node accept or reject a frame transaction* (a rule-by-rule report per
transaction), *what happened to it afterwards* (a lifecycle event log, also available as a live
stream), and *how much does this node trust each entity it has seen* (reputation and stake). The
types behind every result are in `packages/types/src/explorer/index.ts` (`ExplorerInfo`,
`ExplorerTransactionSummary`, `ExplorerTransactionDetail`, `AdmissionRecord`, `LifecycleEvent`,
`ExplorerPeer`, `ExplorerReputationEntry`, `Page<T>`).

Everything here requires the node to be started with `--explorer.enable`. Without the flag no history
is recorded, and every `skandha_explorer_*` call fails with a "method not found" error (`-32601`,
see [Disabled explorer](#disabled-explorer)). The history is kept in memory only: it is bounded
(10,000 lifecycle events and 10,000 admission records by default, oldest evicted first) and is
cleared when the node restarts. The methods never change node state and are unrelated to the
`debug_bundler_*` admin methods: they are not gated to localhost or an admin key, like the `eth_*`
methods.

**Access:** the explorer methods and the event stream are open like the `eth_*` methods, with no
authentication. On a node that gossips everything it accepts, most of them add nothing that peers
cannot already see, except the admission history of transactions the node rejected.
`skandha_explorer_listReputation` is a partial exception: it exposes each tracked entity's
reputation counters and whitelist/blacklist membership, which were previously visible only through
the admin-gated `debug_bundler_dumpReputation` — enabling the flag now also exposes that data,
unauthenticated, to anyone who can reach this node's RPC port (its on-chain stake was always
publicly readable regardless). Enable the flag only on a node that does not hold private orderflow,
meaning transactions it has accepted but not yet gossiped, and that you're comfortable exposing its
reputation bookkeeping on. Each `explorerEvents` subscriber keeps one WebSocket open.

Stored `detail` and `reason` texts are truncated to 1,024 characters (a truncated text ends with
`…`). `at` on an admission record is the time this node received the transaction, taken before
validation started.

The examples below are **example output**, not captured from a live node (the `bootId` value in the `info` example is likewise an example). They were produced by
running the real `ExplorerService` and `Explorer` code against in-memory stand-ins for the mempool
and the validator, so the shapes are exact but addresses, hashes, times and error texts are
illustrative.

### Wire conventions

- Requests are ordinary JSON-RPC 2.0 over `POST /rpc/` (or the WebSocket at the same path).
  `params` is a positional array: `[]` for `info` and `peers`, `[options]` for the three list
  methods (`listTransactions`, `listAdmissions`, `listReputation`), `[txHash]` for `getTransaction`.
- Results are plain JSON. Numbers are JSON numbers: `seq`, `at`, `id`, `errorCode`, `frameIndex`,
  `frames`, `chainId`, `latestSeq`, `oldestSeq`, and every time field (Unix milliseconds).
- Only nonces and fee quantities, which can exceed 2^53, are `0x` hex strings: `nonce`,
  `nonceKeys` and `maxFeePerGas`, plus the hex quantities inside `entry.tx`.
- Explorer results are **not** passed through the API's `deepHexlify`, unlike other RPC results, so
  a number never turns into a hex string.
- Cursors are opaque strings: pass back the `nextCursor` of the previous page unchanged. A page
  without `nextCursor` is the last one.
- Page size: `limit` defaults to 50 and is capped at 200. A missing, non-numeric or smaller-than-1
  `limit` means 50; a fractional `limit` is rounded down.
- CORS: the HTTP API already sends CORS headers according to `--api.cors` (default `*`), so a
  browser UI can call it directly.

### Errors

An invalid argument returns the JSON-RPC error `-32600` (invalid request) with a message such as
`Unknown status: Foo`, `Unknown outcome: foo`, `Invalid cursor: abc`, or
`Expected a 32-byte hex transaction hash`. `getTransaction` on a hash this node knows nothing about
returns `-32600` with `Frame transaction not found`.

#### Disabled explorer

Over HTTP, calling any explorer method on a node started without `--explorer.enable` returns a
JSON-RPC error with code `-32601`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "message": "Explorer is disabled: start the node with --explorer.enable",
    "code": -32601
  }
}
```

Over WebSocket, an error raised by the node reaches the client as
`{ "jsonrpc", "id", "message", "data" }` **without** a `code` field (this is how the WebSocket
handler reports every `RpcError`, not something specific to the explorer). A WebSocket client should
treat any response without `result` as a failure and not rely on `code`.

---

### skandha_explorer_info

Node identity and the state of the history buffers. Call it first: `protocolVersion` tells a client
whether it understands this API, and `bootId`, `latestSeq` and `oldestSeq` are the reference points for
[resuming the event stream](#skandha_subscribe-explorerevents).

Params: none.

Result: `ExplorerInfo`

| Field             | Meaning                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `protocolVersion` | Version of this API. Currently `1`.                                          |
| `chainId`         | Chain id this node serves (number).                                          |
| `version`/`commit`| sidecar version and git commit.                                              |
| `bundlingMode`    | Current bundling mode, `auto` (relays on an interval) or `manual` (relays on demand only). Both follow the chain and mark held transactions `OnChain`/`Reverted` when they are mined. |
| `p2pEnabled`      | `true` when the node runs with the libp2p layer (`./skandha node`).          |
| `latestSeq`       | Highest lifecycle event `seq` recorded so far, `0` if none yet.              |
| `oldestSeq`       | Lowest `seq` still retained, `0` if none. Older events were evicted.         |
| `historyCapacity` | Maximum number of retained lifecycle events, and of retained admission records. |
| `bootId`          | Random string (16 hex characters), new on every node start. If it differs from the value you saw earlier, all `seq` values and history from before are invalid: reload from scratch. |

#### Request

```json
{ "jsonrpc": "2.0", "id": 1, "method": "skandha_explorer_info", "params": [] }
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "chainId": 9,
    "version": "v0.1.0",
    "commit": "a9bba01",
    "bundlingMode": "auto",
    "p2pEnabled": false,
    "latestSeq": 8,
    "oldestSeq": 1,
    "historyCapacity": 10000,
    "bootId": "5c1e9a07b3d2f468"
  }
}
```

---

### skandha_explorer_listTransactions

Lists the transactions currently in this node's mempool store, newest first (by `submittedTime`,
falling back to `lastUpdatedTime`). This reads the live mempool, so it includes transactions in
every status the mempool still holds, but not transactions that were rejected or replaced (a
replaced transaction's entry is overwritten by its replacement): use `listAdmissions` for those.

Params: `[{ status?, cursor?, limit? }]` (the object and every field are optional)

- `status`: only return transactions in this mempool status. One of `New`, `Pending`, `Submitted`,
  `OnChain`, `Finalized`, `Cancelled`, `Reverted`.
- `cursor`: the `nextCursor` of the previous page. It is the number of transactions already
  returned, so the list can shift between pages if the mempool changes in the meantime.
- `limit`: page size, see [Wire conventions](#wire-conventions).

Result: `Page<ExplorerTransactionSummary>`. Each item has `txHash`, `sender`, `payer`, `factory`
(only when the transaction deploys the sender), `nonce` (hex; the EIP-8250 `nonceSeq`), `nonceKeys`
(hex list; `["0x0"]` for an ordinary account nonce), `status`, `frames` (number of frames),
`maxFeePerGas` (hex), `submittedTime` (when the mempool first accepted it), `lastUpdatedTime` and,
when known, `source`: where this node first saw the transaction (`rpc`, `gossip:<peerId>` or
`sync:<peerId>`, the same value as on its `AdmissionRecord`). For `gossip` and `sync` the peer id is
the peer that relayed it to this node, not necessarily where it was first submitted. `source` is
absent when the admission record is gone: the history is in memory, so a transaction that stayed in
the pool across a restart, or whose record was evicted, has none.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "skandha_explorer_listTransactions",
  "params": [{ "limit": 1 }]
}
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "items": [
      {
        "txHash": "0x6d9f30cde3c6aaaf824cd5e6b5500472cda83b022965740b362ebd3a87271248",
        "sender": "0xb582979C2136189475326c648732F76677B16B98",
        "payer": "0xb582979C2136189475326c648732F76677B16B98",
        "nonce": "0x7",
        "status": "New",
        "frames": 2,
        "maxFeePerGas": "0x171ab3b64",
        "submittedTime": 1760000018000,
        "lastUpdatedTime": 1760000018000
      }
    ],
    "nextCursor": "1"
  }
}
```

---

### skandha_explorer_listAdmissions

Lists admission records, newest first. An admission record is this node's verdict on one
transaction hash: where it first saw it, whether it accepted it, and the rule-by-rule report
behind that verdict. Unlike the mempool, admission records also cover rejected and replaced
transactions.

Params: `[{ outcome?, cursor?, limit? }]` (the object and every field are optional)

- `outcome`: only return records with this outcome: `accepted`, `rejected`, `included`,
  `replaced` or `dropped`.
- `cursor`: the `nextCursor` of the previous page. It is the `id` of the last record of that page;
  the next page holds records with a smaller `id`. Because `id` never changes, this cursor stays
  stable while new records arrive.
- `limit`: page size, see [Wire conventions](#wire-conventions).

Result: `Page<AdmissionRecord>`

| Field       | Meaning                                                                             |
| ----------- | ----------------------------------------------------------------------------------- |
| `id`        | Monotonic number, used as the pagination cursor.                                    |
| `txHash`    | Hash of the frame transaction. There is one record per hash.                        |
| `sender`    | The transaction's sender.                                                           |
| `nonce`     | Hex quantity: the EIP-8250 `nonceSeq`.                                              |
| `nonceKeys` | Hex list of the EIP-8250 nonce keys; `["0x0"]` is the ordinary account nonce.       |
| `at`        | Unix ms when this node received the transaction (before validation started).        |
| `source`    | Where the node first saw it: `rpc`, `gossip:<peerId>` or `sync:<peerId>`.           |
| `outcome`   | `accepted`, `rejected`, `included`, `replaced` or `dropped`.                        |
| `errorCode` | JSON-RPC error code of the rejection. Usually present when `outcome` is `rejected`; it is only set when the failure was an `RpcError`, so an unexpected internal error has none. |
| `includer`  | The including block's `miner`/coinbase address. Present only when `outcome` is `included`. |
| `checks`    | The rule-by-rule report: a list of `RuleCheck`, see below. The array order is not guaranteed to follow rule order: sort by the order in the [rule tables](#rule-ids). |

`source` values: `rpc` means it arrived through `eth_sendFrameTransaction` on this node;
`gossip:<peerId>` means a P2P peer published it; `sync:<peerId>` means it was fetched from that peer
by pooled-transaction sync.

`outcome` values: `accepted` means it is in the mempool, not yet resolved either way. `rejected`
means validation or the mempool refused it. `included` means it landed on-chain - independent of
whether the frame transaction itself succeeded or reverted, since either way it has a receipt and
an `includer` (see `frames`/the per-transaction `getTransaction` receipt fields for the
success/revert detail). `replaced` is set on the **old** transaction's record when a newer
transaction takes its mempool slot - same sender, same nonce keys and same `nonceSeq` - (the newer
transaction's own record is `accepted`).
`dropped` is set when this node's own bundler gives up on an accepted transaction (a banned
entity, too many failed relay attempts, or a revalidation failure) without it being included.

A transaction this node dropped or replaced-away can still be included later by a different block
builder than the one this bundler itself submits to - this node keeps checking for that, and when
it happens the record's `outcome` flips to `included` with the real `includer`, overriding the
earlier `dropped`/`replaced` value. `included` is the one outcome that, once set, is never
overwritten by anything else. A rejected record can later become `accepted` if the same
transaction is resubmitted and passes; it then keeps its original `id`, `at` and `source`.

#### RuleCheck

Each entry of `checks` is one rule evaluated on the transaction:

| Field        | Meaning                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| `rule`       | A [rule id](#rule-ids).                                                            |
| `verdict`    | `pass`, `fail` or `skipped`.                                                       |
| `detail`     | Text: the failure message for `fail`; optional note otherwise.                     |
| `frameIndex` | For per-entity rules: index of the frame the entity runs in.                       |
| `entity`     | For per-entity rules: `sender`, `payer` or `factory`.                              |

- `pass`: the rule ran and the transaction satisfied it.
- `fail`: the rule ran and the transaction broke it. `detail` holds the same message the node
  returned to the submitter.
- `skipped`: the rule never ran because an earlier rule already failed. A rejected report lists
  every later rule as `skipped`, so a UI can show the full rule list with the failure in place.

Rules that apply to a validation-prefix entity carry `frameIndex` and `entity`. The
opcode/storage rules (`out-of-gas`, `OP-011`, `create`, `storage`, `COD-010`, `entrypoint-access`)
all run for an entity even after one of them fails, so one report can show several violations of
the same entity at once.

A whitelisted entity's violations do not reject the transaction. They are shown as `pass` with a
`detail` that starts with `waived (...)` and keeps the original message, for example:

```json
{
  "rule": "storage",
  "frameIndex": 0,
  "entity": "sender",
  "verdict": "pass",
  "detail": "waived (whitelisted entity): sender accessed unassociated storage"
}
```

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "skandha_explorer_listAdmissions",
  "params": [{ "outcome": "rejected", "limit": 1 }]
}
```

#### Response

The newest rejected record failed early (`structure`), so every later rule is `skipped`.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "items": [
      {
        "id": 4,
        "txHash": "0x3fac658da0907fa49b84e5b5f193ea37f96d0164201df6a886392be27b970e96",
        "sender": "0xb582979C2136189475326c648732F76677B16B98",
        "nonce": "0x6",
        "at": 1760000012000,
        "source": "rpc",
        "outcome": "rejected",
        "errorCode": -32602,
        "checks": [
          { "rule": "gas-limit", "verdict": "pass" },
          { "rule": "prefix", "verdict": "pass" },
          {
            "rule": "structure",
            "verdict": "fail",
            "detail": "frame 0 in validation prefix has ATOMIC_BATCH_FLAG set"
          },
          { "rule": "signature", "verdict": "skipped" },
          { "rule": "simulation", "verdict": "skipped" },
          { "rule": "trace-alignment", "verdict": "skipped" },
          { "rule": "OP-061", "verdict": "skipped" },
          { "rule": "execution", "verdict": "skipped" },
          { "rule": "mempool", "verdict": "skipped" },
          { "rule": "out-of-gas", "verdict": "skipped" },
          { "rule": "OP-011", "verdict": "skipped" },
          { "rule": "create", "verdict": "skipped" },
          { "rule": "storage", "verdict": "skipped" },
          { "rule": "COD-010", "verdict": "skipped" },
          { "rule": "entrypoint-access", "verdict": "skipped" }
        ]
      }
    ],
    "nextCursor": "4"
  }
}
```

A rejection in a per-entity rule looks different: the earlier global rules passed, the entity's
rules ran (one of them fails), and only `mempool` is `skipped`. This is the `checks` of another
rejected record from the same run (the first eight entries, all `pass`, are the global rules from
`gas-limit` to `execution`):

```json
[
  { "rule": "trace-alignment", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  { "rule": "out-of-gas", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  {
    "rule": "OP-011",
    "frameIndex": 0,
    "entity": "sender",
    "verdict": "fail",
    "detail": "sender uses banned opcode: TIMESTAMP"
  },
  { "rule": "create", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  { "rule": "storage", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  { "rule": "COD-010", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  { "rule": "entrypoint-access", "frameIndex": 0, "entity": "sender", "verdict": "pass" },
  { "rule": "mempool", "verdict": "skipped" }
]
```

---

### skandha_explorer_getTransaction

Everything the node knows about one transaction: its mempool entry (if any), its admission record
(if any) and its retained lifecycle events.

Params: `[txHash]`, a 32-byte `0x` hex string (upper or lower case; it is normalized to lower case).

Result: `ExplorerTransactionDetail`

- `hash`: the hash, lower case.
- `entry`: an `ExplorerTransactionSummary` (see `listTransactions`) plus `tx` (the serialized frame
  transaction, hex quantities), and `revertReason` and `transaction` (the hash of the submitted
  or on-chain transaction that carried it, once known), or `null` when the mempool no longer holds
  it. The mempool does not hold a transaction that was rejected, and it does not hold one that was
  replaced: the replacement overwrites the old entry, so the old transaction's `entry` is `null`
  (it is not marked `Cancelled`, and no `dropped` event is recorded for it).
- `admission`: the `AdmissionRecord`, or `null` when none is retained.
- `events`: every retained `LifecycleEvent` for this hash, oldest first (not paged).

The call fails with `-32600` `Frame transaction not found` only when all three are empty.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "skandha_explorer_getTransaction",
  "params": ["0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f"]
}
```

#### Response

A transaction that is still in the mempool, so `entry` is populated. Its `checks` are shortened here
to the first and last entry (the real list has all the rules of a passing report).

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "hash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
    "entry": {
      "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
      "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
      "payer": "0x310788f30062415E1c6f154dB377bf3F39200178",
      "nonce": "0x2",
      "status": "OnChain",
      "frames": 2,
      "maxFeePerGas": "0x28030e335c",
      "submittedTime": 1760000001500,
      "lastUpdatedTime": 1760000009000,
      "tx": {
        "chainId": "0x9",
        "nonce": "0x2",
        "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
        "frames": [
          {
            "mode": 1,
            "flags": 3,
            "target": null,
            "limits": { "execution": "0x7530", "state": "0x0" },
            "value": "0x0",
            "data": "0x"
          },
          {
            "mode": 2,
            "flags": 0,
            "target": "0x8943545177806ED17B9F23F0a21ee5948eCaa776",
            "limits": { "execution": "0xc350", "state": "0x0" },
            "value": "0x1",
            "data": "0x"
          }
        ],
        "signatures": [
          { "scheme": 1, "signer": "0x", "msg": "0x", "signature": "0x00b3f1...1c" }
        ],
        "fees": {
          "maxPriorityFeePerGas": "0x3b9aca00",
          "maxFeePerGas": "0x28030e335c",
          "maxFeePerBlobGas": "0x0"
        },
        "blobVersionedHashes": []
      },
      "transaction": "0xabababababababababababababababababababababababababababababababab"
    },
    "admission": {
      "id": 2,
      "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
      "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
      "nonce": "0x2",
      "at": 1760000007500,
      "source": "rpc",
      "outcome": "accepted",
      "checks": [
        { "rule": "gas-limit", "verdict": "pass" },
        { "rule": "mempool", "verdict": "pass" }
      ]
    },
    "events": [
      {
        "seq": 3,
        "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
        "at": 1760000007500,
        "kind": "admitted",
        "status": "New"
      },
      {
        "seq": 6,
        "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
        "at": 1760000015000,
        "kind": "statusChanged",
        "status": "Submitted"
      },
      {
        "seq": 7,
        "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
        "at": 1760000016500,
        "kind": "included",
        "status": "OnChain"
      }
    ]
  }
}
```

Now the transaction that the one above replaced (same sender and nonce, lower fee). The mempool no
longer holds it, so `entry` is `null`; the admission record's `outcome` is `replaced` and the log
has a `replaced` event whose `reason` names the new hash. Request:
`"params": ["0x65af2433f604135cf50c9122a5a65485b66f4f27daa48e70de9b9dc1c6136a41"]`. Response
(`checks` shortened as above):

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "hash": "0x65af2433f604135cf50c9122a5a65485b66f4f27daa48e70de9b9dc1c6136a41",
    "entry": null,
    "admission": {
      "id": 1,
      "txHash": "0x65af2433f604135cf50c9122a5a65485b66f4f27daa48e70de9b9dc1c6136a41",
      "sender": "0x310788f30062415E1c6f154dB377bf3F39200178",
      "nonce": "0x2",
      "at": 1760000001500,
      "source": "gossip:16Uiu2HAmExamplePeer1",
      "outcome": "replaced",
      "checks": [
        { "rule": "gas-limit", "verdict": "pass" },
        { "rule": "mempool", "verdict": "pass" }
      ]
    },
    "events": [
      {
        "seq": 1,
        "txHash": "0x65af2433f604135cf50c9122a5a65485b66f4f27daa48e70de9b9dc1c6136a41",
        "at": 1760000003000,
        "kind": "admitted",
        "status": "New"
      },
      {
        "seq": 2,
        "txHash": "0x65af2433f604135cf50c9122a5a65485b66f4f27daa48e70de9b9dc1c6136a41",
        "at": 1760000006000,
        "kind": "replaced",
        "reason": "replaced by 0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f"
      }
    ]
  }
}
```

---

### skandha_explorer_peers

The P2P peers this node is connected to. Returns an empty array when the node runs without the P2P
layer (`./skandha standalone`); check `info.p2pEnabled` to tell the two cases apart.

Params: none.

Result: `ExplorerPeer[]`: `peerId`, `direction` (the connection direction as the P2P layer reports it, for example `inbound` or
`outbound`; `unknown` if it does not), `connectedAt`
and `lastReceivedAt` (Unix ms, `0` if unknown), `agentVersion` (or `null`) and `supportedMempools`
(list of strings).

#### Request

```json
{ "jsonrpc": "2.0", "id": 5, "method": "skandha_explorer_peers", "params": [] }
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": [
    {
      "peerId": "16Uiu2HAmExamplePeer1",
      "direction": "inbound",
      "connectedAt": 1760000000000,
      "lastReceivedAt": 1760000007000,
      "agentVersion": "skandha/v0.1.0",
      "supportedMempools": ["frame_transaction"]
    }
  ]
}
```

---

### skandha_explorer_listReputation

Every entity this node tracks reputation and stake for: seen/included counts, OK/THROTTLED/BANNED
status, whitelist/blacklist membership, and its stake at the configured Staking Registry (see
`StakingRegistryService`). Sourced from the same data `debug_bundler_dumpReputation` exposes
(admin-gated), joined with one on-chain `getDepositInfo` read per address per page — this method is
**not** admin-gated, see [Access](#access) above.

Params: `[{ cursor?, limit? }]` (the object and every field are optional)

- `cursor`: the `nextCursor` of the previous page. It is the number of entries already returned, so
  the list can shift between pages if new addresses are tracked in the meantime — same rule as
  `listTransactions`'s cursor, not `listAdmissions`'s.
- `limit`: page size, see [Wire conventions](#wire-conventions).

Result: `Page<ExplorerReputationEntry>`. Each item has `address`, `opsSeen`, `opsIncluded`, `status`
(`"ok"`, `"throttled"` or `"banned"`), `isWhitelisted`, `isBlacklisted`, `stake` (hex wei),
`unstakeDelaySec`, `withdrawTime` (hex; `"0x0"` while no withdrawal has been initiated), and
`isStaked` (`stake` and `unstakeDelaySec` both clear the node's configured minimums — the same test
`checkStake` applies during real admission, computed once here rather than re-derived by every
caller).

Unlike every other method here, this one makes up to `limit` concurrent on-chain reads (one
`getDepositInfo` per address in the page) per call — acceptable at devnet scale, but a real cost an
unauthenticated, polling caller can repeat.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "skandha_explorer_listReputation",
  "params": [{ "limit": 1 }]
}
```

#### Response

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "items": [
      {
        "address": "0xb582979C2136189475326c648732F76677B16B98",
        "opsSeen": 12,
        "opsIncluded": 11,
        "status": "ok",
        "isWhitelisted": false,
        "isBlacklisted": false,
        "stake": "0x6f05b59d3b20000",
        "unstakeDelaySec": 86400,
        "withdrawTime": "0x0",
        "isStaked": true
      }
    ],
    "nextCursor": "1"
  }
}
```

---

### skandha_explorer_faucet

The one explorer method that **changes chain state**: it sends 1 ETH from a dedicated faucet account
to an address. It exists only when the node runs with `--explorer.enable` **and** the environment
variable `SKANDHA_FAUCET_KEY` holds the faucet account's private key; `info.faucetEnabled` is `true`
exactly then. Without the key the method fails with `-32601` like a disabled explorer.

Use a key that is **not** published anywhere and fund it with only what you are willing to give
away: the limits below slow a drain down, the balance bounds it. The key is read from the
environment, not a flag, so it stays out of the process list.

Params: `[address]`. Result: `{ txHash, amount }`, with `amount` in wei as a decimal string. The
transaction is submitted, not mined.

Limits (in memory, reset on restart): one request per address per hour, and 100 requests per hour
in total. A refused request returns `-32600` with the reason in `message` (invalid address, already
received funds, rate limited, faucet empty).

---

## skandha_subscribe: explorerEvents

The lifecycle event log is also available as a push stream, over the WebSocket RPC (`--api.ws`,
enabled by default, same port as HTTP unless `--api.wsPort` is changed). The subscription uses the
same `skandha_subscribe` / `skandha_unsubscribe` methods and `skandha_subscription` notification
envelope as the other streams (see [`skandha_subscribe`](./sidecar_subscribe.md)), with the event
type `explorerEvents`. A node started without `--explorer.enable` refuses the subscription (see
[Disabled explorer](#disabled-explorer): over WebSocket the error has no `code`).

Params: `["explorerEvents", sinceSeq?]`

- `sinceSeq` given (a number): first replay every **retained** event with a `seq` greater than
  `sinceSeq`, oldest first, then continue with live events. Use `0` to replay everything retained.
- `sinceSeq` omitted (or not a number): live events only.

The response carries the subscription id. The replay and live events follow it, so a client always
learns the id before any event that carries it.

#### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "skandha_subscribe",
  "params": ["explorerEvents", 4]
}
```

#### Response

```json
{ "jsonrpc": "2.0", "id": 1, "result": "0x106eb9867751ff1bf61bad4a80b8b486" }
```

#### Events

Each event is one `LifecycleEvent`, as a plain-JSON `result` (numbers are numbers; no hex
conversion):

```json
{
  "jsonrpc": "2.0",
  "method": "skandha_subscription",
  "params": {
    "subscription": "0x106eb9867751ff1bf61bad4a80b8b486",
    "result": {
      "seq": 7,
      "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f",
      "at": 1760000016500,
      "kind": "included",
      "status": "OnChain"
    }
  }
}
```

The four events with `seq` above 4 in the example run, as the replay for `sinceSeq: 4` would
send them (`result` only):

```json
{ "seq": 5, "txHash": "0x3fac658da0907fa49b84e5b5f193ea37f96d0164201df6a886392be27b970e96", "at": 1760000013500, "kind": "rejected", "reason": "frame 0 in validation prefix has ATOMIC_BATCH_FLAG set" }
{ "seq": 6, "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f", "at": 1760000015000, "kind": "statusChanged", "status": "Submitted" }
{ "seq": 7, "txHash": "0x8d8e6bdb90b84da903c0a9486fada823968d4f34cb486759d449185588d5061f", "at": 1760000016500, "kind": "included", "status": "OnChain" }
{ "seq": 8, "txHash": "0x6d9f30cde3c6aaaf824cd5e6b5500472cda83b022965740b362ebd3a87271248", "at": 1760000019500, "kind": "admitted", "status": "New" }
```

To stop, send `skandha_unsubscribe` with the subscription id, as for the other streams.

### Lifecycle events

`seq` starts at 1 and grows by 1 for every event the node records, for as long as the node runs.
`kind` is one of:

| `kind`          | Recorded when                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| `admitted`      | The transaction entered the mempool. `status` is `New`, the status the mempool gives a new entry. |
| `rejected`      | An admission attempt failed. `reason` holds the error message.                     |
| `replaced`      | A newer transaction took this transaction's `sender:nonce` slot. It is recorded on the **old** transaction's `txHash`; `reason` is `replaced by <new txHash>`. |
| `statusChanged` | The transaction was submitted or reverted. `status` is the new mempool status; `reason` carries the revert reason, if any. |
| `dropped`       | The transaction was cancelled (status `Cancelled`). Not recorded when a transaction is replaced: that produces `replaced` only. |
| `included`      | The transaction was found on chain. `status` is `OnChain` or `Reverted` - either way it has a receipt and an `includer`, independent of whether the frame transaction itself succeeded. This can fire for a transaction this node already reported `dropped`/`replaced`, if a different block builder included it after all; the admission record's `outcome` then flips to `included` too (see [skandha_explorer_listAdmissions](#skandha_explorer_listadmissions)). |

`status` (the mempool status name after the event) and `reason` are present only when known.
`LifecycleEvent` also declares an optional `blockNumber`, but it is reserved: no code path fills it
in today, so events never carry it (`included` does not report a block number).

Not every mempool status change produces an event. A change to `Pending` emits no event, and neither
does the reconciler putting a transaction back to `New` after a failed submission, so the last
event of such a transaction may still say `Submitted`. A refused resubmission of an already
accepted transaction changes nothing in its record or events.

### Resuming and detecting gaps

The log is a ring buffer of `historyCapacity` events. To resume a stream after a disconnect, keep
the highest `seq` you processed and the `bootId` you saw, and subscribe again with `seq` as
`sinceSeq`. Replayed events are exactly those with a greater `seq`, so nothing is duplicated.

A restart clears the history and restarts `seq` at 1, and eviction removes old events. Detect both
with `skandha_explorer_info`, before or right after subscribing:

- Compare `info.bootId` with the value you stored. If it changed, the node restarted: discard local
  state and reload (for example with `listAdmissions` and `listTransactions`). Do not compare
  `sinceSeq` with `latestSeq` for this: a new boot that has already recorded more events than your
  `sinceSeq` would look like a normal resume.
- If `bootId` is unchanged, use `oldestSeq` to detect eviction: when `sinceSeq + 1 < info.oldestSeq`,
  events `sinceSeq + 1` to `oldestSeq - 1` were evicted. The replay starts at `oldestSeq` and the
  client should reload its state instead of trusting the stream alone.

---

## Rule ids

`RuleCheck.rule` is always one of these ids (`EXPLORER_RULES` in
`packages/types/src/explorer/index.ts`). A UI should map them to its own labels.

Global rules run once per transaction, in this order (`mempool` is the last one):

| Rule id           | What it checks                                                                       |
| ----------------- | ------------------------------------------------------------------------------------ |
| `gas-limit`       | The sum of all frames' execution and state gas limits is within this node's per-transaction cap. |
| `recent-root`     | Every EIP-8272 recent-root reference is usable: within the slot window (checked before simulating) and committed on chain (checked by the simulation). Passes at once for a transaction without references. |
| `prefix`          | The leading frames form a recognized validation prefix (sender, payer and factory roles). |
| `structure`       | The prefix follows the EIP-8141 structural rules (frame targets, flags, state gas limit), and each entity's validation frames stay within its ERC-8421 verification gas budget (BUDGET-010: 100,000 unstaked, 1,000,000 staked). |
| `signature`       | Every entry of the transaction's `signatures` verifies.                              |
| `simulation`      | The execution client's traced simulation of the transaction succeeded and returned a trace. |
| `trace-alignment` | The trace lines up with the frames: one top-level call per prefix frame. Also reported once per entity, checking that the entity's frame called the expected address. |
| `OP-061`          | No nested CALL with a non-zero value during validation.                              |
| `execution`       | The simulation reported no execution error.                                          |
| `mempool`         | The mempool accepted it: replacement fee rules and reputation/ban checks passed.     |

What the rules can and cannot show, observed on the devnet:

- Validation frames run read-only. A call that transfers value from inside a VERIFY frame reverts
  in the VM itself (the same call with value 0 runs and is then judged by the storage rules), so
  `OP-061` rarely fires: such a transaction is rejected by `simulation` with "validation prefix
  frame reverted", not by `OP-061`.
- The execution client reports every failure of the validation prefix as "validation prefix frame
  reverted": no funds, running out of gas, a revert and a loop look alike. The sidecar adds what it
  can tell for itself: when the payer's balance is below the transaction's maximum cost the message
  says so with both amounts, otherwise it lists the gas limits the prefix frames were given.

Entity rules run for each validation-prefix entity (`entity` and `frameIndex` are set):

| Rule id             | What it checks                                                                     |
| ------------------- | ---------------------------------------------------------------------------------- |
| `out-of-gas`        | The entity did not run out of gas internally during validation.                    |
| `OP-011`            | The entity used none of the banned opcodes.                                        |
| `create`            | The entity used no forbidden contract creation (only a factory may, and only within limits). |
| `storage`           | The entity accessed only storage it may access (its own, or storage associated with it; more if staked). |
| `COD-010`           | The entity did not access the code of a contract that is not deployed.             |
| `entrypoint-access` | The entity did not read the code of the EIP-8141 `ENTRY_POINT` address.            |

Catch-all:

| Rule id     | What it checks                                                                          |
| ----------- | --------------------------------------------------------------------------------------- |
| `admission` | A failure that no other rule claimed, such as an unexpected error. Appears as the only `fail` of the report. |
