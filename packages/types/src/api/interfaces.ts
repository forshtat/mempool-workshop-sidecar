import { GetTransactionReceiptReturnType } from "viem";
import { IWhitelistedEntities } from "../executor/index.js";
import { UserOperation } from "../contracts/UserOperation.js";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

export type EstimatedUserOperationGas = {
  preVerificationGas: BigNumberish;
  verificationGas: BigNumberish;
  verificationGasLimit: BigNumberish;
  callGasLimit: BigNumberish;
  paymasterVerificationGasLimit?: BigNumberish;
  paymasterPostOpGasLimit?: BigNumberish;
  validAfter?: BigNumberish;
  validUntil?: BigNumberish;
} & GetGasPriceResponse;

export type UserOperationByHashResponse = {
  userOperation: UserOperation;
  entryPoint: string;
  blockNumber?: bigint;
  blockHash?: string;
  transactionHash?: string;
};

export type GetGasPriceResponse = {
  maxFeePerGas: BigNumberish;
  maxPriorityFeePerGas: BigNumberish;
};

export type GetFeeHistoryResponse = {
  actualGasPrice: BigNumberish[];
  maxFeePerGas: BigNumberish[];
  maxPriorityFeePerGas: BigNumberish[];
};

export type UserOperationReceipt = {
  userOpHash: string;
  sender: string;
  nonce: BigNumberish;
  paymaster?: string;
  actualGasCost: BigNumberish;
  actualGasUsed: BigNumberish;
  success: boolean;
  reason?: string;
  logs: any[];
  receipt: GetTransactionReceiptReturnType;
};

export type GetConfigResponse = {
  chainId: number;
  flags: {
    redirectRpc: boolean;
    testingMode: boolean;
  };
  entryPoints: string[];
  beneficiary: string;
  relayers: string[];
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
  minSignerBalance: string;
  minStake: string;
  minUnstakeDelay: number;
  /**
   * ERC-8421 [BUDGET-010] verification gas budgets this node enforces, per
   * entity: `maxVerifyGasPerEntity` for an unstaked (or default-code) entity,
   * `maxVerifyGasStakedEntity` for a staked one (stake >= `minStake`, delay
   * >= `minUnstakeDelay`, no withdrawal). The intrinsic signature cost counts
   * toward `tx.sender`. `maxVerifyStateGas` is the separate prefix-wide
   * state-gas cap (EIP-8141).
   */
  budgets: {
    rule: "BUDGET-010";
    maxVerifyGasPerEntity: number;
    maxVerifyGasStakedEntity: number;
    signatureCostAttributedTo: "sender";
    maxVerifyStateGas: number;
  };
  multicall: string;
  estimationStaticBuffer: number;
  validationGasLimit: number;
  receiptLookupRange: number;
  etherscanApiKey: boolean; // true if set
  conditionalTransactions: boolean;
  rpcEndpointSubmit: boolean; // true if not empty string
  rpcEndpointSubmitMethod: string;
  gasPriceMarkup: number;
  enforceGasPrice: boolean;
  enforceGasPriceThreshold: number;
  eip1559: boolean;
  eip2930: boolean;
  useropsTTL: number;
  whitelistedEntities: IWhitelistedEntities;
  bundleGasLimitMarkup: number;
  maxConcurrentSubmissions: number;
  bundleInterval: number;
  pollingInterval: number;
  maxSubmitAttempts: number;
  bundleSize: number;
  pvgMarkup: number;
  standardMempoolId: string;
  canonicalEntryPoint: string;
  supportedMempools: Array<{ mempoolId: string; entryPoint: string }>;
  gasFeeInSimulation: boolean;
  skipBundleValidation: boolean;
  cglMarkup: number;
  vglMarkup: number;
  paymasterVglMarkup: number;
  paymasterPoglMarkup: number
  archiveDuration: number;
  estimationGasLimit: number;
  pvgMarkupPercent: number;
  cglMarkupPercent: number;
  vglMarkupPercent: number;
  paymasterVglMarkupPercent: number;
  paymasterPoglMarkupPercent: number;
  userOpGasLimit: number;
  bundleGasLimit: number;
  blockscoutUrl: string;
  blockscoutApiKeys: number;
  tenderlyApiUrl: boolean; // true if set
  tenderlyKey: boolean; // true if set
  tenderlySave: boolean;
  rpcTimeout: string;
  disableWatchContract: boolean;
  epSimulationsContract: string;
  pimlicoSimulationsContract: string;
  binarySearchMaxRetries: number;
  precompiles: string[];
  stakingRegistryAddress: string;
  relayOpsWithWhitelistedEntities: boolean
};

export type SupportedEntryPoints = string[];

export type EthChainIdResponse = { chainId: number };

export type BundlingMode = "auto" | "manual";

export interface ServerConfig {
  enableRequestLogging: boolean;
  port: number;
  host: string;
  cors: string;
  ws: boolean;
  wsPort: number;
}

export type UserOperationStatus = {
  userOp: UserOperation;
  entryPoint: string;
  status: string;
  transaction?: string;
  reason?: string;
};
