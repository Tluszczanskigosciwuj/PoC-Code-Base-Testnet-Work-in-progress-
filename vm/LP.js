const solc = require('solc');
const abi = require('ethereumjs-abi');
const crypto = require('crypto');
const BN = require('bn.js');
const Block = require('ethereumjs-block');
const Database = require('better-sqlite3');
const SC = require('./smartcontracts.js');

const dbPath = require('path').join(__dirname, '..', '..', 'db', 'choco-node.db');
const db = new Database(dbPath);
SC.setDatabase(db);

const WALLET_ALICE = '0xcc35f3f53ea376ad13a035c2f095a1ffce4f6ce201'; // dona da CC
const WALLET_BOB = '0xcc2222222222222222222222222222222222222222'; // dono do BTC/XNO

const HTLC_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract HTLC {
    bytes32 public hashlock;
    uint256 public timelock;
    address public sender;
    address public receiver;
    uint256 public amount;
    bool public redeemed;
    bool public refunded;

    constructor(address _receiver, bytes32 _hashlock, uint256 _timelock) payable {
        sender = msg.sender;
        receiver = _receiver;
        hashlock = _hashlock;
        timelock = _timelock;
        amount = msg.value;
    }

    // Quem conhece a senha (e é o receiver) leva os fundos. A senha é revelada
    // on-chain aqui, permitindo que o outro lado da troca a consuma.
    function redeem(bytes32 _preimage) external {
        require(sha256(abi.encodePacked(_preimage)) == hashlock, 'bad preimage');
        require(msg.sender == receiver, 'not receiver');
        require(!redeemed, 'already redeemed');
        redeemed = true;
        payable(receiver).transfer(amount);
    }

    // Após o timelock, o depositante recupera os fundos (troca abortada).
    function refund() external {
        require(block.timestamp > timelock, 'timelock not reached');
        require(msg.sender == sender, 'not sender');
        require(!refunded, 'already refunded');
        refunded = true;
        payable(sender).transfer(amount);
    }
}
`;

let compiled;
function compileHTLC() {
  if (compiled) return compiled;
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { 'HTLC.sol': { content: HTLC_SOURCE } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'petersburg',
      outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
    },
  });
  const out = JSON.parse(solc.compile(input));
  const c = (out.contracts || {})['HTLC.sol'] && out.contracts['HTLC.sol'].HTLC;
  if (!c) {
    const err = new Error('solc: HTLC não compilou');
    err.details = out.errors;
    throw err;
  }
  compiled = c.evm.bytecode.object;
  return compiled;
}

function blockAt(timestamp) {
  const b = new Block();
  b.header.timestamp = Buffer.from(new BN(timestamp).toString(16, 16).padStart(16, '0'), 'hex');
  return b;
}

function evmAddress(systemAddress) {
  return '0x' + systemAddress.replace(/^0x/i, '').slice(2);
}

function readGetter(contractAddress, name, args = []) {
  return '0x' + abi.methodID(name, args).toString('hex');
}

function encodeCall(signature, ...args) {
  return '0x' + abi.simpleEncode(signature, ...args).toString('hex');
}

function last40(returnValue) {
  return '0xcc' + returnValue.replace(/^0x/i, '').slice(-40);
}

function pad32(hex) {
  return hex.replace(/^0x/i, '').padStart(64, '0');
}

async function deployHTLC(depositor, receiver, hashlock, timelock, amount, nonce) {
  const init = compileHTLC();
  const ctorArgs = abi.rawEncode(['address', 'bytes32', 'uint256'], [evmAddress(receiver), '0x' + hashlock, timelock]);
  const code = '0x' + init + ctorArgs.toString('hex');
  const dep = await SC.CreateSmartContract(code, {}, depositor, nonce, amount);
  return dep.contractAddress;
}

async function getters(contractAddress) {
  const read = async (name) => SC.runSmartContract(contractAddress, WALLET_ALICE, readGetter(contractAddress, name));
  const [amount, hashlock, timelock, sender, receiver, redeemed, refunded] = await Promise.all([
    read('amount'), read('hashlock'), read('timelock'), read('sender'), read('receiver'), read('redeemed'), read('refunded'),
  ]);
  return {
    amount: BigInt(amount.returnValue).toString(),
    hashlock: amount.returnValue && '0x' + pad32(hashlock.returnValue),
    timelock: BigInt(timelock.returnValue).toString(),
    sender: last40(sender.returnValue),
    receiver: last40(receiver.returnValue),
    redeemed: BigInt(redeemed.returnValue).toString(),
    refunded: BigInt(refunded.returnValue).toString(),
  };
}

function expect(cond, label) {
  const ok = cond ? 'OK ' : 'FAIL';
  console.log('   [' + ok + '] ' + label);
  if (!cond) process.exitCode = 1;
}

async function runConceptDemo() {
  const demoContracts = [
    SC.deriveContractAddress(WALLET_ALICE, 7),
    SC.deriveContractAddress(WALLET_BOB, 0),
    SC.deriveContractAddress(WALLET_ALICE, 8),
  ];
  for (const addr of demoContracts) {
    db.prepare('DELETE FROM smart_contract_storage WHERE lower(contract_address) = lower(?)').run(addr);
    db.prepare('DELETE FROM smart_contracts WHERE lower(address) = lower(?)').run(addr);
  }

  console.log('=== CONCEITO HTLC (troca atômica CC <-> BTC/XNO) ===\n');

  const secret = crypto.randomBytes(32);
  const hashlock = crypto.createHash('sha256').update(secret).digest('hex');
  const now = Math.floor(Date.now() / 1000);
  const T1 = now + 3600;
  const T2 = now + 1800;
  const BLOCK_NOW = blockAt(now);

  console.log('Senha (preimage): ' + secret.toString('hex').slice(0, 24) + '...');
  console.log('Hashlock H:       ' + hashlock.slice(0, 24) + '...');
  console.log('Timelocks:        T1(CC)=' + T1 + '  T2(BTC)=' + T2 + '  (T2 < T1 protege o Bob)\n');

  console.log('[1] Alice deposita 500 CC no HTLC-CC (receiver=Bob)');
  const htlcCC = await deployHTLC(WALLET_ALICE, WALLET_BOB, hashlock, T1, '500000000000000000000', 7);
  console.log('    contrato: ' + htlcCC);
  let g = await getters(htlcCC);
  expect(g.amount === '500000000000000000000', 'amount = 500 CC');
  expect(g.hashlock === '0x' + hashlock, 'hashlock = H');
  expect(g.sender === WALLET_ALICE.toLowerCase(), 'sender = Alice');
  expect(g.receiver === WALLET_BOB.toLowerCase(), 'receiver = Bob');
  expect(g.redeemed === '0', 'ainda não redeemado');

  console.log('\n[2] Bob deposita 300 CC no HTLC-BTC (receiver=Alice, mesmo H)');
  const htlcBTC = await deployHTLC(WALLET_BOB, WALLET_ALICE, hashlock, T2, '300000000000000000000', 0);
  console.log('    contrato: ' + htlcBTC);
  g = await getters(htlcBTC);
  expect(g.amount === '300000000000000000000', 'amount = 300 (representa o BTC/XNO)');
  expect(g.hashlock === '0x' + hashlock, 'hashlock = H (mesmo)');
  expect(g.sender === WALLET_BOB.toLowerCase(), 'sender = Bob');
  expect(g.receiver === WALLET_ALICE.toLowerCase(), 'receiver = Alice');

  console.log('\n[3] Alice redeima o HTLC-BTC com a senha (revela S na rede)');
  const aliceBefore = (await SC.getAccountBalance(WALLET_ALICE, htlcBTC)).toString();
  await SC.runSmartContract(htlcBTC, WALLET_ALICE, encodeCall('redeem(bytes32)', '0x' + secret.toString('hex')), 0, undefined, undefined, BLOCK_NOW);
  g = await getters(htlcBTC);
  expect(g.redeemed === '1', 'HTLC-BTC redeemado (Alice levou o BTC)');
  expect((await SC.getAccountBalance(WALLET_ALICE, htlcBTC)).toString() === (BigInt(aliceBefore) + 300000000000000000000n).toString(), 'saldo de Alice +300');

  console.log('\n[4] Bob usa a senha pública e redeima o HTLC-CC antes de T1');
  const bobBefore = (await SC.getAccountBalance(WALLET_BOB, htlcCC)).toString();
  await SC.runSmartContract(htlcCC, WALLET_BOB, encodeCall('redeem(bytes32)', '0x' + secret.toString('hex')), 0, undefined, undefined, BLOCK_NOW);
  g = await getters(htlcCC);
  expect(g.redeemed === '1', 'HTLC-CC redeemado (Bob levou a CC)');
  expect((await SC.getAccountBalance(WALLET_BOB, htlcCC)).toString() === (BigInt(bobBefore) + 500000000000000000000n).toString(), 'saldo de Bob +500');

  console.log('\n[5] Tentativas ilegítimas precisam REVERTER');
  try {
    await SC.runSmartContract(htlcCC, WALLET_BOB, encodeCall('redeem(bytes32)', '0x' + secret.toString('hex')), 0, undefined, undefined, BLOCK_NOW);
    expect(false, 'redeem duplo rejeitado');
  } catch (e) {
    expect(e.code === 'VM_REVERT', 'redeem duplo rejeitado (VM_REVERT)');
  }
  try {
    await SC.runSmartContract(htlcCC, WALLET_ALICE, encodeCall('redeem(bytes32)', '0x' + 'ab'.repeat(32)), 0, undefined, undefined, BLOCK_NOW);
    expect(false, 'preimage errada rejeitada');
  } catch (e) {
    expect(e.code === 'VM_REVERT', 'preimage errada rejeitada (VM_REVERT)');
  }
  try {
    await SC.runSmartContract(htlcCC, WALLET_BOB, encodeCall('refund()'), 0, undefined, undefined, BLOCK_NOW);
    expect(false, 'refund antes do timelock rejeitado');
  } catch (e) {
    expect(e.code === 'VM_REVERT', 'refund antes de T1 rejeitado (VM_REVERT)');
  }

  console.log('\n[6] Troca abortada: timelock expira e o depositante recupera');
  const hashlock2 = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const htlcAborted = await deployHTLC(WALLET_ALICE, WALLET_BOB, hashlock2, now - 60, '200000000000000000000', 8);
  const aliceAbortBefore = (await SC.getAccountBalance(WALLET_ALICE, htlcAborted)).toString();
  await SC.runSmartContract(htlcAborted, WALLET_ALICE, encodeCall('refund()'), 0, undefined, undefined, BLOCK_NOW);
  g = await getters(htlcAborted);
  expect(g.refunded === '1', 'refund executado após o timelock');
  expect((await SC.getAccountBalance(WALLET_ALICE, htlcAborted)).toString() === (BigInt(aliceAbortBefore) + 200000000000000000000n).toString(), 'Alice recuperou os 200 CC');
  try {
    await SC.runSmartContract(htlcAborted, WALLET_BOB, encodeCall('refund()'), 0, undefined, undefined, BLOCK_NOW);
    expect(false, 'só o sender pode dar refund');
  } catch (e) {
    expect(e.code === 'VM_REVERT', 'só o sender pode dar refund (VM_REVERT)');
  }

  console.log('\n=== RESULTADO ===');
  console.log(process.exitCode ? 'Alguma checagem falhou.' : 'Conceito HTLC validado: depósito, redeem atômico, refund, reverts.');
  console.log('Contratos persistidos no DB:');
  for (const row of SC.listSmartContracts()) console.log('   ' + row.address);
}

if (require.main === module) {
  runConceptDemo().catch((e) => {
    console.error('ERRO no demo:', e.code || '', e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  compileHTLC, deployHTLC, redeem: runConceptDemo, getters, HTLC_SOURCE,
};
