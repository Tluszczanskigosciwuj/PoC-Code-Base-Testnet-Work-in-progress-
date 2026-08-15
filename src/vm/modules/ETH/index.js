const { makeEVMPlugin } = require('../../evm');

const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_CHAIN_ID = 11155111n;
const ETH_MAINNET_RPC = 'https://ethereum-rpc.publicnode.com';
const ETH_MAINNET_CHAIN_ID = 1n;
const EXPLORER = 'https://sepolia.etherscan.io';
const EXPLORER_MAINNET = 'https://etherscan.io';

function loadKey() {
  if (process.env.ETH_PRIVATE_KEY) return process.env.ETH_PRIVATE_KEY;
  return undefined;
}

const plugin = makeEVMPlugin({
  id: 'ETH',
  asset: 'ETH',
  decimals: 18,
  defaultRpc: DEFAULT_RPC,
  defaultChainId: DEFAULT_CHAIN_ID,
  explorers: {
    [ETH_MAINNET_CHAIN_ID]: { name: 'MAINNET', explorer: EXPLORER_MAINNET, mainnet: true },
    [DEFAULT_CHAIN_ID]: { name: 'Sepolia', explorer: EXPLORER },
  },
  loadKey,
});

module.exports = Object.assign(plugin, {
  DEFAULT_RPC, DEFAULT_CHAIN_ID, ETH_MAINNET_RPC, ETH_MAINNET_CHAIN_ID, EXPLORER, EXPLORER_MAINNET,
  createRpc: plugin.createClient,
  readHTLC: plugin.readHtlc,
  weiToEth: plugin.weiToAsset,
});
