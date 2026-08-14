// Deploy e interacao com o template SteakCoin via CLI.
// Uso:
//   node src/vm/templates/deploy-steak.js deploy <senderAddress> [nonce]
//   node src/vm/templates/deploy-steak.js info <contractAddress>
//   node src/vm/templates/deploy-steak.js transfer <contractAddress> <fromAddr> <toAddr> <amount>
//   node src/vm/templates/deploy-steak.js stake <contractAddress> <addr> <amount> [tier=0] [referrer]
//   node src/vm/templates/deploy-steak.js unstake <contractAddress> <addr> <amount>
//   node src/vm/templates/deploy-steak.js balance <contractAddress> <addr>
//   node src/vm/templates/deploy-steak.js staked <contractAddress> <addr>
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dbPath = path.join(repoRoot, 'db', 'choco-node.db');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 nao encontrado. Rode: npm install better-sqlite3');
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error('DB nao encontrado em', dbPath, '- inicie o node uma vez antes de deployar.');
  process.exit(1);
}

const SC = require('../smartcontracts.js');
const abi = require('ethereumjs-abi');
const BN = require('bn.js');
const Block = require('ethereumjs-block');
const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'SteakCoin.bytecode.json'), 'utf8'));

function blockAt(timestamp) {
  const b = new Block();
  b.header.timestamp = Buffer.from(new BN(timestamp).toString(16, 16).padStart(16, '0'), 'hex');
  return b;
}
const NOW_BLOCK = blockAt(Math.floor(Date.now() / 1000));

const WRITE_COMMANDS = ['deploy', 'transfer', 'stake', 'unstake'];
const db = new Database(dbPath, WRITE_COMMANDS.includes(process.argv[2]) ? {} : { readonly: true });
SC.setDatabase(db);

const [cmd, ...rest] = process.argv.slice(2);

function evmAddr(systemAddr) {
  return '0x' + systemAddr.replace(/^0x/i, '').slice(2);
}

async function call(addr, sender, fn, value = 0) {
  const data = '0x' + abi.simpleEncode(...fn).toString('hex');
  return SC.runSmartContract(addr, sender, data, value, undefined, undefined, NOW_BLOCK);
}

async function deploy(sender, nonce) {
  const nonceN = nonce !== undefined ? parseInt(nonce, 10) : undefined;
  let usedNonce = nonceN;
  if (usedNonce === undefined || isNaN(usedNonce)) {
    const addr = SC.deriveContractAddress(sender, 0);
    const existing = db.prepare('SELECT address FROM smart_contracts WHERE lower(address) = lower(?)').get(addr);
    usedNonce = existing ? 1 : 0;
  }
  const result = await SC.CreateSmartContract('0x' + artifact.bytecode, { block: NOW_BLOCK }, sender, usedNonce);
  console.log(JSON.stringify({
    contractAddress: result.contractAddress,
    creator: sender.toLowerCase(),
    runtimeCode: result.runtimeCode,
    gasUsed: result.gasUsed,
    totalSupply: '21000000000000000000000000',
  }, null, 2));
}

(async () => {
  try {
    if (cmd === 'deploy') {
      await deploy(rest[0], rest[1]);
    } else if (cmd === 'info') {
      console.log(JSON.stringify(SC.getSmartContract(rest[0]), null, 2));
    } else if (cmd === 'balance') {
      const r = await call(rest[0], rest[1], ['balanceOf(address)', evmAddr(rest[1])]);
      console.log(BigInt(r.returnValue).toString());
    } else if (cmd === 'staked') {
      const r = await call(rest[0], rest[1], ['stakes(address)', evmAddr(rest[1])]);
      console.log(BigInt('0x' + r.returnValue.replace(/^0x/i, '').slice(0, 64)).toString());
    } else if (cmd === 'transfer') {
      const [contract, from, to, amount] = rest;
      const r = await call(contract, from, ['transfer(address,uint256)', evmAddr(to), amount]);
      console.log('ok, gasUsed:', r.gasUsed);
    } else if (cmd === 'stake') {
      const [contract, addr, amount, tier = '0', referrer = '0x0000000000000000000000000000000000000000'] = rest;
      const r = await call(contract, addr, ['stake(uint256,uint8,address)', amount, tier, evmAddr(referrer)]);
      console.log('ok, gasUsed:', r.gasUsed);
    } else if (cmd === 'unstake') {
      const [contract, addr, amount] = rest;
      const r = await call(contract, addr, ['unstake(uint256)', amount]);
      console.log('ok, gasUsed:', r.gasUsed);
    } else {
      console.log('comando desconhecido:', cmd);
      process.exit(1);
    }
  } catch (e) {
    console.error('erro:', e.code || '', e.message);
    if (process.env.DEBUG_STEAK) console.error(e.stack);
    process.exit(1);
  }
})();
