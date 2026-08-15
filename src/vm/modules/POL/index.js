const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { makeEVMPlugin, createClient, createWallet } = require('../../evm');

const DEFAULT_RPC = 'https://polygon-amoy.drpc.org';
const DEFAULT_CHAIN_ID = 80002n;
const POLYGON_MAINNET_RPC = 'https://polygon.drpc.org';
const POLYGON_MAINNET_CHAIN_ID = 137n;
const EXPLORER = 'https://amoy.polygonscan.com';
const EXPLORER_MAINNET = 'https://polygonscan.com';

function loadKey() {
  if (process.env.POL_PRIVATE_KEY) return process.env.POL_PRIVATE_KEY;
  try {
    const k = fs.readFileSync(path.join(__dirname, 'pol-test.key'), 'utf8').trim();
    return k || undefined;
  } catch { return undefined; }
}

const plugin = makeEVMPlugin({
  id: 'POL',
  asset: 'POL',
  decimals: 18,
  defaultRpc: DEFAULT_RPC,
  defaultChainId: DEFAULT_CHAIN_ID,
  explorers: {
    [POLYGON_MAINNET_CHAIN_ID]: { name: 'MAINNET', explorer: EXPLORER_MAINNET, mainnet: true },
    [DEFAULT_CHAIN_ID]: { name: 'Amoy', explorer: EXPLORER },
  },
  loadKey,
});

async function probe() {
  const rpcUrl = process.env.POL_RPC || DEFAULT_RPC;
  const expected = BigInt(process.env.POL_CHAIN_ID || DEFAULT_CHAIN_ID.toString());
  const client = plugin.createClient(rpcUrl);
  const net = await client.chainId();
  const block = await client.blockNumber();
  const gasPrice = await client.gasPrice();
  const wallet = createWallet(crypto.randomBytes(32).toString('hex'));
  const deployData = plugin.htlcInit(
    wallet.address,
    crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'),
    Math.floor(Date.now() / 1000) + 3600,
  );
  const gas = await client.estimateGas({ from: wallet.address, data: deployData });
  const name = plugin.explorerFor(net).name;
  console.log('=== POL probe ===');
  console.log('RPC      : ' + rpcUrl);
  console.log('chainId  : ' + net + ' (' + name + (net === expected ? '' : ', esperado ' + expected) + ')');
  console.log('block    : ' + block);
  console.log('gasPrice : ' + gasPrice + ' wei');
  console.log('estimateGas deploy HTLC: ' + gas);
  const ok = net === expected && block > 0n && gasPrice > 0n && gas > 21000n && gas < 5000000n;
  console.log(ok ? 'probe OK' : 'probe FAIL');
  process.exitCode = ok ? 0 : 1;
}

module.exports = Object.assign(plugin, {
  DEFAULT_RPC, DEFAULT_CHAIN_ID, POLYGON_MAINNET_RPC, POLYGON_MAINNET_CHAIN_ID, EXPLORER, EXPLORER_MAINNET,
  createRpc: plugin.createClient,
  createWallet,
  readHTLC: plugin.readHtlc,
  weiToPol: plugin.weiToAsset,
  probe,
});

if (require.main === module) {
  probe().catch((e) => {
    console.error('ERRO no probe POL:', e.code || '', e.message);
    process.exitCode = 1;
  });
}
