const { GAS_PARAMS } = require('../consensus/gas');
const VM = require('ethereumjs-vm').default;
const BN = require('bn.js');
const { generateAddress, toChecksumAddress, toBuffer } = require('ethereumjs-util');
const rlp = require('rlp');

patchLevelWsDoubleClose();

function patchLevelWsDoubleClose() {
  try {
    const { WriteStream } = require('level-ws');
    if (!WriteStream || WriteStream.prototype.__ccPatched) return;
    WriteStream.prototype.__ccPatched = true;
    const originalEmit = WriteStream.prototype.emit;
    WriteStream.prototype.emit = function (eventName, ...args) {
      if (eventName === 'close') {
        if (this.__ccCloseFired) return this;
        this.__ccCloseFired = true;
      }
      return originalEmit.call(this, eventName, ...args);
    };
  } catch (e) {
    // noop
  }
}

const initialSmartContractGasLimit = GAS_PARAMS.initialSmartContractGasLimit;
const initialSmartContractGasPrice = GAS_PARAMS.initialSmartContractGasPrice;

const InitialSmartContractGasPriceHumanReadable = (initialSmartContractGasPrice / 10 ** 9).toString() + ' Gwei';

const MAX_CONTRACT_CODE_SIZE = 24576; // 24 KB

let db = null;

const vmCache = new Map();
const knownSlots = new Map();

function setDatabase(database) {
  db = database;
}

function clearVmCache() {
  vmCache.clear();
  knownSlots.clear();
}

function getVm(contractAddress) {
  const key = normalizeHex(contractAddress);
  if (!vmCache.has(key)) {
    vmCache.set(key, new VM());
  }
  if (!knownSlots.has(key)) {
    knownSlots.set(key, new Set());
  }
  return vmCache.get(key);
}

async function restoreContractBalance(vm, evmAddr, contractAddress) {
  const row = db.prepare('SELECT balance FROM smart_contract_accounts WHERE lower(address) = lower(?)').get(contractAddress);
  const account = await new Promise((resolve, reject) => {
    vm.stateManager.getAccount(evmAddr, (err, acc) => (err ? reject(err) : resolve(acc)));
  });
  account.balance = toBuffer(new BN(row ? row.balance : 0));
  await new Promise((resolve, reject) => {
    vm.stateManager.putAccount(evmAddr, account, (err) => (err ? reject(err) : resolve()));
  });
}

async function flushContractBalance(vm, contractAddress) {
  if (!db) return;
  const evmAddr = toEvmAddress(contractAddress);
  const account = await new Promise((resolve, reject) => {
    vm.stateManager.getAccount(evmAddr, (err, acc) => (err ? reject(err) : resolve(acc)));
  });
  const balance = new BN(account.balance);
  if (balance.isZero()) {
    db.prepare('DELETE FROM smart_contract_accounts WHERE lower(address) = lower(?)').run(contractAddress);
  } else {
    db.prepare('INSERT OR REPLACE INTO smart_contract_accounts (address, balance) VALUES (?, ?)').run(contractAddress.toLowerCase(), balance.toString());
  }
}

async function loadContractStorage(vm, contractAddress) {
  if (!db) return;
  const rows = db.prepare(
    'SELECT slot, value FROM smart_contract_storage WHERE lower(contract_address) = lower(?)'
  ).all(contractAddress);
  const evmAddr = toEvmAddress(contractAddress);
  const slots = knownSlots.get(normalizeHex(contractAddress)) || new Set();
  for (const row of rows) {
    await new Promise((resolve) => {
      vm.stateManager.putContractStorage(evmAddr, Buffer.from(row.slot, 'hex'), Buffer.from(row.value, 'hex'), resolve);
    });
    slots.add(row.slot);
  }
  knownSlots.set(normalizeHex(contractAddress), slots);
  await restoreContractBalance(vm, evmAddr, contractAddress);
}

async function saveContractStorage(vm, contractAddress, writtenSlots) {
  if (!db) return;
  const evmAddr = toEvmAddress(contractAddress);
  const del = db.prepare('DELETE FROM smart_contract_storage WHERE lower(contract_address) = lower(?) AND slot = ?');
  const upsert = db.prepare(`INSERT OR REPLACE INTO smart_contract_storage (contract_address, slot, value) VALUES (?, ?, ?)`);
  const slots = knownSlots.get(normalizeHex(contractAddress)) || new Set();
  for (const rawSlot of writtenSlots) {
    const slotBuf = Buffer.isBuffer(rawSlot) ? rawSlot : new BN(rawSlot).toArrayLike(Buffer, 'be', 32);
    const slotHex = slotBuf.toString('hex');
    slots.add(slotHex);
    const value = await new Promise((resolve) => {
      vm.stateManager.getContractStorage(evmAddr, slotBuf, (err, val) => resolve(val));
    });
    const valueHex = value && value.length ? value.toString('hex') : '';
    if (valueHex === '' || /^0*$/.test(valueHex)) {
      del.run(contractAddress, slotHex);
    } else {
      upsert.run(contractAddress, slotHex, valueHex);
    }
  }
  knownSlots.set(normalizeHex(contractAddress), slots);
}

async function SaveSmartContractState(contractAddress) {
  if (!db) return { saved: 0 };
  const key = normalizeHex(contractAddress);
  const vm = vmCache.get(key);
  if (!vm) return { saved: 0 };
  const evmAddr = toEvmAddress(contractAddress);
  const slots = knownSlots.get(key) || new Set();
  const del = db.prepare('DELETE FROM smart_contract_storage WHERE lower(contract_address) = lower(?) AND slot = ?');
  const upsert = db.prepare(`INSERT OR REPLACE INTO smart_contract_storage (contract_address, slot, value) VALUES (?, ?, ?)`);
  let saved = 0;
  for (const slotHex of slots) {
    const value = await new Promise((resolve) => {
      vm.stateManager.getContractStorage(evmAddr, Buffer.from(slotHex, 'hex'), (err, val) => resolve(val));
    });
    const valueHex = value && value.length ? value.toString('hex') : '';
    if (valueHex === '' || /^0*$/.test(valueHex)) {
      del.run(contractAddress, slotHex);
    } else {
      upsert.run(contractAddress, slotHex, valueHex);
      saved++;
    }
  }
  db.prepare('UPDATE smart_contracts SET updated_at = ? WHERE lower(address) = lower(?)')
    .run(Math.floor(Date.now() / 1000), contractAddress);
  await flushContractBalance(vm, contractAddress);
  return { saved };
}

async function runWithStorage(vm, contractAddress, params) {
  await loadContractStorage(vm, contractAddress);
  const writtenSlots = new Set();
  const onStep = (info) => {
    if (info.opcode && info.opcode.name === 'SSTORE') {
      writtenSlots.add(info.stack[info.stack.length - 1]);
    }
  };  vm.on('step', onStep);
  try {
    const result = await vm.runCode(params);
    if (!result.exceptionError) {
      await saveContractStorage(vm, contractAddress, writtenSlots);
      await flushContractBalance(vm, contractAddress);
    }
    return result;
  } finally {
    vm.removeListener('step', onStep);
  }
}

function normalizeHex(input) {
  if (Buffer.isBuffer(input)) return input.toString('hex');
  if (typeof input !== 'string') throw new TypeError('expected hex string or Buffer');
  return input.replace(/^0x/i, '').toLowerCase();
}

function toEvmAddress(systemAddress) {
  return Buffer.from(normalizeHex(systemAddress).slice(2), 'hex');
}

function fromEvmAddress(evmBuf) {
  return '0xcc' + evmBuf.toString('hex');
}

function assertValidAddress(address, label) {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{42}$/.test(address)) {
    throw new TypeError(`${label} must be a valid address (0xcc + 40 hex), got: ${address}`);
  }
}

function assertValidCode(code) {
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) {
    throw new TypeError('code must be a hex string prefixed with 0x');
  }
  if (normalizeHex(code).length === 0) {
    throw new TypeError('code must not be empty');
  }
  if (normalizeHex(code).length / 2 > MAX_CONTRACT_CODE_SIZE) {
    throw new RangeError(`code exceeds max size of ${MAX_CONTRACT_CODE_SIZE} bytes`);
  }
}

function deriveContractAddress(senderAddress, nonce) {
  assertValidAddress(senderAddress, 'senderAddress');
  const senderBuf = Buffer.from(normalizeHex(senderAddress), 'hex');
  const contractBuf = generateAddress(senderBuf, rlp.encode(BigInt(nonce)));
  return '0xcc' + contractBuf.toString('hex');
}

function decodeRevertReason(returnValue) {
  try {
    const buf = Buffer.isBuffer(returnValue) ? returnValue : Buffer.from(normalizeHex(returnValue || ''), 'hex');
    if (buf.length < 68 || buf.slice(0, 4).toString('hex') !== '08c379a0') return null;
    const length = new BN(buf.slice(36, 68)).toNumber();
    return buf.slice(68, 68 + length).toString('utf8');
  } catch (e) {
    return null;
  }
}

function parseResult(result) {
  if (result.exceptionError) {
    const reason = decodeRevertReason(result.returnValue);
    const err = new Error(
      reason
        ? `contract reverted: ${reason}`
        : `contract reverted: ${result.exceptionError.error || result.exceptionError}`
    );
    err.code = 'VM_REVERT';
    if (reason) err.reason = reason;
    throw err;
  }
  return {
    returnValue: '0x' + result.returnValue.toString('hex'),
    gasUsed: result.gasUsed.toString(),
    logs: result.logs || [],
  };
}

async function creditContractValue(vm, contractAddress, senderAddress, value) {
  const amount = new BN(value || 0);
  if (amount.isZero()) return;
  const evmAddr = toEvmAddress(contractAddress);
  const account = await new Promise((resolve, reject) => {
    vm.stateManager.getAccount(evmAddr, (err, acc) => (err ? reject(err) : resolve(acc)));
  });
  account.balance = toBuffer(new BN(account.balance).add(amount));
  await new Promise((resolve, reject) => {
    vm.stateManager.putAccount(evmAddr, account, (err) => (err ? reject(err) : resolve()));
  });
}

// Credita `value` no saldo (account balance) de um contrato de forma determinística:
// restaura o estado do DB, credita na trie do VM e persiste o novo balance. Usado pelo
// caminho de consenso (addBlock) para txs de chamada com valor, mantendo o balance do
// contrato capturado no contract_state_root.
async function creditContractBalance(contractAddress, value) {
  assertValidAddress(contractAddress, 'contractAddress');
  const amount = new BN(value || 0);
  if (amount.isZero()) return { credited: 0 };
  const vm = getVm(contractAddress);
  await loadContractStorage(vm, contractAddress);
  await creditContractValue(vm, contractAddress, null, amount);
  await flushContractBalance(vm, contractAddress);
  return { credited: 1 };
}

async function CreateSmartContract(code, context, senderAddress, nonce, value = 0, gasLimit, gasPrice) {
  assertValidAddress(senderAddress, 'senderAddress');
  assertValidCode(code);
  if (!Number.isInteger(nonce) || nonce < 0) throw new TypeError('nonce must be a non-negative integer');

  const contractAddress = deriveContractAddress(senderAddress, nonce);

  if (db) {
    const existing = db.prepare('SELECT address FROM smart_contracts WHERE lower(address) = lower(?)').get(contractAddress);
    if (existing) {
      const err = new Error(`contract already exists at ${contractAddress}`);
      err.code = 'CONTRACT_EXISTS';
      throw err;
    }
  }

  const vm = getVm(contractAddress);
  await creditContractValue(vm, contractAddress, senderAddress, value);
  const result = await runWithStorage(vm, contractAddress, {
    code: Buffer.from(normalizeHex(code), 'hex'),
    gasLimit: new BN(gasLimit || initialSmartContractGasLimit),
    gasPrice: new BN(gasPrice || initialSmartContractGasPrice),
    address: toEvmAddress(contractAddress),
    caller: toEvmAddress(senderAddress),
    value: new BN(value || 0),
    ...context,
  });

  const runtimeCode = normalizeHex(result.returnValue);
  if (runtimeCode.length === 0) {
    const err = new Error('init code did not return any runtime code');
    err.code = 'EMPTY_RUNTIME_CODE';
    throw err;
  }
  if (runtimeCode.length / 2 > MAX_CONTRACT_CODE_SIZE) {
    throw new RangeError(`runtime code exceeds max size of ${MAX_CONTRACT_CODE_SIZE} bytes`);
  }

  if (db) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO smart_contracts (address, creator, code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contractAddress, senderAddress.toLowerCase(), runtimeCode, now, now);
  }

  return { ...parseResult(result), contractAddress, runtimeCode: '0x' + runtimeCode };
}

async function runSmartContract(contractAddress, senderAddress, data = '', value = 0, gasLimit, gasPrice, block) {
  assertValidAddress(contractAddress, 'contractAddress');
  assertValidAddress(senderAddress, 'senderAddress');
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new TypeError('data must be a hex string prefixed with 0x');
  }

  const contract = db
    ? db.prepare('SELECT code FROM smart_contracts WHERE lower(address) = lower(?)').get(contractAddress)
    : null;
  if (!contract || !contract.code) {
    const err = new Error(`contract not found at ${contractAddress}`);
    err.code = 'CONTRACT_NOT_FOUND';
    throw err;
  }

  const vm = getVm(contractAddress);
  const params = {
    code: Buffer.from(contract.code, 'hex'),
    gasLimit: new BN(gasLimit || initialSmartContractGasLimit),
    gasPrice: new BN(gasPrice || initialSmartContractGasPrice),
    address: toEvmAddress(contractAddress),
    caller: toEvmAddress(senderAddress),
    value: new BN(value || 0),
    data: data ? Buffer.from(normalizeHex(data), 'hex') : Buffer.alloc(0),
  };
  if (block) params.block = block;
  const result = await runWithStorage(vm, contractAddress, params);

  return parseResult(result);
}

function getSmartContract(contractAddress) {
  assertValidAddress(contractAddress, 'contractAddress');
  if (!db) return null;
  const row = db.prepare('SELECT * FROM smart_contracts WHERE lower(address) = lower(?)').get(contractAddress);
  return row || null;
}

function listSmartContracts() {
  if (!db) return [];
  return db.prepare('SELECT * FROM smart_contracts ORDER BY created_at DESC').all();
}

async function getAccountBalance(address, inVmOfContract) {
  assertValidAddress(address, 'address');
  const vm = inVmOfContract ? getVm(inVmOfContract) : getVm(address);
  const evmAddr = toEvmAddress(address);
  return new Promise((resolve, reject) => {
    vm.stateManager.getAccount(evmAddr, (err, acc) => (err ? reject(err) : resolve(new BN(acc.balance))));
  });
}

module.exports = {
  setDatabase, clearVmCache, CreateSmartContract, runSmartContract, getSmartContract, listSmartContracts,
  SaveSmartContractState, InitialSmartContractGasPriceHumanReadable, deriveContractAddress,
  toChecksumAddress, toEvmAddress, fromEvmAddress, MAX_CONTRACT_CODE_SIZE, getAccountBalance,
  creditContractBalance,
};
