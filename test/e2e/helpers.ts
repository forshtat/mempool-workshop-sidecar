import { spawn, ChildProcess, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hex } from "viem";
import { sign, privateKeyToAccount } from "viem/accounts";
import {
  ENTRY_POINT,
  FRAME_MODE,
  APPROVE_SCOPE,
  SIG_SCHEME,
  FrameTransaction,
} from "@skandha/types/lib/contracts/FrameTx.js";
import { computeSigHash } from "@skandha/executor/lib/services/FrameTxService/codec.js";

/**
 * Shared plumbing for the real two-`skandha node`-process e2e scenarios
 * (`frameTx.e2e.test.ts`: gossip propagation; `frameTxSync.e2e.test.ts`:
 * reqresp/sync ingestion on peer connect). Both spin up the same real
 * ethrex devnet and the same two node processes, differing only in WHEN
 * transactions are submitted relative to node B's lifecycle - see each
 * test file's own header comment for what that ordering is proving.
 */

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");
export const DEVNET_SCRIPT = path.join(__dirname, "ethrex-devnet.sh");

export const ETHREX_PORT = 8555;
export const ETHREX_RPC = `http://127.0.0.1:${ETHREX_PORT}`;
export const CHAIN_ID = 9;

export const NODE_A = { api: 14337, p2p: 4337 };
export const NODE_B = { api: 14338, p2p: 4338 };

/**
 * The real block-producing Kurtosis devnet (`ethrex-mining-devnet.sh` /
 * `kurtosis/eip8141-single-node.yaml`) - a distinct devnet from the
 * `--dev`-mode one above, used only by `frameTxInclusion.e2e.test.ts`, the
 * one scenario that needs a REAL mined block rather than just mempool
 * admission/propagation. Distinct ports throughout, so this test's node
 * never collides with a `--dev`-devnet test's node even if a future test
 * run overlaps them.
 */
export const MINING_DEVNET_SCRIPT = path.join(__dirname, "ethrex-mining-devnet.sh");
export const MINING_NODE_A = { api: 15337, p2p: 5337 };

/**
 * Throwaway key funded via `kurtosis/eip8141-single-node.yaml`'s own
 * `prefunded_accounts` (see that file's comment) - the ONLY account funded
 * at genesis on this devnet, unlike the `--dev`-devnet's `l1-hegota.json`
 * fixture which funds many `fixtures/keys/private_keys_l1.txt` accounts.
 * Committed on purpose: this enclave is created and destroyed per CI run,
 * nothing about the key is a secret.
 */
export const MINING_SENDER_PRIVATE_KEY =
  "0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15" as const;

/**
 * First rich account of ethrex's `fixtures/keys/private_keys_l1.txt`, funded
 * from genesis in `fixtures/genesis/l1-hegota.json`. Used both as the frame
 * transaction's sender and as each node's relayer.
 */
export const SENDER_PRIVATE_KEY =
  "0x941e103320615d394a55708be13e45994c7d93b932b064dbcb2b511fe3254e2e" as const;

/**
 * Second rich account of the same file (verified funded at genesis) - the
 * frame transaction's call target, so the body frame is a plain value
 * transfer to an already-existing funded account rather than an
 * account-creating write.
 */
export const RECIPIENT = "0x8943545177806ED17B9F23F0a21ee5948eCaa776" as const;

export const MEMPOOL_ID = "QmcFZKUX9qoo3StwVycJTAhwdiqbEjcwNvQVK246p3z1rk";

/**
 * A block of further rich accounts from the same `private_keys_l1.txt`
 * (indices 2+, after `SENDER_PRIVATE_KEY`/`RECIPIENT`'s own keys), for
 * scenarios that need many independently-funded senders rather than one
 * sender with many queued nonces - `frameTxSync.e2e.test.ts` needs this
 * because this devnet doesn't mine blocks, so a second transaction from the
 * same sender at nonce 1 would always be rejected ("Nonce mismatch:
 * expected 0, got 1") regardless of how long the test waits: frame-tx
 * admission simulates against current latest state, not a pending-nonce
 * queue, and nonce 0 never gets mined here to unblock nonce 1.
 */
export const SEED_PRIVATE_KEYS: readonly Hex[] = [
  "0x39725efee3fb28614de3bacaffe4cc4bd8c436257e2c8bb887c4b5c4be45e76d",
  "0x53321db7c1e331d93a11a41d16f004d7ff63972ec8ec7c25db329728ceeb1710",
  "0xab63b23eb7941c1251757e24b3d2350d2bc05c3c388d06f8fe6feafefb1e8c70",
  "0x5d2344259f42259f82d2c140aa66102ba89b57b4883ee441a8b312622bd42491",
  "0x27515f805127bebad2fb9b183508bdacb8c763da16f54e0678b16e8f28ef3fff",
  "0x7ff1a4c1d57e5e784d327c4c7651e952350bc271f156afb3d00d20f5ef924856",
  "0x3a91003acaf4c21b3953d94fa4a6db694fa69e5242b2e37be05dd82761058899",
  "0xbb1d0f125b4fb2bb173c318cdead45468474ca71474e2247776b2b4c0fa2d3f5",
  "0x850643a0224065ecce3882673c21f56bcf6eef86274cc21cadff15930b59fc8c",
  "0x94eb3102993b41ec55c241060f47daa0f6372e2e3ad7e91612ae36c364042e44",
  "0xdaf15504c22a352648a71ef2926334fe040ac1d5005019e09f6c979808024dc7",
  "0xeaba42282ad33c8ef2524f07277c03a776d98ae19f581990ce75becb7cfa1c23",
  "0x3fd98b5187bf6526734efaa644ffbb4e3670d66f5d0268ce0323ec09124bff61",
  "0x5288e2f440c7f0cb61a9be8afdeb4295f786383f96f5e35eb0c94ef103996b64",
  "0xf296c7802555da2a5a662be70e078cbd38b44f96f8615ae529da41122ce8db05",
  "0xbf3beef3bd999ba9f2451e06936f0423cd62b815c9233dd3bc90f7e02a1e8673",
  "0x6ecadc396415970e91293726c3f5775225440ea0844ae5616135fd10d66b5954",
  "0xa492823c3e193d6c595f37a18e3c06650cf4c74558cc818b16130b293716106f",
  "0xc5114526e042343c6d1899cad05e1c00ba588314de9b96929914ee0df18d46b2",
  "0x04b9f63ecf84210c5366c66d68fa1f5da1fa4f634fad6dfc86178e4d79ff9e59",
  "0x00f3c6e26fe106334befc354dcf4a08d2d947625f6968920759ec6630de1c3a3",
  "0x029227c59d8967cbfec97cffa4bcfb985852afbd96b7b5da7c9a9a42f92e9166",
  "0x031f8b6155ab7f04aa6d5cd424bfc1c3ad65f911ced9e1f863c9bc118eb5228d",
  "0x0480559965a26c68396f8d76957d86bcf41d4798d6354a213d67d3c77ab9dd02",
  "0x05ec2a3cbcee946efc4a581d508c13bfc1fe2c40410a018b859319ffbb81b741",
  "0x060a9e0d4ee57e31c7b5f8c0496dd9ef7412917d0b430987ff17e7df59348f08",
  "0x07794b7d64b91127316f6ffcdaddd797bcd9bd826f64d09e400e1d0a9b63c672",
  "0x08372a029a6d3026d62d7a1afc40e487d2a95ac4558d8f5745b8f76ee2aebba1",
  "0x08f7bd756bf8bf0aae93401c44ad6f8a059c6ee8b6bbcb8b67f71d437f4bbe0f",
  "0x098622f6492b1986dba92341fd8b1886f5059f45573ee5e7d8deda1e18057f13",
] as const;

// ---------------------------------------------------------------- utilities

export async function rpc(
  url: string,
  method: string,
  params: unknown[] = []
): Promise<{ result?: any; error?: { code: number; message: string } }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as any;
}

export async function waitFor(
  what: string,
  timeoutMs: number,
  predicate: () => Promise<boolean>
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastErr = undefined;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}` +
      (lastErr ? ` (last error: ${String(lastErr)})` : "")
  );
}

export function writeNodeConfig(
  dataDir: string,
  overrides: { relayerPrivateKey?: Hex; rpcEndpoint?: string } = {}
): string {
  const configFile = path.join(dataDir, "config.json");
  fs.writeFileSync(
    configFile,
    JSON.stringify(
      {
        // The single fixed EIP-8141 sentinel, not a deployed contract - the
        // stale ERC-4337 placeholders in `config.json.default` would make
        // `Eth.sendFrameTransaction`'s publish gate silently skip gossip.
        entryPoints: [ENTRY_POINT],
        canonicalEntryPoint: ENTRY_POINT,
        standardMempoolId: MEMPOOL_ID,
        supportedMempools: [
          { mempoolId: MEMPOOL_ID, entryPoint: ENTRY_POINT },
        ],
        relayers: [overrides.relayerPrivateKey ?? SENDER_PRIVATE_KEY],
        rpcEndpoint: overrides.rpcEndpoint ?? ETHREX_RPC,
        rpcEndpointSubmit: overrides.rpcEndpoint ?? ETHREX_RPC,
      },
      null,
      2
    )
  );
  return configFile;
}

export function spawnNode(
  name: string,
  dataDir: string,
  ports: { api: number; p2p: number },
  bootEnrs: string[],
  configOverrides: { relayerPrivateKey?: Hex; rpcEndpoint?: string } = {},
  // "manual" everywhere else here, so a test only sends a bundle when it
  // explicitly calls `debug_bundler_sendBundleNow`. `frameTxInclusion.e2e`
  // needs "auto" instead: `debug_bundler_sendBundleNow` only calls
  // `BundlingService.sendNextBundle`, not `MempoolReconciler.reconcile` -
  // inclusion detection only runs from the "auto"-mode cron's `tryBundle`
  // (see `BundlingService.restartCron`/`tryBundle` - reconcile() then
  // sendNextBundle() every `bundleInterval`, 10s by default).
  bundlingMode: "auto" | "manual" = "manual",
  extraArgs: string[] = []
): ChildProcess {
  const args = [
    "--bun",
    path.join(REPO_ROOT, "packages/cli/bin/skandha.js"),
    "node",
    "--configFile",
    writeNodeConfig(dataDir, configOverrides),
    "--dataDir",
    dataDir,
    "--api.address",
    "127.0.0.1",
    "--api.port",
    String(ports.api),
    // `api.wsPort` defaults to 14337 and does NOT follow `--api.port`, so
    // without this the second node tries to bind the first node's HTTP port
    // for its WebSocket listener and dies with "Is port 14337 in use?".
    // Setting it equal to the node's own HTTP port shares one listener.
    "--api.wsPort",
    String(ports.api),
    "--p2p.host",
    "127.0.0.1",
    "--p2p.enrHost",
    "127.0.0.1",
    "--p2p.port",
    String(ports.p2p),
    "--p2p.enrPort",
    String(ports.p2p),
    // Persists the ENR to `<dataDir>/enr`, which is how the second node
    // learns the first node's ENR without scraping log output.
    "--p2p.retainPeerId",
    "--executor.bundlingMode",
    bundlingMode,
    ...extraArgs,
  ];
  for (const enr of bootEnrs) args.push("--p2p.bootEnrs", enr);

  const logFile = path.join(dataDir, `${name}.log`);
  const out = fs.openSync(logFile, "a");
  const child = spawn("bun", args, {
    cwd: REPO_ROOT,
    stdio: ["ignore", out, out],
    env: { ...process.env, NODE_ENV: "test" },
  });
  child.on("error", (err) => {
    // eslint-disable-next-line no-console
    console.error(`${name} failed to spawn:`, err);
  });
  return child;
}

export function tailLog(dataDir: string, name: string, lines = 40): string {
  const logFile = path.join(dataDir, `${name}.log`);
  if (!fs.existsSync(logFile)) return "(no log)";
  return fs.readFileSync(logFile, "utf-8").split("\n").slice(-lines).join("\n");
}

/**
 * `DEVNET_EXTERNAL=1`: an ethrex dev node is already serving `ETHREX_RPC`
 * (e.g. on a remote VM through an SSH tunnel, for hosts that cannot run the
 * amd64 ethrex image) - use it, and leave it running afterwards.
 */
const DEVNET_EXTERNAL = process.env.DEVNET_EXTERNAL === "1";

export async function startDevnet(): Promise<void> {
  if (!DEVNET_EXTERNAL) execFileSync(DEVNET_SCRIPT, ["up"], { stdio: "inherit" });
  const chainId = await rpc(ETHREX_RPC, "eth_chainId");
  if (Number(chainId.result) !== CHAIN_ID) {
    throw new Error(
      `devnet chain id mismatch: expected ${CHAIN_ID}, got ${JSON.stringify(chainId)}`
    );
  }
}

export function stopDevnet(): void {
  if (DEVNET_EXTERNAL) return;
  try {
    execFileSync(DEVNET_SCRIPT, ["down"], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}

/**
 * Starts the real block-producing Kurtosis devnet and returns its RPC URL
 * and chain id. Neither is hardcoded:
 *
 * - The RPC URL: `port_publisher.el.public_port_start: 32000` in
 *   `kurtosis/eip8141-single-node.yaml` does NOT mean the `rpc` port itself
 *   lands on 32000 - Kurtosis assigns published ports sequentially across
 *   ALL of the EL's exposed ports in whatever order its launcher registers
 *   them (observed: `tcp-discovery` got 32000, `rpc` got 32003). The script
 *   resolves the real mapping via `kurtosis port print ... rpc` and caches
 *   it; `rpc-url` reads that cache back.
 * - The chain id: `kurtosis/eip8141-single-node.yaml` doesn't override
 *   `network_params.network_id`, so it's whatever the pinned
 *   `ethereum-package` revision's own default is - read it back live rather
 *   than assume a value that a future package bump could silently change.
 */
export async function startMiningDevnet(): Promise<{ rpcUrl: string; chainId: number }> {
  // An already-running devnet (e.g. a remote VM reached through an SSH
  // tunnel, for hosts that cannot run the amd64 ethrex image): use it as-is,
  // and leave it running afterwards (`stopMiningDevnet`).
  const external = process.env.MINING_DEVNET_RPC_URL;
  if (!external) execFileSync(MINING_DEVNET_SCRIPT, ["up"], { stdio: "inherit" });
  const rpcUrl =
    external ??
    execFileSync(MINING_DEVNET_SCRIPT, ["rpc-url"], { encoding: "utf-8" }).trim();
  const chainId = await rpc(rpcUrl, "eth_chainId");
  if (chainId.error || chainId.result === undefined) {
    throw new Error(`mining devnet up but eth_chainId failed: ${JSON.stringify(chainId)}`);
  }
  return { rpcUrl, chainId: Number(chainId.result) };
}

export function stopMiningDevnet(): void {
  if (process.env.MINING_DEVNET_RPC_URL) return;
  try {
    execFileSync(MINING_DEVNET_SCRIPT, ["down"], { stdio: "inherit" });
  } catch {
    /* best effort */
  }
}

// -------------------------------------------------- frame tx construction

/**
 * Builds the "Self Relay, Basic Transaction" validation-prefix shape - a
 * single VERIFY frame with `APPROVE_EXECUTION_AND_PAYMENT` and a null target
 * (implicitly `tx.sender`) - followed by one SENDER-mode body frame doing a
 * plain value transfer.
 *
 * Prefix gas stays well inside the unstaked per-entity budget
 * (`MAX_VERIFY_GAS_PER_ENTITY`, 100k) and the `MAX_VERIFY_STATE_GAS` (500k)
 * cap, which `validateStructuralRules` enforces over the prefix.
 */
export function buildUnsignedFrameTx(
  nonce: bigint,
  fees: {
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
  },
  privateKey: Hex = SENDER_PRIVATE_KEY,
  chainId: number = CHAIN_ID,
  // Value-transfer target - RECIPIENT by default (the `--dev`-devnet's
  // second rich account), overridable for devnets (like the mining one)
  // where that address doesn't exist/isn't funded.
  recipient: `0x${string}` = RECIPIENT
): FrameTransaction {
  const sender = privateKeyToAccount(privateKey).address;
  return {
    chainId: BigInt(chainId),
    nonceKeys: [0n],
    nonceSeq: nonce,
    sender,
    frames: [
      {
        mode: FRAME_MODE.VERIFY,
        flags: APPROVE_SCOPE.EXECUTION_AND_PAYMENT,
        target: null,
        limits: { execution: BigInt(30000), state: BigInt(0) },
        value: BigInt(0),
        data: "0x",
      },
      {
        mode: FRAME_MODE.SENDER,
        flags: APPROVE_SCOPE.NONE,
        target: recipient,
        limits: { execution: BigInt(50000), state: BigInt(0) },
        value: BigInt(1),
        data: "0x",
      },
    ],
    signatures: [
      {
        scheme: SIG_SCHEME.SECP256K1,
        // "0x" resolves to tx.sender - see `validateSignature`.
        signer: "0x",
        // "0x" means "the canonical signature hash" (`computeSigHash`).
        msg: "0x",
        signature: "0x",
      },
    ],
    fees: {
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      maxFeePerBlobGas: BigInt(0),
    },
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}

/**
 * Signs over `computeSigHash` (which elides signature bytes for entries whose
 * `msg` is empty) and packs the result the way `validateSignature` reads it
 * back: `v || r || s`, with `v` the 0/1 recovery id, not 27/28.
 */
export async function signFrameTx(
  tx: FrameTransaction,
  privateKey: Hex = SENDER_PRIVATE_KEY
): Promise<FrameTransaction> {
  const sigHash = computeSigHash(tx);
  const signature = await sign({ hash: sigHash, privateKey });
  const v = Number(signature.v) - 27;
  const packed = ("0x" +
    v.toString(16).padStart(2, "0") +
    signature.r.slice(2) +
    signature.s.slice(2)) as Hex;
  return {
    ...tx,
    signatures: [{ ...tx.signatures[0], signature: packed }],
  };
}

// -------------------------------------------------- primitive participant contracts
//
// Hand-assembled, unconditional "always approve" bytecode for the two
// EIP-8141 §Public Mempool-recognized "Canonical Paymaster" prefix roles
// (`[only_verify, pay]` - see `recognizeValidationPrefix` in
// `validationPrefix.ts`), deployed as real contracts on the mining devnet so
// a real frame transaction can exercise the "factory or gas paymaster
// contracts" path the legacy-tx redirect route exists for, rather than the
// null-target self-relay shape `buildUnsignedFrameTx` above builds.
//
// Both skip signature checking entirely (this is a demonstration-only
// devnet - see the deploy runbook's security note) and just call APPROVE
// unconditionally:
//
//   wallet runtime:    PUSH1 0x02 PUSH1 0x00 PUSH1 0x00 APPROVE   (scope=EXECUTION)
//   paymaster runtime: PUSH1 0x01 PUSH1 0x00 PUSH1 0x00 APPROVE   (scope=PAYMENT)
//
// APPROVE's stack is `[offset, length, scope]` (offset on top - see
// `docs/eip-8141.md`'s APPROVE section in the ethrex repo), so the operands
// are pushed scope-first: PUSH scope, PUSH length(=0), PUSH offset(=0).
// Wrapped in a standard init-code "CODECOPY the appended runtime, then
// RETURN it" shell (12 bytes: PUSH1 7 PUSH1 12 PUSH1 0 CODECOPY PUSH1 7
// PUSH1 0 RETURN) so a plain legacy CREATE deploys either 7-byte runtime.
export const WALLET_INIT_CODE: Hex = "0x6007600c60003960076000f3600260006000aa"; // APPROVE(scope=EXECUTION=0x2)
export const PAYMASTER_INIT_CODE: Hex = "0x6007600c60003960076000f3600160006000aa"; // APPROVE(scope=PAYMENT=0x1)

/**
 * A "bad wallet" for `frameTxRejection.e2e.test.ts`'s ERC-7562 demonstration:
 * identical to WALLET_INIT_CODE's self-relay shape (unconditional
 * APPROVE(EXECUTION_AND_PAYMENT=0x3)) except it calls TIMESTAMP first -
 * ERC-7562's [OP-011] banned-opcode set (`bannedOpCodes` in
 * `UserOpValidation/validators/frameTx.ts`) forbids it during a validation
 * frame. Runtime: TIMESTAMP PUSH1 3 PUSH1 0 PUSH1 0 APPROVE (8 bytes),
 * wrapped in the same 12-byte CODECOPY+RETURN init-code shell.
 */
export const BANNED_OPCODE_WALLET_INIT_CODE: Hex = "0x6008600c60003960086000f342600360006000aa";

/**
 * Genesis-preloaded copies of the same three contracts, for
 * `frameTxRejection.e2e.test.ts` against the `--dev`-mode devnet
 * (`startDevnet`/`ethrex-devnet.sh`). That devnet runs with NO block
 * producer at all - see `ethrex-devnet.sh`'s own "No --dev" comment: it
 * idles at block 0, serving RPC against genesis state only - so a plain
 * legacy CREATE transaction there (`deployContract`) would never be mined
 * and its receipt would never arrive. These addresses are instead baked
 * directly into `fixtures/genesis/l1-hegota.json` (ethrex repo,
 * `eip8141-tracer` branch) as pre-funded `alloc` entries carrying the exact
 * same runtime bytecode as WALLET_INIT_CODE/PAYMASTER_INIT_CODE/
 * BANNED_OPCODE_WALLET_INIT_CODE's own deployed runtime (not the init-code
 * wrapper - genesis `alloc.code` is the runtime directly, nothing executes
 * to derive it). Each is funded with 0x3e8 (1000 wei, or 0.01 ETH for the
 * paymaster) and set to nonce 0x1, matching real post-CREATE contract
 * semantics (a CREATE'd account starts at nonce 1, not 0).
 */
export const DEV_GENESIS_WALLET_ADDRESS = "0x00000000000000000000000000000000c0ffee01" as const;
export const DEV_GENESIS_PAYMASTER_ADDRESS = "0x00000000000000000000000000000000c0ffee02" as const;
export const DEV_GENESIS_BANNED_OPCODE_WALLET_ADDRESS = "0x00000000000000000000000000000000badc0de1" as const;

/**
 * Deploys raw init code via a plain legacy CREATE from `deployerPrivateKey`,
 * waits for the real receipt, and returns the deployed address. Generous
 * `gas` (500_000n): this fork's Amsterdam+ resource-based intrinsic gas
 * charges `STATE_BYTES_PER_NEW_ACCOUNT * cost_per_state_byte` = 183_600
 * state gas for materializing ANY brand-new account - a CREATE's target
 * address always is one - on top of the ordinary CREATE intrinsic/init-code/
 * code-deposit costs (see the mining-devnet README's gas-accounting note).
 *
 * `value` (default 0) funds the new contract as part of the CREATE itself,
 * rather than via a later plain transfer to its address: any external call
 * to a contract - including a pure value transfer with empty calldata -
 * executes its runtime code, and an unconditional-APPROVE contract (see
 * WALLET_INIT_CODE/PAYMASTER_INIT_CODE) halts exceptionally outside a
 * frame-tx context, silently reverting a plain funding transfer. A CREATE's
 * value is credited to the new account atomically before its init code
 * runs; the runtime code it deploys is never itself invoked during
 * deployment, so this sidesteps that entirely.
 */
export async function deployContract(
  devnetRpcUrl: string,
  chainId: number,
  deployerPrivateKey: Hex,
  initCode: Hex,
  value: bigint = 0n
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(deployerPrivateKey);
  const nonceResp = await rpc(devnetRpcUrl, "eth_getTransactionCount", [account.address, "pending"]);
  if (nonceResp.error) throw new Error(`eth_getTransactionCount failed: ${JSON.stringify(nonceResp.error)}`);
  const nonce = Number(nonceResp.result);

  const raw = await account.signTransaction({
    chainId,
    nonce,
    to: null,
    value,
    gas: 500_000n,
    gasPrice: 2_000_000n,
    data: initCode,
    type: "legacy",
  });
  const sent = await rpc(devnetRpcUrl, "eth_sendRawTransaction", [raw]);
  if (sent.error) throw new Error(`deploy eth_sendRawTransaction failed: ${JSON.stringify(sent.error)}`);
  const hash = sent.result as string;

  let receipt: any;
  await waitFor(`contract deploy (nonce ${nonce}) to be mined`, 6 * 60_000, async () => {
    const r = await rpc(devnetRpcUrl, "eth_getTransactionReceipt", [hash]);
    if (r.error || !r.result) return false;
    receipt = r.result;
    return true;
  });
  if (receipt.status !== "0x1") {
    throw new Error(`contract deploy reverted: ${JSON.stringify(receipt)}`);
  }
  return receipt.contractAddress;
}

/** Executor-shape -> JSON-RPC wire shape (see `api/src/utils/frameTx.ts`). */
export function toWire(tx: FrameTransaction): unknown {
  const hex = (n: bigint): string => `0x${n.toString(16)}`;
  return {
    chainId: hex(tx.chainId),
    nonceKeys: tx.nonceKeys.map(hex),
    nonceSeq: hex(tx.nonceSeq),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.limits.execution), state: hex(f.limits.state) },
      value: hex(f.value),
      data: f.data,
    })),
    signatures: tx.signatures.map((s) => ({
      scheme: s.scheme,
      signer: s.signer,
      msg: s.msg,
      signature: s.signature,
    })),
    fees: {
      maxPriorityFeePerGas: hex(tx.fees.maxPriorityFeePerGas),
      maxFeePerGas: hex(tx.fees.maxFeePerGas),
      maxFeePerBlobGas: hex(tx.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: tx.blobVersionedHashes,
    recentRootReferences: tx.recentRootReferences.map((r) => ({
      sourceId: r.sourceId,
      slot: hex(r.slot),
      root: r.root,
    })),
  };
}
