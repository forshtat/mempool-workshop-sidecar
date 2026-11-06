// TODO: create a new package "config" instead of this file and refactor
import { IEntity } from "@skandha/types/lib/executor/index.js";
import { AddressZero } from "@skandha/params/lib/index.js";
import {
  createPublicClient,
  http,
  PublicClient,
  createWalletClient,
  WalletClient,
  Chain,
  Hex,
  parseEther,
  getAddress,
} from "viem";
import { nonceManager, privateKeyToAccount } from "viem/accounts";
import { BundlerConfig, ConfigOptions, NetworkConfig } from "./interfaces.js";
import { getViemChainDef } from "./services/BundlingService/utils/chains.js";

export class Config {
  testingMode: boolean;
  unsafeMode: boolean;
  redirectRpc: boolean;
  explorerEnabled: boolean;
  /** Dedicated faucet account, from `SKANDHA_FAUCET_KEY`. Only used with the explorer on. */
  faucetKey?: Hex;
  config: NetworkConfig;
  chainId: number;
  accounts: Hex[] = [];
  chain?: Chain;

  constructor(options: ConfigOptions) {
    this.testingMode = options.testingMode ?? false;
    this.unsafeMode = options.unsafeMode ?? false;
    this.redirectRpc = options.redirectRpc ?? false;
    this.explorerEnabled = options.explorer ?? false;
    this.faucetKey = this.explorerEnabled
      ? ((process.env.SKANDHA_FAUCET_KEY || undefined) as Hex | undefined)
      : undefined;
    this.config = this.getDefaultNetworkConfig(options.config);
    this.chainId = 0;
  }

  static async init(configOptions: ConfigOptions): Promise<Config> {
    const config = new Config(configOptions);
    try {
      await config.fetchChainId();
      await config.fetchAccounts();
    } catch (err) {
      // trying again with skipping ssl errors
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      await config.fetchChainId();
    }
    return config;
  }

  // replacement for getNetworkProvider()
  getPublicClient(): PublicClient {
    return createPublicClient({
      transport: http(this.config.rpcEndpoint),
      chain: this.chain,
    });
  }

  getRelayers(): WalletClient[] | null {
    if (this.testingMode) {
      return [
        createWalletClient({
          transport: http(this.config.rpcEndpoint),
          account: this.accounts[0],
          chain: this.chain,
        }),
      ];
    }

    const wallets = [];
    for (const privKey of this.config.relayers) {
      const wallet = createWalletClient({
        transport: http(this.config.rpcEndpoint),
        account: privateKeyToAccount(privKey as `0x${string}`),
        chain: this.chain,
      });
      wallets.push(wallet);
    }
    return wallets;
  }

  getFaucetWallet(): WalletClient | null {
    if (!this.faucetKey) return null;
    return createWalletClient({
      transport: http(this.config.rpcEndpoint),
      account: privateKeyToAccount(this.faucetKey, { nonceManager }),
      chain: this.chain,
    });
  }

  getBeneficiary(): string | null {
    return this.config.beneficiary;
  }

  getNetworkConfig(): NetworkConfig {
    return this.config;
  }

  /**
   * Get all supported mempools from config
   * Returns array of {mempoolId, entryPoint} objects
   * Falls back to the standard mempool if supportedMempools is not configured
   */
  getSupportedMempools(): Array<{ mempoolId: string; entryPoint: string }> {
    if (this.config.supportedMempools && this.config.supportedMempools.length > 0) {
      return this.config.supportedMempools;
    }
    // Fallback to the standard mempool if supportedMempools not configured
    if (this.config.standardMempoolId && this.config.canonicalEntryPoint) {
      return [
        {
          mempoolId: this.config.standardMempoolId,
          entryPoint: this.config.canonicalEntryPoint,
        },
      ];
    }
    return [];
  }

  async fetchChainId(): Promise<void> {
    const client = this.getPublicClient();

    try {
      this.chainId = await client.getChainId();
      this.chain = getViemChainDef(this.chainId);
    } catch (error) {
      throw new Error("Could not fetch chain id");
    }
  }

  async fetchAccounts(): Promise<void> {
    if (this.testingMode) {
      const walletClient = createWalletClient({
        transport: http(this.config.rpcEndpoint),
        chain: this.chain,
      });
      this.accounts = await walletClient.getAddresses();
    }
  }

  isEntryPointSupported(entryPoint: string): boolean {
    return this.config.entryPoints.some(
      (addr) => addr.toLowerCase() === entryPoint.toLowerCase()
    );
  }

  private getDefaultNetworkConfig(config: NetworkConfig | null): NetworkConfig {
    if (config == null) config = {} as NetworkConfig;
    config.entryPoints = fromEnvVar(
      "ENTRYPOINTS",
      config.entryPoints ?? [],
      true
    ) as Hex[];

    config.relayers = fromEnvVar("RELAYERS", config.relayers, true) as Hex[];

    config.beneficiary = fromEnvVar(
      "BENEFICIARY",
      config.beneficiary || bundlerDefaultConfigs.beneficiary
    ) as string;

    config.rpcEndpoint = fromEnvVar("RPC", config.rpcEndpoint) as string;

    if (this.testingMode && !config.rpcEndpoint) {
      config.rpcEndpoint = "http://localhost:8545"; // local geth
    }

    config.etherscanApiKey = fromEnvVar(
      "ETHERSCAN_API_KEY",
      config.etherscanApiKey || bundlerDefaultConfigs.etherscanApiKey
    ) as string;
    config.receiptLookupRange = Number(
      fromEnvVar(
        "RECEIPT_LOOKUP_RANGE",
        config.receiptLookupRange || bundlerDefaultConfigs.receiptLookupRange
      )
    );
    config.conditionalTransactions = Boolean(
      fromEnvVar(
        "CONDITIONAL_TRANSACTIONS",
        config.conditionalTransactions ||
          bundlerDefaultConfigs.conditionalTransactions
      )
    );
    config.rpcEndpointSubmit = fromEnvVar(
      "RPC_SUBMIT",
      config.rpcEndpointSubmit || bundlerDefaultConfigs.rpcEndpointSubmit
    ) as string;
    config.rpcEndpointSubmitMethod = fromEnvVar(
      "RPC_SUBMIT_METHOD",
      config.rpcEndpointSubmitMethod || bundlerDefaultConfigs.rpcEndpointSubmitMethod
    ) as string;
    config.gasPriceMarkup = Number(
      fromEnvVar(
        "GAS_PRICE_MARKUP",
        config.gasPriceMarkup || bundlerDefaultConfigs.gasPriceMarkup
      )
    );
    config.enforceGasPrice = Boolean(
      fromEnvVar(
        "ENFORCE_GAS_PRICE",
        config.enforceGasPrice || bundlerDefaultConfigs.enforceGasPrice
      )
    );
    config.enforceGasPriceThreshold = Number(
      fromEnvVar(
        "ENFORCE_GAS_PRICE_THRESHOLD",
        config.enforceGasPriceThreshold ||
          bundlerDefaultConfigs.enforceGasPriceThreshold
      )
    );
    config.eip2930 = Boolean(
      fromEnvVar("EIP2930", config.eip2930 || bundlerDefaultConfigs.eip2930)
    );
    config.useropsTTL = Number(
      fromEnvVar(
        "USEROPS_TTL",
        config.useropsTTL || bundlerDefaultConfigs.useropsTTL
      )
    );

    config.minStake = BigInt(
      fromEnvVar(
        "MIN_STAKE",
        config.minStake ?? bundlerDefaultConfigs.minStake
      ) as string
    );

    config.minUnstakeDelay = Number(
      fromEnvVar(
        "MIN_UNSTAKE_DELAY",
        config.minUnstakeDelay || bundlerDefaultConfigs.minUnstakeDelay
      )
    );

    config.maxVerifyGasPerEntity = Number(
      fromEnvVar(
        "MAX_VERIFY_GAS_PER_ENTITY",
        config.maxVerifyGasPerEntity ??
          bundlerDefaultConfigs.maxVerifyGasPerEntity
      )
    );
    config.maxVerifyGasStakedEntity = Number(
      fromEnvVar(
        "MAX_VERIFY_GAS_STAKED_ENTITY",
        config.maxVerifyGasStakedEntity ??
          bundlerDefaultConfigs.maxVerifyGasStakedEntity
      )
    );
    for (const [key, value] of [
      ["maxVerifyGasPerEntity", config.maxVerifyGasPerEntity],
      ["maxVerifyGasStakedEntity", config.maxVerifyGasStakedEntity],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid config: ${key} must be a positive integer, got ${value}`);
      }
    }
    if (config.maxVerifyGasStakedEntity < config.maxVerifyGasPerEntity) {
      throw new Error(
        "Invalid config: maxVerifyGasStakedEntity must be >= maxVerifyGasPerEntity"
      );
    }

    config.stakingRegistryAddress = fromEnvVar(
      "STAKING_REGISTRY_ADDRESS",
      config.stakingRegistryAddress || bundlerDefaultConfigs.stakingRegistryAddress
    ) as Hex;
    // Catches a typo/malformed address immediately at startup, rather than
    // letting it reach StakingRegistryService - which only short-circuits
    // on the exact zero address (see its own comment on why), so any other
    // codeless/malformed value would otherwise silently fail every
    // eth_sendFrameTransaction with a bare "Unexpected behaviour" the first
    // time a frame transaction actually references a staked entity.
    getAddress(config.stakingRegistryAddress);
    config.bundleGasLimitMarkup = Number(
      fromEnvVar(
        "BUNDLE_GAS_LIMIT_MARKUP",
        config.bundleGasLimitMarkup ||
          bundlerDefaultConfigs.bundleGasLimitMarkup
      )
    );
    config.bundleInterval = Number(
      fromEnvVar(
        "BUNDLE_INTERVAL",
        config.bundleInterval || bundlerDefaultConfigs.bundleInterval
      )
    );

    config.maxSubmitAttempts = Number(
      fromEnvVar(
        "MAX_SUBMIT_ATTEMPTS",
        config.maxSubmitAttempts || bundlerDefaultConfigs.maxSubmitAttempts
      )
    );

    config.bundleSize = Number(
      fromEnvVar(
        "BUNDLE_SIZE",
        config.bundleSize || bundlerDefaultConfigs.bundleSize
      )
    );

    config.maxConcurrentSubmissions = Number(
      fromEnvVar(
        "MAX_CONCURRENT_SUBMISSIONS",
        config.maxConcurrentSubmissions ||
          bundlerDefaultConfigs.maxConcurrentSubmissions
      )
    );

    config.pvgMarkup = Number(
      fromEnvVar(
        "PVG_MARKUP",
        config.pvgMarkup || bundlerDefaultConfigs.pvgMarkup
      )
    );

    config.standardMempoolId = String(
      fromEnvVar(
        "STANDARD_MEMPOOL_ID",
        config.standardMempoolId || bundlerDefaultConfigs.standardMempoolId
      )
    );

    config.canonicalEntryPoint = String(
      fromEnvVar(
        "CANONICAL_ENTRY_POINT",
        config.canonicalEntryPoint || bundlerDefaultConfigs.canonicalEntryPoint
      )
    );

    config.supportedMempools = JSON.parse(String(
      fromEnvVar(
        "SUPPORTED_MEMPOOLS",
        config.supportedMempools ? JSON.stringify(config.supportedMempools) : JSON.stringify(bundlerDefaultConfigs.supportedMempools)
      )
    ))

    // Parse supportedMempools from config or env var
    // If not provided and standardMempoolId is set, use the standard mempool as default
    if (!config.supportedMempools || config.supportedMempools.length === 0) {
      if (config.standardMempoolId && config.canonicalEntryPoint) {
        config.supportedMempools = [
          {
            mempoolId: config.standardMempoolId,
            entryPoint: config.canonicalEntryPoint,
          },
        ];
      } else {
        config.supportedMempools = bundlerDefaultConfigs.supportedMempools;
      }
    } else {
      // Ensure the standard mempool is included in supportedMempools if it's set
      if (config.standardMempoolId && config.canonicalEntryPoint) {
        const standardInSupported = config.supportedMempools.some(
          (mempool) =>
            mempool.mempoolId === config.standardMempoolId &&
            mempool.entryPoint.toLowerCase() === config.canonicalEntryPoint.toLowerCase()
        );
        if (!standardInSupported) {
          // Add the standard mempool to the beginning of the array
          config.supportedMempools.unshift({
            mempoolId: config.standardMempoolId,
            entryPoint: config.canonicalEntryPoint,
          });
        }
      }
    }

    config.gasFeeInSimulation = Boolean(
      fromEnvVar(
        "GAS_FEE_IN_SIMULATION",
        config.gasFeeInSimulation || bundlerDefaultConfigs.gasFeeInSimulation
      )
    );

    config.throttlingSlack = Number(
      fromEnvVar(
        "THROTTLING_SLACK",
        config.throttlingSlack || bundlerDefaultConfigs.throttlingSlack
      )
    );

    config.banSlack = Number(
      fromEnvVar("BAN_SLACK", config.banSlack || bundlerDefaultConfigs.banSlack)
    );

    config.minInclusionDenominator = Number(
      fromEnvVar(
        "MIN_INCLUSION_DENOMINATOR",
        config.minInclusionDenominator ||
          bundlerDefaultConfigs.minInclusionDenominator
      )
    );

    config.skipBundleValidation = Boolean(
      fromEnvVar(
        "SKIP_BUNDLE_VALIDATION",
        config.skipBundleValidation ||
          bundlerDefaultConfigs.skipBundleValidation
      )
    );

    config.bundleGasLimit = Number(
      fromEnvVar(
        "BUNDLE_GAS_LIMIT",
        config.bundleGasLimit || bundlerDefaultConfigs.bundleGasLimit
      )
    );

    config.userOpGasLimit = Number(
      fromEnvVar(
        "USEROP_GAS_LIMIT",
        config.userOpGasLimit || bundlerDefaultConfigs.userOpGasLimit
      )
    );

    config.cglMarkup = Number(
      fromEnvVar(
        "CGL_MARKUP",
        config.cglMarkup || bundlerDefaultConfigs.cglMarkup
      )
    );

    config.vglMarkup = Number(
      fromEnvVar(
        "VGL_MARKUP",
        config.vglMarkup || bundlerDefaultConfigs.vglMarkup
      )
    );

    config.paymasterVglMarkup = Number(
      fromEnvVar(
        "PAYMASTER_VGL_MARKUP",
        config.paymasterVglMarkup || bundlerDefaultConfigs.paymasterVglMarkup
      )
    );

    config.paymasterPoglMarkup = Number(
      fromEnvVar(
        "PAYMASTER_POGL_MARKUP",
        config.paymasterPoglMarkup || bundlerDefaultConfigs.paymasterPoglMarkup
      )
    );

    config.archiveDuration = Number(
      fromEnvVar(
        "ARCHIVE_DURATION",
        config.archiveDuration || bundlerDefaultConfigs.archiveDuration
      )
    );

    config.pvgMarkupPercent = Number(
      fromEnvVar(
        "PVG_MARKUP_PERCENT",
        config.pvgMarkupPercent || bundlerDefaultConfigs.pvgMarkupPercent
      )
    );
    config.cglMarkupPercent = Number(
      fromEnvVar(
        "CGL_MARKUP_PERCENT",
        config.cglMarkupPercent || bundlerDefaultConfigs.cglMarkupPercent
      )
    );
    config.vglMarkupPercent = Number(
      fromEnvVar(
        "VGL_MARKUP_PERCENT",
        config.vglMarkupPercent || bundlerDefaultConfigs.vglMarkupPercent
      )
    );
    config.paymasterVglMarkupPercent = Number(
      fromEnvVar(
        "PAYMASTER_VGL_MARKUP_PERCENT",
        config.paymasterVglMarkupPercent ||
          bundlerDefaultConfigs.paymasterVglMarkupPercent
      )
    );
    config.paymasterPoglMarkupPercent = Number(
      fromEnvVar(
        "PAYMASTER_POGL_MARKUP_PERCENT",
        config.paymasterPoglMarkupPercent ||
          bundlerDefaultConfigs.paymasterPoglMarkupPercent
      )
    );

    config.eip1559 = Boolean(
      fromEnvVar(
        "EIP1559",
        config.eip1559 !== undefined
          ? config.eip1559
          : bundlerDefaultConfigs.eip1559
      )
    );

    config.blockscoutUrl = String(
      fromEnvVar(
        "BLOCKSCOUT_URL",
        config.blockscoutUrl || bundlerDefaultConfigs.blockscoutUrl
      )
    );

    config.tenderlyApiUrl = String(
      fromEnvVar(
        "TENDERLY_API_URL",
        config.tenderlyApiUrl || bundlerDefaultConfigs.tenderlyApiUrl
      )
    );

    config.tenderlyKey = String(
      fromEnvVar(
        "TENDERLY_KEY",
        config.tenderlyKey || bundlerDefaultConfigs.tenderlyKey
      )
    );

    config.tenderlySave = Boolean(
      fromEnvVar(
        "TENDERLY_SAVE",
        config.tenderlySave === false
          ? config.tenderlySave
          : bundlerDefaultConfigs.tenderlySave
      )
    );

    config.rpcTimeout = String(
      fromEnvVar(
        "RPC_TIMEOUT",
        config.rpcTimeout || bundlerDefaultConfigs.rpcTimeout
      )
    );

    config.blockscoutApiKeys = fromEnvVar(
      "BLOCKSCOUT_API_KEYS",
      config.blockscoutApiKeys != undefined
        ? config.blockscoutApiKeys
        : bundlerDefaultConfigs.blockscoutApiKeys,
      true
    ) as string[];

    config.pollingInterval = Number(
      fromEnvVar(
        "POLLING_INTERVAL",
        config.pollingInterval || bundlerDefaultConfigs.pollingInterval
      )
    );

    config.disableWatchContract = Boolean(
      fromEnvVar(
        "DISABLE_WATCH_CONTRACT",
        config.disableWatchContract ||
          bundlerDefaultConfigs.disableWatchContract
      )
    );

    config.binarySearchMaxRetries = Number(
      fromEnvVar(
        "BINARY_SEARCH_MAX_RETRIES",
        config.binarySearchMaxRetries ||
          bundlerDefaultConfigs.binarySearchMaxRetries
      )
    );

    config.epSimulationsContract = String(
      fromEnvVar(
        "EP_SIMULATIONS_CONTRACT",
        config.epSimulationsContract ||
          bundlerDefaultConfigs.epSimulationsContract
      )
    );

    config.pimlicoSimulationsContract = String(
      fromEnvVar(
        "PIMLICO_SIMULATIONS_CONTRACT",
        config.pimlicoSimulationsContract ||
          bundlerDefaultConfigs.pimlicoSimulationsContract
      )
    );

    config.precompiles = fromEnvVar(
      "PRECOMPILES",
      config.precompiles || bundlerDefaultConfigs.precompiles,
      true
    ) as string[];

    config.relayOpsWithWhitelistedEntities = Boolean(
      fromEnvVar(
        "RELAY_OPS_WITH_WHITELISTED_ENTITIES",
        config.relayOpsWithWhitelistedEntities || bundlerDefaultConfigs.relayOpsWithWhitelistedEntities
      )
    );

    // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
    if (!config.whitelistedEntities) {
      config.whitelistedEntities = bundlerDefaultConfigs.whitelistedEntities;
    }

    /**
     * validate whitelist addresses
     */
    for (const entity of ["paymaster", "account", "factory", "external"]) {
      config.whitelistedEntities[entity as IEntity] = fromEnvVar(
        `WL_${entity.toUpperCase()}`,
        config.whitelistedEntities[entity as IEntity],
        true
      ) as string[];
      const entities = config.whitelistedEntities[entity as IEntity];
      if (typeof entities != "undefined" && typeof entities != "object") {
        throw new Error("Invalid config");
      }
      if (typeof entities == "object") {
        for (const address of entities) {
          // will throw error if the address is invalid
          getAddress(address);
        }
      }
    }

    return Object.assign({}, bundlerDefaultConfigs, config);
  }
}

const bundlerDefaultConfigs: BundlerConfig = {
  beneficiary: "",
  minInclusionDenominator: 10,
  throttlingSlack: 10,
  banSlack: 50,
  minStake: parseEther("0.01"),
  minUnstakeDelay: 0,
  // ERC-8421 §Constants MAX_VERIFY_GAS_PER_ENTITY / MAX_VERIFY_GAS_STAKED_ENTITY
  maxVerifyGasPerEntity: 100_000,
  maxVerifyGasStakedEntity: 1_000_000,
  stakingRegistryAddress: AddressZero,
  minSignerBalance: parseEther("0.1"),
  multicall: "0xcA11bde05977b3631167028862bE2a173976CA11", // default multicall address
  estimationStaticBuffer: 35000,
  validationGasLimit: 10e6,
  receiptLookupRange: 1024,
  etherscanApiKey: "",
  conditionalTransactions: false,
  rpcEndpointSubmit: "",
  rpcEndpointSubmitMethod: "eth_sendBundle",
  gasPriceMarkup: 0,
  enforceGasPrice: false,
  enforceGasPriceThreshold: 1000,
  eip2930: false,
  useropsTTL: 300, // 5 minutes
  whitelistedEntities: {
    paymaster: [],
    account: [],
    factory: [],
    external: [],
  },
  bundleGasLimitMarkup: 25000,
  bundleInterval: 10000, // 10 seconds
  // How many times MempoolReconciler will requeue a missed submission
  // before giving up and cancelling the entry. The privileged endpoint tries a
  // submission against one payload only, and a busy block can leave a valid
  // transaction out, so one retry (the old default of 1) cancelled
  // transactions that a third try would have landed.
  maxSubmitAttempts: 3,
  bundleSize: 4, // max size of bundle (in terms of user ops)
  // Bounds how many submissions to the privileged ethrex endpoint can be in
  // flight at once - there is no wallet pool to size this by any more (the
  // only relaying strategy signs nothing), so it's a plain number.
  maxConcurrentSubmissions: 10,
  standardMempoolId: "",
  canonicalEntryPoint: "",
  supportedMempools: [],
  gasFeeInSimulation: false,
  skipBundleValidation: false,
  userOpGasLimit: 25000000,
  bundleGasLimit: 25000000,
  cglMarkup: 0,
  vglMarkup: 0,
  pvgMarkup: 0,
  paymasterVglMarkup: 0,
  paymasterPoglMarkup: 0,
  archiveDuration: 24 * 3600,
  estimationGasLimit: 0,
  pvgMarkupPercent: 0,
  cglMarkupPercent: 0,
  vglMarkupPercent: 0,
  paymasterVglMarkupPercent: 0,
  paymasterPoglMarkupPercent: 0,
  eip1559: true,
  blockscoutUrl: "",
  blockscoutApiKeys: [],
  tenderlyApiUrl: "",
  tenderlyKey: "",
  tenderlySave: true,
  rpcTimeout: "10s",
  pollingInterval: 3000,
  disableWatchContract: false,
  epSimulationsContract: "",
  pimlicoSimulationsContract: "",
  binarySearchMaxRetries: 3,
  precompiles: [],
  relayOpsWithWhitelistedEntities: false,
};

function getEnvVar<T>(envVar: string, fallback: T): T | string {
  const env = process.env[envVar];
  if (!env) return fallback;
  return env;
}

function fromEnvVar<T>(
  envVar = "",
  fallback: T,
  isArray = false
): T | string | string[] {
  const envVarName = `SKANDHA_${envVar}`;
  const envVarOrFallback = getEnvVar(envVarName, fallback);
  if (isArray && typeof envVarOrFallback === "string") {
    return (envVarOrFallback as string)
      .toLowerCase()
      .replace(/ /g, "")
      .split(",");
  }
  return envVarOrFallback;
}
