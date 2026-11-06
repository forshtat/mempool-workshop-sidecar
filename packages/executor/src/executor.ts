/* eslint-disable @typescript-eslint/explicit-member-accessibility */
import { IDbController, Logger } from "@skandha/types/lib/index.js";
import { chainsWithoutEIP1559 } from "@skandha/params/lib/index.js";
import { PerChainMetrics } from "@skandha/monitoring/lib/index.js";
import { SkandhaVersion } from "@skandha/types/lib/executor/index.js";
import { PublicClient } from "viem";
import { Web3, Debug, Eth, Skandha, Explorer } from "./modules/index.js";
import {
  MempoolService,
  BundlingService,
  ReputationService,
  ExecutorEventBus,
  SubscriptionService,
} from "./services/index.js";
import { FrameTxValidationService } from "./services/UserOpValidation/validators/frameTx.js";
import { FrameTxSimulationService } from "./services/FrameTxSimulationService/index.js";
import { ReceiptService } from "./services/ReceiptService/index.js";
import { StakingRegistryService } from "./services/StakingRegistryService/index.js";
import { ExplorerService } from "./services/ExplorerService/service.js";
import { FaucetService } from "./services/FaucetService/index.js";
import { Config } from "./config.js";
import { BundlingMode, GetNodeAPI, NetworkConfig } from "./interfaces.js";

export interface ExecutorOptions {
  version: SkandhaVersion;
  chainId: number;
  db: IDbController;
  config: Config;
  logger: Logger;
  getNodeApi?: GetNodeAPI;
  bundlingMode: BundlingMode;
  metrics: PerChainMetrics | null;
}

export class Executor {
  private networkConfig: NetworkConfig;
  private logger: Logger;
  private metrics: PerChainMetrics | null;

  public version: SkandhaVersion;
  public chainId: number;
  public config: Config;
  public publicClient: PublicClient;

  public web3: Web3;
  public debug: Debug;
  public eth: Eth;
  public explorer: Explorer;
  public skandha: Skandha;

  public bundlingService: BundlingService;
  public mempoolService: MempoolService;
  public reputationService: ReputationService;
  // frame-tx services backing this.eth
  public stakingRegistryService: StakingRegistryService;
  public frameTxValidationService: FrameTxValidationService;
  public frameTxSimulationService: FrameTxSimulationService;
  public receiptService: ReceiptService;
  // eventBus is used to propagate different events across executor service
  public eventBus: ExecutorEventBus;
  // ws subscription service listens the eventBus and sends event to ws listeners
  public subscriptionService: SubscriptionService;
  // Present only when started with --explorer.enable; records admissions and lifecycle history.
  public explorerService: ExplorerService | null = null;
  // Present only with --explorer.enable and SKANDHA_FAUCET_KEY set.
  public faucet: FaucetService | null = null;

  private db: IDbController;

  private getNodeApi: GetNodeAPI;

  constructor(options: ExecutorOptions) {
    this.version = options.version;
    this.db = options.db;
    this.config = options.config;
    this.logger = options.logger;
    this.chainId = options.chainId;
    this.getNodeApi = options.getNodeApi ?? (() => null);
    this.metrics = options.metrics;

    this.networkConfig = options.config.getNetworkConfig();

    this.publicClient = this.config.getPublicClient();

    this.eventBus = new ExecutorEventBus();
    if (this.config.explorerEnabled) {
      this.explorerService = new ExplorerService();
      this.explorerService.attach(this.eventBus);
      this.logger.info("[x] EXPLORER (skandha_explorer_* RPC and history)");
      const faucetWallet = this.config.getFaucetWallet();
      if (faucetWallet) {
        this.faucet = new FaucetService(faucetWallet, this.publicClient);
        this.logger.info(
          `[x] FAUCET (skandha_explorer_faucet, from ${faucetWallet.account?.address})`
        );
      }
    }
    this.subscriptionService = new SubscriptionService(
      this.eventBus,
      this.logger,
      this.explorerService
    );

    this.reputationService = new ReputationService(
      this.db,
      this.chainId,
      this.networkConfig.minInclusionDenominator,
      this.networkConfig.throttlingSlack,
      this.networkConfig.banSlack,
      this.networkConfig.minStake,
      this.networkConfig.minUnstakeDelay
    );

    this.mempoolService = new MempoolService(
      this.db,
      this.chainId,
      this.reputationService,
      this.eventBus,
      this.networkConfig,
      this.logger,
      (address) => this.publicClient.getBalance({ address })
    );

    this.skandha = new Skandha(
      this.mempoolService,
      this.chainId,
      this.publicClient,
      this.config,
      this.logger,
      this.getNodeApi
    );

    // The EIP-8421 IStakingRegistry contract address. Zero (the default,
    // per `NetworkConfig.stakingRegistryAddress`'s own doc comment) means
    // unconfigured - `StakingRegistryService` short-circuits to zero stake
    // for every entity without a chain call. Set
    // `SKANDHA_STAKING_REGISTRY_ADDRESS` (or `stakingRegistryAddress` in
    // config.json) to a real deployment - see
    // `deploy/predeploy/src/protocols/staking-registry.ts` for the naive
    // devnet deployment this points at by convention.
    this.stakingRegistryService = new StakingRegistryService(
      this.publicClient,
      this.networkConfig.stakingRegistryAddress
    );

    this.frameTxValidationService = new FrameTxValidationService(
      this.stakingRegistryService,
      this.reputationService,
      this.networkConfig,
      this.logger,
      (address) => this.publicClient.getBalance({ address }),
      (address) => this.publicClient.getCode({ address })
    );

    this.frameTxSimulationService = new FrameTxSimulationService(
      this.publicClient,
      this.frameTxValidationService,
      this.logger
    );

    this.receiptService = new ReceiptService(this.publicClient);

    // No `entryPointService`/`userOpValidationService` arguments - the
    // service relays already-signed frame transactions instead of
    // assembling and re-validating a `handleOps` batch. See its class
    // comment for the deliberate gap this leaves around pre-submission
    // re-simulation, and for what `frameTxSimulationService`/
    // `receiptService` are used for here (`MempoolReconciler`, not dispatch).
    this.bundlingService = new BundlingService(
      this.chainId,
      this.publicClient,
      this.mempoolService,
      this.reputationService,
      this.eventBus,
      this.config,
      this.logger,
      this.metrics,
      this.receiptService,
      this.frameTxSimulationService
    );

    this.web3 = new Web3(this.config, this.version);
    this.debug = new Debug(
      this.publicClient,
      this.bundlingService,
      this.mempoolService,
      this.reputationService,
      this.networkConfig
    );

    this.eth = new Eth(
      this.chainId,
      this.publicClient,
      this.frameTxSimulationService,
      this.receiptService,
      this.mempoolService,
      this.skandha,
      this.networkConfig,
      this.logger,
      this.metrics,
      this.getNodeApi,
      this.explorerService ?? undefined
    );

    this.explorer = new Explorer(
      this.chainId,
      this.version,
      this.bundlingService,
      this.mempoolService,
      this.explorerService,
      this.getNodeApi,
      this.reputationService,
      this.stakingRegistryService,
      this.networkConfig.minStake,
      this.networkConfig.minUnstakeDelay,
      this.networkConfig.minInclusionDenominator,
      this.networkConfig.throttlingSlack,
      this.networkConfig.banSlack,
      this.faucet != null
    );

    if (this.config.testingMode || options.bundlingMode == "manual") {
      this.bundlingService.setBundlingMode("manual");
      this.logger.info("[X] MANUAL BUNDLING");
    }
    if (this.config.testingMode) {
      this.bundlingService.setMaxBundleSize(10);
    }

    if (this.networkConfig.conditionalTransactions) {
      this.logger.info("[x] CONDITIONAL TRANSACTIONS");
    }

    if (this.networkConfig.rpcEndpointSubmit) {
      this.logger.info("[x] SEPARATE RPC FOR SUBMITTING BUNDLES");
    }

    if (this.networkConfig.enforceGasPrice) {
      this.logger.info("[x] ENFORCING GAS PRICES");
    }

    // can't use eip2930 in unsafeMode and on chains that dont support 1559
    if (
      (!this.networkConfig.eip1559 ||
        this.config.unsafeMode ||
        chainsWithoutEIP1559.some((chainId) => chainId === this.chainId)) &&
      this.networkConfig.eip2930
    ) {
      this.logger.error(
        "Can not use EIP-2930 in unsafe mode or on chains that dont supports EIP-1559"
      );
      throw new Error("disable EIP2930");
    }

    if (this.networkConfig.eip2930) {
      this.logger.info("[x] EIP2930 ENABLED");
    }

    this.logger.info(`[x] USEROPS TTL - ${this.networkConfig.useropsTTL}`);
  }
}
