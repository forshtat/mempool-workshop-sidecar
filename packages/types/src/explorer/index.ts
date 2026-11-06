/**
 * Wire types for the explorer RPC surface (`skandha_explorer_*`).
 *
 * This file has NO imports on purpose: a browser bundle can import the
 * subpath `@skandha/types/lib/explorer/index.js` without pulling in the rest
 * of `@skandha/types`.
 *
 * Wire conventions: JSON numbers are plain numbers (`seq`, `at`, `id`,
 * `errorCode`). Quantities that can exceed 2^53 (nonce, fees) are `0x`
 * hex strings. Explorer results bypass the API's `deepHexlify`.
 */

export const EXPLORER_PROTOCOL_VERSION = 1;

/** Stable rule ids used in `RuleCheck.rule`. The UI maps them to labels. */
export const EXPLORER_RULES = {
  GAS_LIMIT: "gas-limit",
  /** EIP-8272: every declared recent-root reference is usable. */
  RECENT_ROOT: "recent-root",
  PREFIX: "prefix",
  STRUCTURE: "structure",
  /** ERC-8421 [BUDGET-010]: per-entity verification gas (staked entities get the larger budget). */
  BUDGET: "BUDGET-010",
  SIGNATURE: "signature",
  SIMULATION: "simulation",
  TRACE_ALIGNMENT: "trace-alignment",
  NESTED_CALL_VALUE: "OP-061",
  EXECUTION: "execution",
  OUT_OF_GAS: "out-of-gas",
  BANNED_OPCODE: "OP-011",
  CREATE: "create",
  STORAGE: "storage",
  CODE_ACCESS: "COD-010",
  ENTRYPOINT_ACCESS: "entrypoint-access",
  MEMPOOL: "mempool",
  /** A failure that no other rule claimed (unexpected error). */
  ADMISSION: "admission",
} as const;

export type ExplorerRuleId =
  (typeof EXPLORER_RULES)[keyof typeof EXPLORER_RULES];

/** Rules evaluated once per transaction, in the order the node runs them. */
export const GLOBAL_RULE_ORDER: readonly ExplorerRuleId[] = [
  EXPLORER_RULES.GAS_LIMIT,
  EXPLORER_RULES.RECENT_ROOT,
  EXPLORER_RULES.PREFIX,
  EXPLORER_RULES.STRUCTURE,
  EXPLORER_RULES.BUDGET,
  EXPLORER_RULES.SIGNATURE,
  EXPLORER_RULES.SIMULATION,
  EXPLORER_RULES.TRACE_ALIGNMENT,
  EXPLORER_RULES.NESTED_CALL_VALUE,
  EXPLORER_RULES.EXECUTION,
  EXPLORER_RULES.MEMPOOL,
];

/** Rules evaluated once per validation-prefix entity (sender/payer/factory). */
export const ENTITY_RULE_ORDER: readonly ExplorerRuleId[] = [
  EXPLORER_RULES.OUT_OF_GAS,
  EXPLORER_RULES.BANNED_OPCODE,
  EXPLORER_RULES.CREATE,
  EXPLORER_RULES.STORAGE,
  EXPLORER_RULES.CODE_ACCESS,
  EXPLORER_RULES.ENTRYPOINT_ACCESS,
];

export type EntityRole = "sender" | "payer" | "factory";
export type CheckVerdict = "pass" | "fail" | "skipped";

export interface RuleCheck {
  rule: ExplorerRuleId;
  frameIndex?: number;
  entity?: EntityRole;
  verdict: CheckVerdict;
  detail?: string;
}

/**
 * A frame from the submitted transaction's `frames[]`, in the same
 * hex-quantity wire shape as `ExplorerTransactionDetail.entry.tx.frames`.
 * Present on every `AdmissionRecord`, whether the transaction was accepted,
 * rejected or replaced - unlike the mempool entry, which only exists for an
 * accepted transaction still in the pool.
 */
export interface ExplorerFrame {
  mode: number;
  flags: number;
  target: string | null;
  limits: { execution: string; state: string };
  value: string;
  data: string;
}

/**
 * A frame's outcome in the traced simulation behind an admission attempt.
 * `not-run` means the simulation never reached that frame: either it was
 * rejected before simulation started (structure, signature, ...), or the
 * trace stopped early. Index-aligned with `AdmissionRecord.frames`.
 */
export type FrameRunStatus = "success" | "reverted" | "not-run";

/** Where this node first saw the transaction. */
export type AdmissionSource = "rpc" | `gossip:${string}` | `sync:${string}`;

/**
 * `replaced` is set on the OLD transaction's record when a newer one takes its
 * `sender:nonce` slot. The new transaction's own record is `accepted`.
 * `included`/`dropped` are set once an accepted transaction resolves: `included`
 * when it lands on-chain (see `includer`), `dropped` when this bundler gave up on
 * it without it being included - which does not preclude a different block
 * builder including it later, at which point the record flips to `included`
 * after all (see `includer`'s own doc comment).
 */
export type AdmissionOutcome =
  | "rejected"
  | "accepted"
  | "included"
  | "replaced"
  | "dropped";

export interface AdmissionRecord {
  /** Monotonic; used as the pagination cursor. */
  id: number;
  txHash: string;
  sender: string;
  /** EIP-8250 `nonce_seq`, 0x hex quantity */
  nonce: string;
  /** EIP-8250 `nonce_keys`, 0x hex quantities; `["0x0"]` is the linear nonce */
  nonceKeys: string[];
  /** Unix ms when this node first saw the transaction */
  at: number;
  source: AdmissionSource;
  outcome: AdmissionOutcome;
  /**
   * The including block's `miner`/coinbase address, present only when
   * `outcome === "included"`. Populated even for a transaction this bundler
   * itself gave up on (`dropped`/`replaced`) if a different block builder
   * included it anyway - see the explorer-activity-outcomes design spec.
   */
  includer?: `0x${string}`;
  /** JSON-RPC error code, present when `outcome` is `rejected` */
  errorCode?: number;
  checks: RuleCheck[];
  /** The transaction's real frames, regardless of outcome. */
  frames: ExplorerFrame[];
  /** Index-aligned with `frames`. */
  frameStatuses: FrameRunStatus[];
}

export type LifecycleKind =
  | "admitted"
  | "rejected"
  | "replaced"
  | "statusChanged"
  | "dropped"
  | "included";

export interface LifecycleEvent {
  /** Monotonic across the node's lifetime; resume streams with `sinceSeq`. */
  seq: number;
  txHash: string;
  at: number;
  kind: LifecycleKind;
  /** Mempool status name after this event, when known */
  status?: string;
  reason?: string;
  blockNumber?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface ExplorerInfo {
  protocolVersion: number;
  chainId: number;
  version: string;
  commit: string;
  bundlingMode: string;
  p2pEnabled: boolean;
  /** Highest `seq` recorded so far (0 if none) */
  latestSeq: number;
  /** Lowest `seq` still retained (0 if none). A resume point below this has a gap. */
  oldestSeq: number;
  historyCapacity: number;
  /**
   * Random per process start. If it differs from the value a client saw
   * earlier, all `seq` values and history from before are invalid; reload
   * from scratch.
   */
  bootId: string;
  /** Reputation ban/throttle thresholds (`ReputationEntry.isBanned`/`isThrottled`), so a
   * client can show how close an entity is to either without a second round trip. */
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
  /** Present and `true` when `skandha_explorer_faucet` is available (1 ETH per request). */
  faucetEnabled?: boolean;
}

export interface ExplorerTransactionSummary {
  txHash: string;
  sender: string;
  payer: string;
  factory?: string;
  /** EIP-8250 `nonce_seq`, 0x hex quantity */
  nonce: string;
  /** EIP-8250 `nonce_keys`, 0x hex quantities; `["0x0"]` is the linear nonce */
  nonceKeys: string[];
  status: string;
  frames: number;
  maxFeePerGas: string;
  submittedTime?: number;
  lastUpdatedTime: number;
  /**
   * Where this node first saw the transaction. Absent when its admission
   * record is gone: the history is in memory, so a transaction that survived a
   * restart in the pool, or an evicted record, has none.
   */
  source?: AdmissionSource;
}

export interface ExplorerTransactionDetail {
  hash: string;
  entry:
    | (ExplorerTransactionSummary & {
        /** Serialized frame transaction (hex-encoded quantities) */
        tx: Record<string, unknown>;
        revertReason?: string;
        transaction?: string;
      })
    | null;
  admission: AdmissionRecord | null;
  events: LifecycleEvent[];
}

export interface ExplorerPeer {
  peerId: string;
  direction: string;
  connectedAt: number;
  lastReceivedAt: number;
  agentVersion: string | null;
  supportedMempools: string[];
}

export type ExplorerReputationStatus = "ok" | "throttled" | "banned";

export interface ExplorerReputationEntry {
  address: string;
  opsSeen: number;
  opsIncluded: number;
  status: ExplorerReputationStatus;
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  /** 0x hex quantity (wei) */
  stake: string;
  unstakeDelaySec: number;
  /** 0x hex quantity; 0 while no withdrawal has been initiated */
  withdrawTime: string;
  /** `stake >= NetworkConfig.minStake && unstakeDelaySec >= NetworkConfig.minUnstakeDelay && withdrawTime === 0` (ERC-8421's STAKING-010: a withdrawal in progress disqualifies the entity even when stake/delay still clear the threshold) */
  isStaked: boolean;
}
