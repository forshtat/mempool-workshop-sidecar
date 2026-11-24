/*
  Wire method names for EIP-8141 frame transactions, matching the
  executor-side method names in `packages/executor/src/modules/{eth,skandha}.ts`
  (`sendFrameTransaction`/`estimateFrameTransactionGas`/
  `getFrameTransactionByHash`/`getFrameTransactionReceipt`/
  `skandha_frameTransactionStatus`). `eth_supportedEntryPoints`/
  `skandha_feeHistory` are removed entirely, not renamed - see
  `packages/executor/src/modules/{eth,skandha}.ts`'s own header comments for
  why neither has an EIP-8141 analogue.
*/
export const CustomRPCMethods = {
  skandha_getGasPrice: "skandha_getGasPrice",
  skandha_config: "skandha_config",
  skandha_explorer_info: "skandha_explorer_info",
  skandha_explorer_listTransactions: "skandha_explorer_listTransactions",
  skandha_explorer_listAdmissions: "skandha_explorer_listAdmissions",
  skandha_explorer_getTransaction: "skandha_explorer_getTransaction",
  skandha_explorer_peers: "skandha_explorer_peers",
  skandha_explorer_listReputation: "skandha_explorer_listReputation",
  skandha_explorer_faucet: "skandha_explorer_faucet",
  skandha_frameTransactionStatus: "skandha_frameTransactionStatus",
  skandha_subscribe: "skandha_subscribe",
  skandha_unsubscribe: "skandha_unsubscribe",
  skandha_connectedPeers: "skandha_connectedPeers"
};

export const BundlerRPCMethods = {
  eth_chainId: "eth_chainId",
  eth_sendFrameTransaction: "eth_sendFrameTransaction",
  eth_estimateFrameTransactionGas: "eth_estimateFrameTransactionGas",
  eth_getFrameTransactionReceipt: "eth_getFrameTransactionReceipt",
  eth_getFrameTransactionByHash: "eth_getFrameTransactionByHash",
  web3_clientVersion: "web3_clientVersion",
  debug_bundler_clearState: "debug_bundler_clearState",
  debug_bundler_dumpMempool: "debug_bundler_dumpMempool",
  debug_bundler_dumpMempoolRaw: "debug_bundler_dumpMempoolRaw",
  debug_bundler_setReputation: "debug_bundler_setReputation",
  debug_bundler_dumpReputation: "debug_bundler_dumpReputation",
  debug_bundler_setBundlingMode: "debug_bundler_setBundlingMode",
  debug_bundler_setBundleInterval: "debug_bundler_setBundleInterval",
  debug_bundler_sendBundleNow: "debug_bundler_sendBundleNow",
  debug_bundler_setMempool: "debug_bundler_setMempool",
  debug_bundler_getStakeStatus: "debug_bundler_getStakeStatus",
  debug_bundler_clearMempool: "debug_bundler_clearMempool",
  debug_bundler_clearReputation: "debug_bundler_clearReputation",
  debug_bundler_setPrivilegedRelayTargetBlock:
    "debug_bundler_setPrivilegedRelayTargetBlock",
};

export const RedirectedRPCMethods = {
  web3_sha3: "web3_sha3",
  net_version: "net_version",
  net_listening: "net_listening",
  net_peerCount: "net_peerCount",
  eth_protocolVersion: "eth_protocolVersion",
  eth_gasPrice: "eth_gasPrice",
  eth_blockNumber: "eth_blockNumber",
  eth_getBalance: "eth_getBalance",
  eth_getStorageAt: "eth_getStorageAt",
  eth_getTransactionCount: "eth_getTransactionCount",
  eth_getBlockTransactionCountByHash: "eth_getBlockTransactionCountByHash",
  eth_getBlockTransactionCountByNumber: "eth_getBlockTransactionCountByNumber",
  eth_getUncleCountByBlockHash: "eth_getUncleCountByBlockHash",
  eth_getUncleCountByBlockNumber: "eth_getUncleCountByBlockNumber",
  eth_getCode: "eth_getCode",
  eth_sign: "eth_sign",
  eth_call: "eth_call",
  eth_estimateGas: "eth_estimateGas",
  eth_getBlockByHash: "eth_getBlockByHash",
  eth_getBlockByNumber: "eth_getBlockByNumber",
  eth_getTransactionByHash: "eth_getTransactionByHash",
  eth_getTransactionByBlockHashAndIndex:
    "eth_getTransactionByBlockHashAndIndex",
  eth_getTransactionByBlockNumberAndIndex:
    "eth_getTransactionByBlockNumberAndIndex",
  eth_getTransactionReceipt: "eth_getTransactionReceipt",
  eth_getUncleByBlockHashAndIndex: "eth_getUncleByBlockHashAndIndex",
  eth_getUncleByBlockNumberAndIndex: "eth_getUncleByBlockNumberAndIndex",
  eth_newFilter: "eth_newFilter",
  eth_newBlockFilter: "eth_newBlockFilter",
  eth_newPendingTransactionFilter: "eth_newPendingTransactionFilter",
  eth_uninstallFilter: "eth_uninstallFilter",
  eth_getFilterChanges: "eth_getFilterChanges",
  eth_getFilterLogs: "eth_getFilterLogs",
  eth_getLogs: "eth_getLogs",
  eth_maxPriorityFeePerGas: "eth_maxPriorityFeePerGas",
  eth_sendRawTransaction: "eth_sendRawTransaction",
  eth_blobBaseFee: "eth_blobBaseFee",
  eth_getBlockReceipts: "eth_getBlockReceipts",
  eth_feeHistory: "eth_feeHistory",
};

export enum HttpStatus {
  OK = 200,
  INTERNAL_SERVER_ERROR = 500,
}
