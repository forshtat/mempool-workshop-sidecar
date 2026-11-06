import { IWhitelistedEntities } from "@skandha/types/lib/executor";
import { INodeAPI } from "@skandha/types/lib/node/index.js";
import { Address, Hex } from "viem";

type BigNumberish = bigint | number | `0x${string}` | `${number}` | string;

export interface Log {
  blockNumber: number;
  blockHash: string;
  transactionIndex: number;

  removed: boolean;

  address: string;
  data: string;

  topics: Array<string>;

  transactionHash: string;
  logIndex: number;
}

export interface TracerResult {
  trace: TracerTracer;
  calls: TracerCall[];
}

export interface TracerTracer {
  [address: string]: {
    balance?: BigNumberish;
    contractSize?: number;
    number?: number;
    storage?: {
      [slot: string]: number | string;
    };
    keccak?: {
      [slot: string]: any;
    };
    violation?: {
      [opcode: string]: boolean;
    };
    value?: number;
  };
}

export interface TracerCall {
  type: string;
  from?: string;
  to?: string;
  method?: string;
  gas?: number;
  data?: string;
  return?: any;
  revert?: any;
  value?: BigNumberish;
}

export interface TracerPrestateResponse {
  [address: string]: {
    balance: BigNumberish;
    nonce: number;
    storage: {
      [slot: string]: number;
    };
    code: Hex;
  };
}

export type SupportedEntryPoints = string[];

export type EthChainIdResponse = { chainId: number };

export type BundlingMode = "auto" | "manual";

export type GetNodeAPI = () => INodeAPI | null;

export interface NetworkConfig {
  entryPoints: Hex[];
  relayers: Hex[];
  beneficiary: string;
  rpcEndpoint: string;
  minInclusionDenominator: number;
  throttlingSlack: number;
  banSlack: number;
  minSignerBalance: bigint;
  // minimum entity stake (in wei)
  // default: 0.01 ether
  minStake: bigint;
  // min unstake delay
  // default: 1
  minUnstakeDelay: number;
  // EIP-8421 IStakingRegistry contract address. Zero address (the default)
  // means "unconfigured" - StakingRegistryService then short-circuits to
  // zero stake for every entity without a chain call. See
  // docs/superpowers/specs/2026-09-30-naive-staking-registry-design.md.
  stakingRegistryAddress: Hex;
  // ERC-8421 [BUDGET-010] per-entity verification gas budgets (execution
  // gas summed over an entity's validation frames, plus the signature cost
  // for tx.sender). Defaults: MAX_VERIFY_GAS_PER_ENTITY = 100000 for an
  // unstaked entity, MAX_VERIFY_GAS_STAKED_ENTITY = 1000000 for a staked one.
  // Env: SKANDHA_MAX_VERIFY_GAS_PER_ENTITY, SKANDHA_MAX_VERIFY_GAS_STAKED_ENTITY.
  maxVerifyGasPerEntity: number;
  maxVerifyGasStakedEntity: number;
  multicall: string;
  // adds certain amount of gas to callGasLimit
  // 21000 by default
  estimationStaticBuffer: number;
  // gas limit during simulateHandleOps and simulateValidation calls
  // default = 10e6
  validationGasLimit: number;
  // limits the block range of getUserOperationByHash and getUserOperationReceipt
  // if requests to those endpoints are timing out, reduce this value
  // default = 1024
  receiptLookupRange: number;
  // etherscan api is used to fetch gas prices
  // default = "" (empty string)
  etherscanApiKey: string;
  // enables contidional rpc
  conditionalTransactions: boolean;
  // rpc endpoint that is used only during submission of a bundle
  rpcEndpointSubmit: string;
  // rpc method to be used to send the transaction
  rpcEndpointSubmitMethod: string;
  // adds % markup on reported gas price via skandha_getGasPrice
  // 10000 = 100.00%
  // 500 = 5%
  gasPriceMarkup: number;
  // do not bundle userops with low gas prices
  enforceGasPrice: boolean;
  // gas price threshold in bps
  // 10000 = 100.00%, 500 = 5%
  // if set to 500, then the userop's gas price is allowed to be
  // 5% lower than the networks gas prices
  enforceGasPriceThreshold: number;
  // enables eip-2930
  // pls check if the node supports eip-2930 before enabling this flag
  // can not be used in unsafeMode and on chains that dont support 1559
  eip2930: boolean;
  // Userops time to live in seconds
  // default is 300 (5 minutes)
  // after ttl you can replace a userop without increasing gas fees
  useropsTTL: number;
  // Entities that bypass stake and opcode validation
  // https://eips.ethereum.org/EIPS/eip-4337#alternative-mempools
  whitelistedEntities: IWhitelistedEntities;
  // adds some amount of gas to a estimated bundle
  bundleGasLimitMarkup: number;
  // Bounds how many submissions to the privileged ethrex endpoint can be in
  // flight at once - see BaseRelayer; there is no wallet pool to size this
  // by any more, since the one relaying strategy signs nothing.
  maxConcurrentSubmissions: number;
  // Interval of bundling
  // default is 10 seconds
  bundleInterval: number;
  // How many times MempoolReconciler will requeue an entry whose privileged
  // submission missed its one-shot inclusion window before giving up and
  // cancelling it (see BundlingService.selectEntries and
  // reconciliation.ts's reconcileSubmitted).
  maxSubmitAttempts: number;
  // max bundle size in terms of user ops
  // default is 4
  bundleSize: number;
  // adds markup on PVG
  // 1000 = adds 1000 gas on top of estimated PVG
  // default = 0
  pvgMarkup: number;
  // this node's standard (ERC-7562-derived) mempool id - one alt-mempool
  // among any number of others, not privileged as "canonical" (see
  // FrameTxValidationResult's doc comment)
  standardMempoolId: string;
  // canonical entry point
  canonicalEntryPoint: string;
  // array of supported mempools with their associated entry points
  // if not provided, falls back to standardMempoolId and canonicalEntryPoint if set
  // if provided, the standard mempool will be automatically added if not already included
  supportedMempools: Array<{ mempoolId: string; entryPoint: string }>;
  // add gas fee in simulated transactions (may be required for some rpc providers)
  gasFeeInSimulation: boolean;
  // skips bundle validation
  skipBundleValidation: boolean;
  userOpGasLimit: number; // 25kk by default
  bundleGasLimit: number; // 25kk by default
  // adds certain amount of gas to callGasLimit
  cglMarkup: number;
  // adds certain amount of gas to verificationGasLimit
  vglMarkup: number;
  // adds certain amount of gas to paymasterVerificationGasLimit
  paymasterVglMarkup: number;
  // adds certain amount of gas to paymasterPostOpGasLimit
  paymasterPoglMarkup: number;
  archiveDuration: number;
  estimationGasLimit: number;
  pvgMarkupPercent: number;
  cglMarkupPercent: number;
  vglMarkupPercent: number;
  paymasterVglMarkupPercent: number;
  paymasterPoglMarkupPercent: number;
  // enables / disabled eip1559
  eip1559: boolean;
  blockscoutUrl: string;
  blockscoutApiKeys: string[];
  tenderlyApiUrl: string;
  tenderlyKey: string;
  tenderlySave: boolean;
  rpcTimeout: string;
  pollingInterval: number;
  disableWatchContract: boolean;
  // simulation contracts
  epSimulationsContract: string;
  pimlicoSimulationsContract: string;
  // max number of retries for binary search on simulation contracts
  binarySearchMaxRetries: number;
  // list of precompiled addresses
  precompiles: string[];
  // flag to relay userops to connected peers via p2p when userop is validated because of whitelisted entities
  relayOpsWithWhitelistedEntities: boolean;
}

export type BundlerConfig = Omit<
  NetworkConfig,
  "entryPoints" | "rpcEndpoint" | "relayer" | "relayers"
>;

export interface ConfigOptions {
  config: NetworkConfig | null;
  testingMode?: boolean;
  unsafeMode: boolean;
  redirectRpc: boolean;
  explorer?: boolean;
}

export interface ExecutionResult {
  preOpGas: BigNumberish;
  paid: number;
  validAfter: number;
  validUntil: number;
  targetSuccess: boolean;
  targetResult: string;
}

export interface SimulateHandleOpSuccessResult {
  preOpGas: bigint;
  paid: bigint;
  accountValidationData: bigint;
  paymasterValidationData: bigint;
  paymasterVerificationGasLimit: bigint;
  paymasterPostOpGasLimit: bigint;
  targetSuccess: boolean;
  targetResult: Hex;
}

export type SimulateBinarySearchResult =
  | {
      result: "success";
      data: {
        gasUsed: bigint;
        success: boolean;
        returnData: Hex;
      };
    }
  | {
      result: "failed";
      data: string;
      code: number;
    };

export interface SimulateHandleOpResultAndGasLimits {
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  paymasterVerificationGasLimit: bigint;
  executionResult: SimulateHandleOpSuccessResult;
}

export interface StakeInfo {
  addr: string;
  stake: BigNumberish;
  unstakeDelaySec: BigNumberish;
  /** 0 while no withdrawal has been initiated; non-zero disqualifies the entity from being "staked" per ERC-8421's STAKING-010. */
  withdrawTime: BigNumberish;
}

export interface GetStakeStatus {
  stakeInfo: StakeInfo;
  isStaked: boolean;
}

export interface KnownEntities {
  accounts: string[];
  otherEntities: string[];
}

export interface ExecutionResultAndCallGasLimit {
  returnInfo: ExecutionResult;
  callGasLimit: BigNumberish;
}

export interface StateOverrides {
  [address: Address]: {
    balance?: BigNumberish;
    nonce?: BigNumberish;
    code?: Hex;
    state?: Record<Hex, Hex>;
    stateDiff?: Record<Hex, Hex>;
  };
}

export interface DepositInfoStructOutput {
    deposit: BigNumberish;
    staked: boolean;
    stake: BigNumberish;
    unstakeDelaySec: number;
    withdrawTime: number;
}
