const fs = require('fs');
const path = require('path');
const solc = require('solc');

const HTLC_SOURCE = fs.readFileSync(path.join(__dirname, 'HTLC.sol'), 'utf8');
const LPMARKET_SOURCE = fs.readFileSync(path.join(__dirname, 'LPMarket.sol'), 'utf8');
const CCPOOL_SOURCE = fs.readFileSync(path.join(__dirname, 'CcPool.sol'), 'utf8');

const cache = {};

function compileSource(name, source) {
  const input = JSON.stringify({
    language: 'Solidity',
    sources: { [name + '.sol']: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'petersburg',
      outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
    },
  });
  const out = JSON.parse(solc.compile(input));
  const c = (out.contracts || {})[name + '.sol'] && out.contracts[name + '.sol'][name];
  if (!c) {
    const err = new Error('solc: ' + name + ' did not compile');
    err.details = out.errors;
    throw err;
  }
  return c.evm.bytecode.object;
}

function compileHTLC() {
  if (!cache.HTLC) cache.HTLC = compileSource('HTLC', HTLC_SOURCE);
  return cache.HTLC;
}

function compileLPMarket() {
  if (!cache.LPMarket) cache.LPMarket = compileSource('LPMarket', LPMARKET_SOURCE);
  return cache.LPMarket;
}

function compileCcPool() {
  if (!cache.CcPool) cache.CcPool = compileSource('CcPool', CCPOOL_SOURCE);
  return cache.CcPool;
}

module.exports = { HTLC_SOURCE, LPMARKET_SOURCE, CCPOOL_SOURCE, compileSource, compileHTLC, compileLPMarket, compileCcPool };
