import { Logger } from "@skandha/types/lib/index.js";
import {
  GetConfigResponse,
  GetGasPriceResponse,
} from "@skandha/types/lib/api/interfaces";
import RpcError from "@skandha/types/lib/api/errors/rpc-error";
import * as RpcErrorCodes from "@skandha/types/lib/api/errors/rpc-error-codes.js";
import { GasPriceMarkupOne } from "@skandha/params/lib/index.js";
import { getGasFee } from "@skandha/params/lib/index.js";
import { MempoolEntryStatus } from "@skandha/types/lib/executor";
import { PublicClient, formatEther } from "viem";
import { GetNodeAPI, NetworkConfig } from "../interfaces.js";
import { Config } from "../config.js";
import { MempoolService } from "../services/index.js";
import { FrameTransactionStatus } from "./interfaces.js";
import { MAX_VERIFY_STATE_GAS } from "../services/UserOpValidation/utils/validationPrefix.js";

/**
 * EIP-8141 frame-transaction adaptation of sidecar's custom RPC surface.
 *
 * No `getFeeHistory`: it used to reconstruct historical
 * `maxFeePerGas`/`maxPriorityFeePerGas` averages by filtering
 * `UserOperationEvent` logs emitted by EntryPoint's `handleOps`
 * transactions, then ABI-decoding those transactions' calldata back into
 * `PackedUserOperation[]`. None of that has an EIP-8141 analogue: there is
 * no multi-EntryPoint-version dispatch (a single fixed `ENTRY_POINT`
 * sentinel), no `handleOps` call to decode (a frame transaction is a plain,
 * protocol-native transaction, not a contract call), and no
 * `UserOperationEvent` log to filter for (EIP-8141 receipts are
 * protocol-native, not event-log-based). Equivalent "historical gas paid by
 * transactions in a block range" analytics would need a new block-range
 * frame-transaction scanner (`ReceiptService` only looks up one
 * already-known hash) - a documented capability gap, not a silent
 * regression, matching `eth.ts`'s own precedent for similarly-unported
 * functionality.
 */
export class Skandha {
  networkConfig: NetworkConfig;

  constructor(
    private mempoolService: MempoolService,
    private chainId: number,
    private publicClient: PublicClient,
    private config: Config,
    private logger: Logger,
    private getNodeAPI: GetNodeAPI = () => null
  ) {
    const networkConfig = this.config.getNetworkConfig();
    this.networkConfig = networkConfig;
  }

  async getGasPrice(): Promise<GetGasPriceResponse> {
    const multiplier = this.networkConfig.gasPriceMarkup;
    const gasFee = await getGasFee(
      this.chainId,
      this.publicClient,
      this.networkConfig.etherscanApiKey
    );
    let { maxPriorityFeePerGas, maxFeePerGas } = gasFee;

    if (maxPriorityFeePerGas === undefined || maxFeePerGas === undefined) {
      try {
        const gasPrice = await this.publicClient.getGasPrice();
        maxPriorityFeePerGas = gasPrice;
        maxFeePerGas = gasPrice;
      } catch (err) {
        throw new RpcError(
          "Could not fetch gas prices",
          RpcErrorCodes.SERVER_ERROR
        );
      }
    }

    if (multiplier && multiplier !== 0) {
      const bnMultiplier = GasPriceMarkupOne + BigInt(multiplier);
      maxFeePerGas = (bnMultiplier * BigInt(maxFeePerGas)) / GasPriceMarkupOne;
      maxPriorityFeePerGas =
        (bnMultiplier * BigInt(maxPriorityFeePerGas)) / GasPriceMarkupOne;
    }

    return {
      maxPriorityFeePerGas,
      maxFeePerGas,
    };
  }

  async getConfig(): Promise<GetConfigResponse> {
    const wallets = this.config.getRelayers();
    const walletAddresses = [];
    if (wallets) {
      for (const wallet of wallets) {
        walletAddresses.push(wallet.account!.address);
      }
    }
    const hasEtherscanApiKey = Boolean(this.networkConfig.etherscanApiKey);
    const hasExecutionRpc = Boolean(this.networkConfig.rpcEndpointSubmit);
    return {
      chainId: this.chainId,
      flags: {
        testingMode: this.config.testingMode,
        redirectRpc: this.config.redirectRpc,
      },
      entryPoints: this.networkConfig.entryPoints,
      beneficiary: this.networkConfig.beneficiary,
      relayers: walletAddresses,
      minInclusionDenominator: this.networkConfig.minInclusionDenominator,
      throttlingSlack: this.networkConfig.throttlingSlack,
      banSlack: this.networkConfig.banSlack,
      minStake: this.networkConfig.minStake.toString(),
      minUnstakeDelay: this.networkConfig.minUnstakeDelay,
      budgets: {
        rule: "BUDGET-010",
        maxVerifyGasPerEntity: this.networkConfig.maxVerifyGasPerEntity,
        maxVerifyGasStakedEntity: this.networkConfig.maxVerifyGasStakedEntity,
        signatureCostAttributedTo: "sender",
        maxVerifyStateGas: Number(MAX_VERIFY_STATE_GAS),
      },
      minSignerBalance: `${formatEther(
        this.networkConfig.minSignerBalance
      )} eth`,
      multicall: this.networkConfig.multicall,
      estimationStaticBuffer: this.networkConfig.estimationStaticBuffer,
      validationGasLimit: this.networkConfig.validationGasLimit,
      receiptLookupRange: this.networkConfig.receiptLookupRange,
      etherscanApiKey: hasEtherscanApiKey,
      conditionalTransactions: this.networkConfig.conditionalTransactions,
      rpcEndpointSubmit: hasExecutionRpc,
      rpcEndpointSubmitMethod: this.networkConfig.rpcEndpointSubmitMethod,
      gasPriceMarkup: this.networkConfig.gasPriceMarkup,
      enforceGasPrice: this.networkConfig.enforceGasPrice,
      enforceGasPriceThreshold: this.networkConfig.enforceGasPriceThreshold,
      eip1559: this.networkConfig.eip1559,
      eip2930: this.networkConfig.eip2930,
      useropsTTL: this.networkConfig.useropsTTL,
      whitelistedEntities: this.networkConfig.whitelistedEntities,
      bundleGasLimitMarkup: this.networkConfig.bundleGasLimitMarkup,
      maxConcurrentSubmissions: this.networkConfig.maxConcurrentSubmissions,
      bundleInterval: this.networkConfig.bundleInterval,
      pollingInterval: this.networkConfig.pollingInterval,
      maxSubmitAttempts: this.networkConfig.maxSubmitAttempts,
      bundleSize: this.networkConfig.bundleSize,
      standardMempoolId: this.networkConfig.standardMempoolId,
      canonicalEntryPoint: this.networkConfig.canonicalEntryPoint,
      supportedMempools: this.networkConfig.supportedMempools,
      gasFeeInSimulation: this.networkConfig.gasFeeInSimulation,
      skipBundleValidation: this.networkConfig.skipBundleValidation,
      pvgMarkup: this.networkConfig.pvgMarkup,
      cglMarkup: this.networkConfig.cglMarkup,
      vglMarkup: this.networkConfig.vglMarkup,
      paymasterVglMarkup: this.networkConfig.paymasterVglMarkup,
      paymasterPoglMarkup: this.networkConfig.paymasterPoglMarkup,
      estimationGasLimit: this.networkConfig.estimationGasLimit,
      archiveDuration: this.networkConfig.archiveDuration,
      pvgMarkupPercent: this.networkConfig.pvgMarkupPercent,
      cglMarkupPercent: this.networkConfig.cglMarkupPercent,
      vglMarkupPercent: this.networkConfig.vglMarkupPercent,
      paymasterVglMarkupPercent: this.networkConfig.paymasterVglMarkupPercent,
      paymasterPoglMarkupPercent: this.networkConfig.paymasterPoglMarkupPercent,
      userOpGasLimit: this.networkConfig.userOpGasLimit,
      bundleGasLimit: this.networkConfig.bundleGasLimit,
      blockscoutUrl: this.networkConfig.blockscoutUrl,
      blockscoutApiKeys: this.networkConfig.blockscoutApiKeys.length,
      tenderlyApiUrl: this.networkConfig.tenderlyApiUrl ? true : false,
      tenderlyKey: this.networkConfig.tenderlyKey ? true : false,
      tenderlySave: this.networkConfig.tenderlySave,
      rpcTimeout: this.networkConfig.rpcTimeout,
      disableWatchContract: this.networkConfig.disableWatchContract,
      epSimulationsContract: this.networkConfig.epSimulationsContract,
      pimlicoSimulationsContract: this.networkConfig.pimlicoSimulationsContract,
      binarySearchMaxRetries: this.networkConfig.binarySearchMaxRetries,
      precompiles: this.networkConfig.precompiles,
      relayOpsWithWhitelistedEntities: this.networkConfig.relayOpsWithWhitelistedEntities,
      stakingRegistryAddress: this.networkConfig.stakingRegistryAddress,
    };
  }

  /**
   * `sender`/`payer`/`factory`/`tx` are resolved by `FrameTxMempoolEntry`'s
   * validation-prefix parsing - there is no `entryPoint` concept for an
   * EIP-8141 frame transaction.
   */
  async getFrameTransactionStatus(
    hash: string
  ): Promise<FrameTransactionStatus> {
    const entry = await this.mempoolService.getEntryByHash(hash);
    if (entry == null) {
      throw new RpcError(
        "Frame transaction not found",
        RpcErrorCodes.INVALID_REQUEST
      );
    }

    const { tx, sender, payer, factory } = entry;
    const status =
      Object.keys(MempoolEntryStatus).find(
        (status) =>
          entry.status ===
          MempoolEntryStatus[status as keyof typeof MempoolEntryStatus]
      ) ?? "New";
    const reason = entry.revertReason;
    const transaction = entry.actualTransaction ?? entry.transaction;

    return {
      tx,
      sender,
      payer,
      factory,
      status,
      reason,
      transaction,
    };
  }

  connectedPeers(): unknown[] {
    const nodeApi = this.getNodeAPI();
    if(nodeApi) {
      return nodeApi.getConnectedPeers();
    }
    return [];
  }
}
