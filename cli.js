#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const CHOCOHUB = require('./chocohub.js');
const { loadConfig, saveConfig, normalizeUrl } = CHOCOHUB;

const VERSION = '3.6.0';

const C = {
  grn: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  ylw: s => `\x1b[33m${s}\x1b[0m`,
  cyn: s => `\x1b[36m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
};

const GROUPS = {
  node: { label: 'NODE', desc: 'Node lifecycle & status' },
  wallet: { label: 'WALLET', desc: 'Key management & transactions' },
  storage: { label: 'STORAGE', desc: 'Plot / PoC management' },
  mining: { label: 'MINING', desc: 'Mining control & info' },
  chain: { label: 'CHAIN', desc: 'Blockchain queries' },
  config: { label: 'CONFIG', desc: 'Configuration management' },
  utils: { label: 'UTILS', desc: 'Cryptographic utilities' },
};

const COMMANDS = [
  { cmd: 'node:start', group: 'node', desc: 'Start a full node', args: [
    { name: '--port', desc: 'HTTP port (default: 3001)' },
    { name: '--mining', desc: 'Enable mining' },
    { name: '--miner-address', desc: 'Miner wallet address' },
    { name: '--storage-dirs', desc: 'Comma-separated plot dirs' },
  ]},
  { cmd: 'node:status', group: 'node', desc: 'Show node status from RPC', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'wallet:create', group: 'wallet', desc: 'Generate a new wallet keypair', args: [
    { name: '--hd', desc: 'Also generate a BIP39 seed' },
  ]},
  { cmd: 'wallet:import', group: 'wallet', desc: 'Import wallet from seed or private key', args: [
    { name: '--seed', desc: 'BIP39 seed (hex)' },
    { name: '--private-key', desc: 'Ed25519 private key (hex)' },
  ]},
  { cmd: 'wallet:list', group: 'wallet', desc: 'List wallets known to the node', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'wallet:balance', group: 'wallet', desc: 'Check wallet balance', args: [
    { name: '--address', desc: 'Wallet address (0x...)' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'wallet:send', group: 'wallet', desc: 'Send CC tokens', args: [
    { name: '--from', desc: 'Sender address' },
    { name: '--to', desc: 'Recipient address' },
    { name: '--value', desc: 'Amount in wei (1 CC = 1e18)' },
    { name: '--private-key', desc: 'Sender private key (hex)' },
    { name: '--fee', desc: 'Transaction fee (optional)' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'storage:commit', group: 'storage', desc: 'Commit a plot for mining', args: [
    { name: '--path', desc: 'Plot file or directory' },
    { name: '--size', desc: 'Size (e.g. 500MB, 2GB)' },
    { name: '--address', desc: 'Miner address' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'storage:list', group: 'storage', desc: 'List committed plots', args: [
    { name: '--address', desc: 'Filter by miner address' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'mining:start', group: 'mining', desc: 'Start mining for an address', args: [
    { name: '--address', desc: 'Miner wallet address' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'mining:stop', group: 'mining', desc: 'Stop mining', args: [
    { name: '--address', desc: 'Miner wallet address' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'mining:status', group: 'mining', desc: 'Show mining status', args: [
    { name: '--address', desc: 'Miner wallet address' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'mining:challenge', group: 'mining', desc: 'Show current mining challenge', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'chain:height', group: 'chain', desc: 'Current blockchain height', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'chain:block', group: 'chain', desc: 'Get block by height or hash', args: [
    { name: '--height', desc: 'Block height' },
    { name: '--hash', desc: 'Block hash' },
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'chain:peers', group: 'chain', desc: 'List connected peers', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'chain:sync', group: 'chain', desc: 'Trigger chain sync', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'chain:stats', group: 'chain', desc: 'Full chain statistics', args: [
    { name: '--rpc', desc: 'RPC endpoint URL' },
  ]},
  { cmd: 'config:show', group: 'config', desc: 'Show effective node config' },
  { cmd: 'keygen', group: 'utils', desc: 'Generate Ed25519 keypair', args: [
    { name: '--hd', desc: 'Also generate a BIP39 seed' },
  ]},
  { cmd: 'address', group: 'utils', desc: 'Derive address from public key', args: [
    { name: '--pubkey', desc: 'Base64 public key' },
  ]},
  { cmd: 'sign', group: 'utils', desc: 'Sign a message', args: [
    { name: '--message', desc: 'Message to sign' },
    { name: '--private-key', desc: 'Private key (hex)' },
  ]},
  { cmd: 'verify', group: 'utils', desc: 'Verify a signature', args: [
    { name: '--message', desc: 'Original message' },
    { name: '--signature', desc: 'Signature (hex)' },
    { name: '--pubkey', desc: 'Public key (base64)' },
  ]},
];

function printUsage() {
  console.log(C.bold(`\n  ChocoHub CLI v${VERSION}`));
  console.log(C.dim(`  Usage: choco <command> [options]\n`));

  let prevGroup = null;
  for (const entry of COMMANDS) {
    if (entry.group !== prevGroup) {
      const g = GROUPS[entry.group];
      console.log(`  ${C.ylw(g.label)} — ${C.dim(g.desc)}`);
      prevGroup = entry.group;
    }
    const cmd = C.grn(entry.cmd.padEnd(22));
    console.log(`    ${cmd} ${entry.desc}`);
    for (const a of entry.args || []) {
      console.log(`      ${C.dim(a.name.padEnd(24))} ${a.desc}`);
    }
  }

  console.log(C.bold(`\n  GLOBAL OPTIONS:\n`));
  console.log(`    ${C.dim('--rpc <url>'.padEnd(24))} RPC endpoint (default: http://localhost:3001)`);
  console.log(`    ${C.dim('--help, -h'.padEnd(24))} Show this help\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else { args[key] = true; }
    } else if (arg.startsWith('-') && arg !== '-h') {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { args[key] = next; i++; }
      else { args[key] = true; }
    } else {
      args._ = args._ || [];
      args._.push(arg);
    }
  }
  args._ = args._ || [];
  return args;
}

function rpcCall(url, method, params = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? require('https') : require('http');
    const body = JSON.stringify(params);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: method,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      rejectUnauthorized: false,
      timeout: 30000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ _raw: data, _status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function getRpcUrl(args) {
  return args.rpc || process.env.RPC_URL || 'http://localhost:3001';
}

function parseSize(str) {
  const m = str.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) throw new Error(`Invalid size: ${str}`);
  const v = parseFloat(m[1]);
  const u = (m[2] || 'B').toUpperCase();
  const mult = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
  return Math.floor(v * (mult[u] || 1));
}

function genWallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  const addr = CHOCOHUB.pubKeyToAddress(pubB64);
  return { address: addr, publicKey: pubB64, privateKey: privHex };
}

function printWallet(w, label) {
  console.log(`  ${C.grn('Address:')}     ${w.address}`);
  console.log(`  ${C.dim('Public Key:')}  ${w.publicKey}`);
  console.log(`  ${C.ylw('Private Key:')} ${w.privateKey}`);
  if (w.seed) console.log(`  ${C.cyn('Seed:')}        ${w.seed}`);
}

async function cmdNodeStart(args) {
  const config = loadConfig();
  if (args.port) config.port = parseInt(args.port);
  if (args.mining) config.miningEnabled = true;
  if (args['miner-address']) config.minerAddress = args['miner-address'];
  if (args['storage-dirs']) config.plotsDir = args['storage-dirs'];

  const child = spawn(process.execPath, [require.resolve('./src/index.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: {
      ...process.env,
      PORT: String(config.port),
      PLOTS_DIR: config.plotsDir || '',
      MINING_ENABLED: String(config.miningEnabled),
      MINER_ADDRESS: config.minerAddress || '',
    }
  });

  console.log(`\n  ${C.grn('Node started')} on port ${C.bold(config.port)}`);
  if (config.miningEnabled) console.log(`  Mining: ${C.grn('enabled')} — ${config.minerAddress || C.red('no address')}`);
  child.on('exit', (code) => console.log(`\n  Node exited (code ${code})`));
}

async function cmdNodeStatus(args) {
  const url = getRpcUrl(args);
  try {
    const s = await rpcCall(url, '/api/node/status');
    console.log(`  ${C.grn('Node ID:')}       ${s.node_id || '?'}`);
    console.log(`  ${C.grn('Height:')}        ${s.height || s.altura || 0}`);
    console.log(`  ${C.dim('Hash:')}          ${(s.hash || '').slice(0, 20)}...`);
    console.log(`  ${C.dim('Chain Work:')}    ${s.chain_work || '0'}`);
    console.log(`  ${C.cyn('Peers:')}         ${s.peer_count || 0}`);
    console.log(`  ${s.mining_active ? C.grn('Mining:') : C.dim('Mining:')}        ${s.mining_active ? C.grn('active') : C.dim('inactive')}`);
    console.log(`  ${C.ylw('Miner:')}         ${s.miner_address || 'none'}`);
    console.log(`  ${C.dim('Uptime:')}        ${(s.uptime || 0) + 's'}`);
  } catch (e) {
    console.error(`  ${C.red('Error:')} ${e.message}`);
  }
}

async function cmdWalletCreate(args) {
  const w = genWallet();
  const output = { address: w.address, publicKey: w.publicKey, privateKey: w.privateKey };
  if (args.hd) { output.seed = crypto.randomBytes(32).toString('hex'); }
  printWallet(output, 'Wallet created');
}

async function cmdWalletImport(args) {
  if (!args.seed && !args['private-key']) {
    console.error(`  ${C.red('Provide --seed or --private-key')}`);
    return;
  }
  let w;
  if (args.seed) {
    const seed = Buffer.from(args.seed, 'hex');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { privateKey: seed });
    const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
    const privHex = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
    const addr = CHOCOHUB.pubKeyToAddress(pubB64);
    w = { address: addr, publicKey: pubB64, privateKey: privHex };
  } else {
    const privHex = args['private-key'];
    const key = Buffer.from(privHex, 'hex');
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const pkcs8 = Buffer.concat([prefix, key]);
    const privKeyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    const pubKeyObj = crypto.createPublicKey({ key: privKeyObj });
    const pubB64 = pubKeyObj.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
    const addr = CHOCOHUB.pubKeyToAddress(pubB64);
    w = { address: addr, publicKey: pubB64, privateKey: privHex };
  }
  printWallet(w, 'Wallet imported');
}

async function cmdWalletList(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/wallets');
    console.log(`  ${C.bold('Wallets')}:`);
    for (const w of (res.wallets || [])) {
      console.log(`    ${C.grn(w.address)}  ${C.ylw((Number(w.balance || 0) / 1e18).toFixed(4))} CC  nonce=${w.nonce || 0}`);
    }
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdWalletBalance(args) {
  if (!args.address) { console.error(`  ${C.red('Need --address')}`); return; }
  try {
    const w = await rpcCall(getRpcUrl(args), `/api/wallet/${args.address}`);
    console.log(`  ${C.grn('Address:')} ${args.address}`);
    console.log(`  ${C.ylw('Balance:')} ${(Number(w.balance || 0) / 1e18).toFixed(6)} CC`);
    console.log(`  ${C.dim('Nonce:')}   ${w.nonce || 0}`);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdWalletSend(args) {
  const { from, to, value, 'private-key': privKey, fee } = args;
  if (!from || !to || !value) { console.error(`  ${C.red('Need --from --to --value')}`); return; }
  if (!privKey) { console.error(`  ${C.red('Need --private-key')}`); return; }
  const url = getRpcUrl(args);
  const wallet = await rpcCall(url, `/api/wallet/${from}`);
  const nonce = wallet.nonce || 0;
  const gasLimit = 21000;
  const gasPrice = CHOCOHUB.suggestedGasPrice(1);
  const txFee = fee || CHOCOHUB.computeFee(gasLimit, gasPrice);
  const tx = {
    chain_id: '19971971', from_addr: from, to_addr: to,
    value: String(value), fee: String(txFee), nonce,
    gas_limit: gasLimit, gas_price: String(gasPrice),
    timestamp: Math.floor(Date.now() / 1000),
  };
  tx.signature = CHOCOHUB.signMessage(CHOCOHUB.canonicalTxMessage(tx), privKey);
  const res = await rpcCall(url, '/api/tx/send', { method: 'POST', body: tx });
  console.log(`  ${C.grn('Transaction sent:')}`, res);
}

async function cmdStorageCommit(args) {
  const { path: storagePath, size, address } = args;
  if (!storagePath || !size || !address) {
    console.error(`  ${C.red('Need --path --size --address')}`); return;
  }
  const url = getRpcUrl(args);
  const totalSize = parseSize(size);
  console.log(`  Committing: ${C.cyn(storagePath)}`);
  console.log(`  Size:       ${C.ylw(size)} (${totalSize} bytes)`);

  const stats = fs.statSync(storagePath);
  const files = stats.isDirectory()
    ? fs.readdirSync(storagePath).filter(f => !f.startsWith('.')).map(f => path.join(storagePath, f))
    : [storagePath];

  const chunkBytes = 65536;
  let allChunks = [];
  for (const file of files) {
    const fd = fs.openSync(file, 'r');
    const fileSize = fs.fstatSync(fd).size;
    const chunks = Math.ceil(fileSize / chunkBytes);
    for (let i = 0; i < chunks; i++) {
      const buf = Buffer.alloc(chunkBytes);
      const read = fs.readSync(fd, buf, 0, chunkBytes, i * chunkBytes);
      if (read < chunkBytes) buf.fill(0, read);
      allChunks.push(CHOCOHUB.sha256hex(buf));
    }
    fs.closeSync(fd);
  }

  const merkleRoot = CHOCOHUB.merkleRoot(allChunks);
  const commitmentId = CHOCOHUB.sha256hex(`${address}:${storagePath}:${Date.now()}`).slice(0, 16);
  const res = await rpcCall(url, '/api/poc/register_plot', {
    method: 'POST', body: { miner: address, plot_id: commitmentId, size_gb: totalSize / 1e9, merkle_root: merkleRoot }
  });

  console.log(`  ${C.grn('Plot registered:')} ${commitmentId}`);
  console.log(`  Merkle Root: ${merkleRoot.slice(0, 20)}...`);
  console.log(`  Chunks: ${allChunks.length}`);
}

async function cmdStorageList(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), `/api/poc/plots/${args.address || ''}`);
    console.log(`  ${C.bold('Committed Plots')}:`);
    for (const p of (res.plots || [])) {
      console.log(`    ${C.cyn(p.plot_id)}  ${C.ylw((p.size_gb || 0).toFixed(2))} GB  ${(p.merkle_root || '').slice(0, 16)}...`);
    }
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdMiningStart(args) {
  if (!args.address) { console.error(`  ${C.red('Need --address')}`); return; }
  const res = await rpcCall(getRpcUrl(args), '/api/mining/start', { method: 'POST', body: { address: args.address } });
  console.log(res.ok ? `  ${C.grn('Mining started')} for ${args.address}` : `  ${C.red('Failed:')} ${res.motivo || res.error}`);
}

async function cmdMiningStop(args) {
  const res = await rpcCall(getRpcUrl(args), '/api/mining/stop', { method: 'POST', body: { address: args.address } });
  console.log(res.ok ? `  ${C.grn('Mining stopped')}` : `  ${C.red('Failed:')} ${res.motivo || res.error}`);
}

async function cmdMiningStatus(args) {
  try {
    const url = getRpcUrl(args);
    const res = await rpcCall(url, args.address ? `/api/mining/status?address=${args.address}` : '/api/mining/status');
    console.log(`  Mining: ${res.mining ? C.grn('active') : C.dim('inactive')}`);
    if (res.address) console.log(`  Address: ${res.address}`);
    if (res.shares) console.log(`  Shares: ${res.shares}`);
    if (res.total_scans) console.log(`  Scans: ${res.total_scans}`);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdMiningChallenge(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/mining/challenge');
    console.log(`  ${C.grn('Challenge ID:')}  ${res.challenge_id}`);
    console.log(`  ${C.dim('Seed:')}          ${(res.challenge_seed || '').slice(0, 24)}...`);
    console.log(`  ${C.cyn('Expires:')}       ${res.expires_at ? new Date(res.expires_at * 1000).toISOString() : '?'}`);
    console.log(`  ${C.ylw('Target Scoop:')}  ${res.target_scoop_index}`);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdChainHeight(args) {
  try {
    const s = await rpcCall(getRpcUrl(args), '/api/node/status');
    console.log(`  ${C.bold('Height:')} ${s.height || s.altura || 0}`);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdChainBlock(args) {
  if (!args.height && !args.hash) { console.error(`  ${C.red('Need --height or --hash')}`); return; }
  try {
    const ep = args.height ? `/api/node/block/${parseInt(args.height)}` : `/api/node/block/${args.hash}`;
    const res = await rpcCall(getRpcUrl(args), ep);
    console.log(JSON.stringify(res.block || res, null, 2));
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdChainPeers(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/node/peers');
    console.log(`  ${C.bold('Peers')}:`);
    for (const p of (res.peers || [])) {
      const h = p.health != null ? (p.health > 0 ? C.grn(`${p.health}`) : C.red(`${p.health}`)) : '?';
      console.log(`    ${C.cyn(p.url)}  h=${p.height}  health=${h}  ${p.is_banned ? C.red('banned') : C.dim('ok')}`);
    }
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdChainSync(args) {
  try {
    const res = await rpcCall(getRpcUrl(args), '/api/node/sync', { method: 'POST' });
    console.log(`  ${C.grn('Sync triggered')}:`, res);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdChainStats(args) {
  try {
    const s = await rpcCall(getRpcUrl(args), '/api/stats');
    console.log(`  ${C.bold('Height:')}    ${s.altura || 0}`);
    console.log(`  Blocks:    ${s.blocos || 0}`);
    console.log(`  Users:     ${s.usuarios || 0}`);
    console.log(`  Txs:       ${s.total_txs || 0}`);
    console.log(`  Mempool:   ${s.mempool || 0}`);
    console.log(`  Plots:     ${s.plots_count || 0}`);
    console.log(`  Capacity:  ${(s.capacidade_gb || 0).toFixed(2)} GB`);
    console.log(`  Supply:    ${(Number(s.supply || 0) / 1e18).toFixed(2)} CC`);
    console.log(`  Reward:    ${(Number(s.current_reward_cc || 0) / 1e18).toFixed(4)} CC`);
    console.log(`  Halving:   ${s.blocks_to_halving || '?'} blocks`);
  } catch (e) { console.error(`  ${C.red('Error:')} ${e.message}`); }
}

async function cmdConfigShow(args) {
  const config = loadConfig();
  console.log(`  ${C.bold('Effective Config')}:`);
  for (const [k, v] of Object.entries(config)) {
    if (/key|secret|token|private/i.test(k)) continue;
    const val = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`    ${C.dim(k.padEnd(22))} ${C.grn(val)}`);
  }
}

async function cmdKeygen(args) {
  const w = genWallet();
  const output = { address: w.address, publicKey: w.publicKey, privateKey: w.privateKey };
  if (args.hd) output.seed = crypto.randomBytes(32).toString('hex');
  printWallet(output, 'Keypair generated');
}

async function cmdAddress(args) {
  if (!args.pubkey) { console.error(`  ${C.red('Need --pubkey')}`); return; }
  console.log(`  ${C.grn(CHOCOHUB.pubKeyToAddress(args.pubkey))}`);
}

async function cmdSign(args) {
  if (!args.message || !args['private-key']) {
    console.error(`  ${C.red('Need --message --private-key')}`); return;
  }
  console.log(`  ${C.cyn(CHOCOHUB.signMessage(args.message, args['private-key']))}`);
}

async function cmdVerify(args) {
  if (!args.message || !args.signature || !args.pubkey) {
    console.error(`  ${C.red('Need --message --signature --pubkey')}`); return;
  }
  const ok = CHOCOHUB.verifySignature(args.message, args.signature, args.pubkey);
  console.log(ok ? `  ${C.grn('Valid')}` : `  ${C.red('Invalid')}`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    printUsage();
    return;
  }

  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  const handlers = {
    'node:start': cmdNodeStart,
    'node:status': cmdNodeStatus,
    'wallet:create': cmdWalletCreate,
    'wallet:import': cmdWalletImport,
    'wallet:list': cmdWalletList,
    'wallet:balance': cmdWalletBalance,
    'wallet:send': cmdWalletSend,
    'storage:commit': cmdStorageCommit,
    'storage:list': cmdStorageList,
    'mining:start': cmdMiningStart,
    'mining:stop': cmdMiningStop,
    'mining:status': cmdMiningStatus,
    'mining:challenge': cmdMiningChallenge,
    'chain:height': cmdChainHeight,
    'chain:block': cmdChainBlock,
    'chain:peers': cmdChainPeers,
    'chain:sync': cmdChainSync,
    'chain:stats': cmdChainStats,
    'config:show': cmdConfigShow,
    keygen: cmdKeygen,
    address: cmdAddress,
    sign: cmdSign,
    verify: cmdVerify,
  };

  const handler = handlers[cmd];
  if (!handler) {
    console.error(`  ${C.red(`Unknown command: ${cmd}`)}`);
    const similar = Object.keys(handlers).filter(h => h.includes(cmd) || cmd.includes(h));
    if (similar.length) console.error(`  ${C.dim(`Did you mean: ${similar.join(', ')}?`)}`);
    console.error();
    printUsage();
    process.exit(1);
  }

  try {
    await handler(args);
  } catch (e) {
    console.error(`  ${C.red('Error:')} ${e.message}`);
    process.exit(1);
  }
}

main();
