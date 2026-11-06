import { createPublicClient, Hex, http } from "viem";
import { FrameTxMempoolEntry } from "../../../entities/FrameTxMempoolEntry.js";
import { BaseRelayer } from "./base.js";

/**
 * The only relaying strategy: this sidecar is not a general-purpose bundler
 * choosing among public/private relay pools - it's an outsourced mempool
 * client for one co-located, trusted ethrex node. It hands that node a
 * frame transaction it has already fully admission-checked itself via
 * `ethrex_submitPrivilegedFrameTransaction` - a demo-grade, unauthenticated
 * ethrex RPC method that forces the transaction into the very next payload
 * build, bypassing ethrex's own mempool admission pipeline entirely (no
 * fee-competitiveness check, no paymaster-reservation accounting, no
 * expiry-deadline check - see that method's own doc comment on the ethrex
 * side). It is NOT retried across blocks by ethrex: a submission not caught
 * by the very next payload build is simply gone, so a failed/missed attempt
 * here just leaves the mempool entry to be picked up and resubmitted on
 * `BundlingService`'s next pass, same as any other submission failure.
 *
 * Everything between "pick a wallet" and "broadcast" is gone: the
 * `encodeHandleOps` batch, the EIP-1559-vs-legacy / EIP-2930 access-list /
 * gas-limit / nonce construction of a fresh `TransactionRequest`, and the
 * `signTransaction` call that turned it into raw bytes. The bytes now arrive
 * already signed by the transaction's own sender, and re-signing them with a
 * bundler wallet is not something a relay is entitled to do. This strategy
 * needs no bundler key at all - `BaseRelayer`'s concurrency limiter is a
 * plain counter, not a wallet pool, for exactly this reason.
 *
 * This relayer's job ends once the submission RPC call returns a hash and
 * the entry is marked `Submitted` - it does NOT wait around to find out
 * whether the transaction actually landed. That used to be done here (a
 * polling loop that waited for a status nothing ever set, and consequently
 * always timed out and mismarked even successful submissions `Reverted` -
 * a real bug, not a design choice). Inclusion detection is now
 * `MempoolReconciler`'s job (`BundlingService/reconciliation.ts`), run once
 * per newly observed block against every `Submitted` entry via
 * `ReceiptService` - see that class's doc comment.
 *
 * ERC-8421 [BUDGET-010] depends on this route: a staked entity may be
 * admitted with up to `maxVerifyGasStakedEntity` (default 1,000,000) of
 * validation gas, while ethrex's own public-mempool admission
 * (`eth_sendRawTransaction`) still applies EIP-8141's single combined
 * `MAX_VERIFY_GAS` (100,000) and would refuse such a transaction. The
 * privileged method skips that check, so every admitted transaction - over
 * 100k or not - is relayed the same way. Switching to a public submission
 * method would silently drop staked over-budget transactions.
 *
 * `eth_sendRawTransactionConditional` (with `{knownAccounts: storageMap}`) is
 * also dropped. Its preconditions came from a bundle's merged validation
 * storage map, and its purpose was to stop the bundler paying for a batch
 * whose assumptions had gone stale. There is no storage map for a single
 * relayed transaction and no bundler-paid gas to protect, so an
 * empty-`knownAccounts` conditional call would assert nothing.
 * `networkConfig.conditionalTransactions` no longer affects this strategy.
 */
export class PrivilegedRelayer extends BaseRelayer {
  /**
   * Test-only lever: a tx hash registered here gets every future relay
   * attempt submitted with ethrex's `targetBlock` param (see
   * `ethrex_submitPrivilegedFrameTransaction`'s own doc comment on the
   * ethrex side), instead of the default "next payload build or never".
   * Lets a deliberately-delayed transaction sit `Submitted`-then-`New`
   * across several real `BundlingService` passes without ever landing, so
   * `MempoolReconciler`'s existing `maxSubmitAttempts` cancellation can be
   * exercised end to end against a real chain - not reachable any other
   * way, since ethrex's own queue has no retry/backoff concept to piggyback
   * on otherwise. Left set (not single-use): every retry of the same tx
   * must keep using the same target block, or an unmarked retry would get
   * included immediately and the test this exists for would never see
   * `Cancelled`. Never populated by production code - nothing calls
   * `setTargetBlock` except the `debug_bundler_*` admin surface
   * (`BundlingService.setPrivilegedRelayTargetBlock`), which is itself
   * gated to localhost/testingMode/admin-key callers.
   */
  private targetBlocks = new Map<Hex, bigint>();

  setTargetBlock(txHash: Hex, targetBlock: bigint): void {
    this.targetBlocks.set(txHash, targetBlock);
  }

  async sendFrameTransaction(
    entry: FrameTxMempoolEntry,
    rawTx: Hex
  ): Promise<void> {
    const availableIndex = this.getAvailableRelayerIndex();
    if (availableIndex == null) {
      this.logger.error("Relayer: No available relayers");
      return;
    }
    const mutex = this.mutexes[availableIndex];

    await mutex.runExclusive(async (): Promise<void> => {
      this.logger.debug(`Trying to relay frame transaction ${entry.txHash}`);
      try {
        const hash = await this.submit(rawTx, entry.txHash as Hex);
        this.logger.debug(`Frame transaction submitted: ${hash}`);
        await this.setSubmitted(entry, hash);
      } catch (err) {
        await this.handleSubmissionFailure(entry, err);
      }
    });
  }

  /**
   * Submits the raw signed transaction via the privileged ethrex endpoint,
   * through the dedicated submission RPC when one is configured. That
   * endpoint should always point at the one co-located, trusted ethrex node
   * this strategy is designed for - never a public-facing RPC.
   */
  private async submit(rawTx: Hex, txHash: Hex): Promise<Hex> {
    const client = this.networkConfig.rpcEndpointSubmit
      ? createPublicClient({
          transport: http(this.networkConfig.rpcEndpointSubmit),
          chain: this.viemChain,
        })
      : this.publicClient;

    if (this.networkConfig.rpcEndpointSubmit) {
      this.logger.debug("Sending to a separate rpc");
    }

    const targetBlock = this.targetBlocks.get(txHash);
    const params: unknown[] =
      targetBlock !== undefined
        ? [rawTx, `0x${targetBlock.toString(16)}`]
        : [rawTx];

    return client.request({
      method: "ethrex_submitPrivilegedFrameTransaction" as any,
      params: params as any,
    });
  }
}
