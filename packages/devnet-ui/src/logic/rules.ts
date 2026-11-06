import {
  ENTITY_RULE_ORDER,
  EXPLORER_RULES,
  GLOBAL_RULE_ORDER,
} from "@skandha/types/lib/explorer/index.js";
import type { Check } from "../protocol/schemas";
import type { Entity } from "./frames";

export interface RuleInfo {
  label: string;
  explain: string;
}

/** Plain-language names for the rule ids the node reports (see docs/sidecar_explorer.md). */
const RULE_INFO: Record<string, RuleInfo> = {
  "gas-limit": {
    label: "Gas limit",
    explain: "The frames' execution and state gas limits add up to no more than this node allows.",
  },
  "recent-root": {
    label: "Recent roots",
    explain:
      "Every EIP-8272 recent-root reference the transaction declares is within the usable slot window and committed on chain.",
  },
  prefix: {
    label: "Validation prefix",
    explain: "The leading frames form a recognized validation prefix with sender, payer and factory roles.",
  },
  structure: {
    label: "Frame structure",
    explain: "The prefix follows EIP-8141's structural rules for targets, flags and verification gas.",
  },
  "BUDGET-010": {
    label: "Verification gas budget",
    explain:
      "Each entity's validation frames (plus, for the sender, the signature cost) stay within its ERC-8421 budget: 100,000 gas when unstaked, 1,000,000 when staked (node-configurable).",
  },
  signature: {
    label: "Signatures",
    explain: "Every signature on the transaction verifies.",
  },
  simulation: {
    label: "Simulation",
    explain: "The execution client simulated the transaction with a trace and did not reject it.",
  },
  "trace-alignment": {
    label: "Trace alignment",
    explain:
      "The trace lines up with the frames: reported once for the whole transaction (one top-level call per validation frame) and once for each entity whose frame called the address the rules expected.",
  },
  "OP-061": {
    label: "No value in nested calls",
    explain: "Validation code makes no nested call that sends value.",
  },
  execution: {
    label: "Validation execution",
    explain: "The simulation reported no execution error.",
  },
  "out-of-gas": {
    label: "No out-of-gas",
    explain: "The entity did not run out of gas internally during validation.",
  },
  "OP-011": {
    label: "Banned opcodes",
    explain: "The entity used none of the opcodes validation forbids, such as TIMESTAMP, NUMBER or GAS.",
  },
  create: {
    label: "Contract creation",
    explain: "The entity created no contracts, except a factory within its limits.",
  },
  storage: {
    label: "Storage access",
    explain: "The entity touched only storage it may: its own, or storage associated with it, and more if staked.",
  },
  "COD-010": {
    label: "Deployed code only",
    explain: "The entity did not read the code of a contract that is not deployed.",
  },
  "entrypoint-access": {
    label: "EntryPoint code",
    explain: "The entity did not read the code of the EntryPoint address.",
  },
  mempool: {
    label: "Mempool admission",
    explain: "The mempool accepted the transaction: replacement fee rules and reputation limits passed.",
  },
  admission: {
    label: "Other failure",
    explain: "The node failed for a reason no other rule claims, such as an unexpected error.",
  },
};

export function ruleInfo(rule: string): RuleInfo {
  return RULE_INFO[rule] ?? { label: rule, explain: "A rule this version of the explorer does not know." };
}

const GLOBAL_ORDER: readonly string[] = GLOBAL_RULE_ORDER;
const ENTITY_ORDER: readonly string[] = ENTITY_RULE_ORDER;
/** Within one frame, `trace-alignment` is reported first, then the per-entity rules. */
const FRAME_ORDER: readonly string[] = [EXPLORER_RULES.TRACE_ALIGNMENT, ...ENTITY_RULE_ORDER];

function rank(order: readonly string[], rule: string): number {
  const index = order.indexOf(rule);
  return index === -1 ? order.length : index;
}

export interface EntityGroup {
  /** -1 when the node reported an entity without a frame index. */
  frameIndex: number;
  entity: Entity | undefined;
  checks: Check[];
}

export type ReportVerdict = "pass" | "fail" | "incomplete";

export interface GroupedChecks {
  /** Transaction-level rules, in the order the node runs them. */
  global: Check[];
  /** Per-entity rules that were never evaluated because an earlier rule failed. */
  notEvaluated: Check[];
  /** Per-frame results, ordered by frame. */
  entities: EntityGroup[];
  verdict: ReportVerdict;
  /** Every failing check, in display order. */
  failing: Check[];
}

/**
 * Arranges a flat `checks[]` for display. The node does not guarantee array
 * order, so everything is sorted by the rule-order arrays from the protocol.
 */
export function groupChecks(checks: Check[]): GroupedChecks {
  const global: Check[] = [];
  const notEvaluated: Check[] = [];
  const groups = new Map<string, EntityGroup>();

  for (const check of checks) {
    if (check.frameIndex === undefined && check.entity === undefined) {
      // Only a skipped per-entity rule was never evaluated; a fail or pass must stay visible.
      (ENTITY_ORDER.includes(check.rule) && check.verdict === "skipped" ? notEvaluated : global).push(check);
      continue;
    }
    const frameIndex = check.frameIndex ?? -1;
    const key = `${frameIndex}:${check.entity ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { frameIndex, entity: check.entity, checks: [] };
      groups.set(key, group);
    }
    group.checks.push(check);
  }

  global.sort((a, b) => rank(GLOBAL_ORDER, a.rule) - rank(GLOBAL_ORDER, b.rule));
  notEvaluated.sort((a, b) => rank(ENTITY_ORDER, a.rule) - rank(ENTITY_ORDER, b.rule));
  const entities = [...groups.values()].sort(
    (a, b) => a.frameIndex - b.frameIndex || (a.entity ?? "").localeCompare(b.entity ?? ""),
  );
  for (const group of entities) {
    group.checks.sort((a, b) => rank(FRAME_ORDER, a.rule) - rank(FRAME_ORDER, b.rule));
  }

  const failing = [...global, ...entities.flatMap((g) => g.checks)].filter((c) => c.verdict === "fail");
  const anySkipped = checks.some((c) => c.verdict === "skipped");
  const verdict: ReportVerdict = failing.length > 0 ? "fail" : anySkipped ? "incomplete" : "pass";
  return { global, notEvaluated, entities, verdict, failing };
}

/** One line naming the first failed rule, for lists: "Banned opcodes (payer, frame 0)". */
export function failureSummary(checks: Check[]): string | null {
  const first = groupChecks(checks).failing[0];
  if (!first) return null;
  const { label } = ruleInfo(first.rule);
  if (first.entity !== undefined && first.frameIndex !== undefined) {
    return `${label} (${first.entity}, frame ${first.frameIndex})`;
  }
  return label;
}

/**
 * The first failed rule's own reason, for lists: the node's `detail` text
 * (e.g. "banned opcode: GASPRICE (0x3a)") when it sent one, else the rule's
 * plain-language label - the same fallback `RuleChecklist` uses per check.
 */
export function failureDetail(checks: Check[]): string | null {
  const first = groupChecks(checks).failing[0];
  if (!first) return null;
  return first.detail ?? ruleInfo(first.rule).label;
}
