// Teste de ciclo de vida completo do SteakCoin no EVM próprio.
// Uso: node src/vm/templates/steakcoin-test.js
// O script limpa o contrato anterior (nonce 1), redeploya e roda o ciclo
// completo com timestamps monotonicos dentro de um unico processo
// (o contrato usa block.timestamp em tudo; clock para tras = underflow).
const path = require('path');
const fs = require('fs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const dbPath = path.join(repoRoot, 'db', 'choco-node.db');

const Database = require('better-sqlite3');
const SC = require('../smartcontracts.js');
const abi = require('ethereumjs-abi');
const BN = require('bn.js');
const Block = require('ethereumjs-block');
const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, 'SteakCoin.bytecode.json'), 'utf8'));

const db = new Database(dbPath);
SC.setDatabase(db);

const WALLET = '0xcc35f3f53ea376ad13a035c2f095a1ffce4f6ce201';
const BOB = '0xcc2222222222222222222222222222222222222222';
const ALICE = '0xcc1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';
const DAY = 86400;

const evm = (a) => '0x' + a.replace(/^0x/i, '').slice(2);
const E = (n) => new BN(n).mul(new BN('1000000000000000000')); // STEAK -> wei

function blkAt(ts) {
  const b = new Block();
  b.header.timestamp = Buffer.from(new BN(ts).toString(16, 16).padStart(16, '0'), 'hex');
  return b;
}

async function run() {
  // --- limpa deploy anterior (nonce 1) para comecar do zero ---
  const addr = SC.deriveContractAddress(WALLET, 1);
  db.prepare('DELETE FROM smart_contract_storage WHERE contract_address = ?').run(addr);
  db.prepare('DELETE FROM smart_contracts WHERE lower(address) = lower(?)').run(addr);

  // --- deploy ---
  const nowBlock = blkAt(Math.floor(Date.now() / 1000));
  const deployed = await SC.CreateSmartContract('0x' + artifact.bytecode, { block: nowBlock }, WALLET, 1);
  const C = deployed.contractAddress;
  console.log('deploy @', C, '(gas ' + deployed.gasUsed + ')');

  // --- relogio monotonicamente crescente ---
  let t = Math.floor(Date.now() / 1000) - 10;
  const next = (s) => { t += s; return blkAt(t); };

  let fails = 0;
  const total = { pass: 0, fail: 0 };
  const check = (label, ok) => {
    if (ok) total.pass++;
    else { total.fail++; fails++; }
    console.log((ok ? '  PASS' : '  FAIL') + ' | ' + label);
  };

  async function call(label, sender, fn, blk, expectRevert, ...args) {
    let r;
    try {
      r = await SC.runSmartContract(C, sender, '0x' + abi.simpleEncode(fn, ...args).toString('hex'), 0, undefined, undefined, blk);
    } catch (e) {
      r = { error: e };
    }
    const ok = expectRevert ? !!r.error : !r.error;
    check(label, ok);
    if (r.error && r.error.reason) console.log('       revert reason:', r.error.reason);
    return r;
  }
  async function getter(fn, ...args) {
    const r = await SC.runSmartContract(C, WALLET, '0x' + abi.simpleEncode(fn, ...args).toString('hex'), 0, undefined, undefined, blkAt(t));
    return BigInt(r.returnValue);
  }
  async function stakeAmount(addr) {
    const r = await SC.runSmartContract(C, WALLET, '0x' + abi.simpleEncode('stakes(address)', evm(addr)).toString('hex'), 0, undefined, undefined, blkAt(t));
    return BigInt('0x' + r.returnValue.replace(/^0x/i, '').slice(0, 64));
  }
  const expect = (label, got, want) => check(label, got === BigInt(want.toString()));

  // 1. transfer + taxas (burn 1% + sizzle 0.5%)
  await call('transfer 5000 STEAK w->bob', WALLET, 'transfer(address,uint256)', next(0), false, evm(BOB), E(5000));
  expect('  bob recebe 4925 (5000-1%-0.5%)', await getter('balanceOf(address)', evm(BOB)), E(4925));

  // 2. stake 1000 tier1 (mult 1.25)
  await call('stake 1000 STEAK tier1', BOB, 'stake(uint256,uint8,address)', next(0), false, E(1000), 1, evm(ZERO));
  expect('  totalWeightedStaked = 1250', await getter('totalWeightedStaked()'), E(1250));

  // 3. rewards apos 1 dia
  await call('claimReward +1d', BOB, 'claimReward()', next(DAY), false);
  const r0 = await getter('balanceOf(address)', evm(BOB));
  check('  reward 1d > 1000 STEAK (solo staking)', r0 > E(1000));

  // 4. unstake antecipado -> multa 5%
  await call('unstake 1000 antes do lockup', BOB, 'unstake(uint256)', next(DAY), false, E(1000));
  const r1 = await getter('balanceOf(address)', evm(BOB));
  expect('  recuperou 950 (1000 - 5%)', r1 - r0, E(950));

  // 5. proposal + voto
  await call('stake 1000 STEAK tier1 (minimo p/ proposer)', BOB, 'stake(uint256,uint8,address)', next(0), false, E(1000), 1, evm(ZERO));
  await call('createProposal', BOB, 'createProposal(string,uint256)', next(0), false, 'tocar mais funk', DAY);
  await call('vote(0, a favor)', BOB, 'vote(uint256,bool)', next(3600), false, 0, true);
  await call('vote(0, 2a vez = revert', BOB, 'vote(uint256,bool)', next(0), true, 0, false);
  const pi = await SC.runSmartContract(C, WALLET, '0x' + abi.simpleEncode('proposalInfo(uint256)', 0).toString('hex'), 0, undefined, undefined, blkAt(t));
  const [desc, , fv, av] = abi.rawDecode(['string', 'uint256', 'uint256', 'uint256'], Buffer.from(pi.returnValue.replace(/^0x/i, ''), 'hex'));
  check('  proposta salva + voto registrado (for=1000)', desc === 'tocar mais funk' && fv.eq(E(1000)) && av.eqn(0));

  // 6. unstake apos lockup -> sem multa
  await call('claimReward +1d', BOB, 'claimReward()', next(DAY), false);
  const r2 = await getter('balanceOf(address)', evm(BOB));
  await call('unstake 1000 apos lockup 7d', BOB, 'unstake(uint256)', next(7 * DAY), false, E(1000));
  const r3 = await getter('balanceOf(address)', evm(BOB));
  expect('  recuperou 1000 (sem multa)', r3 - r2, E(1000));
  expect('  stakes bob = 0', await stakeAmount(BOB), 0n);

  // 7. sizzle queima o pool
  await call('sizzle() (queima sizzlePool)', WALLET, 'sizzle()', next(0), false);
  expect('  sizzlePool = 0', await getter('sizzlePool()'), 0n);

  // 8. vesting do creator
  await call('claimVested pelo creator', WALLET, 'claimVested()', next(15 * DAY), false);
  check('  creatorVestingClaimed > 0', await getter('creatorVestingClaimed()') > 0n);

  // 9. compound
  await call('transfer 2000 STEAK w->alice', WALLET, 'transfer(address,uint256)', next(0), false, evm(ALICE), E(2000));
  await call('stake 200 alice tier2', ALICE, 'stake(uint256,uint8,address)', next(0), false, E(200), 2, evm(BOB));
  const beforeCompound = await getter('stakes(address)', evm(ALICE));
  await call('compound alice +1d', ALICE, 'compound()', next(DAY), false);
  const afterCompound = await getter('stakes(address)', evm(ALICE));
  check('  alice staked cresceu com rewards', afterCompound > beforeCompound);

  // 10. persistencia
  const persisted = db.prepare('SELECT COUNT(*) c FROM smart_contract_storage WHERE contract_address = ?').get(C).c;
  check('  storage persistido (' + persisted + ' slots)', persisted > 0);

  console.log('\n== RESULTADO:', total.fail === 0 ? 'TODOS OS CHECKS PASSARAM' : total.fail + ' FALHA(S) DE ' + (total.pass + total.fail), '==');
  process.exit(total.fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('ERR:', e.code || '', e.message);
  process.exit(1);
});
