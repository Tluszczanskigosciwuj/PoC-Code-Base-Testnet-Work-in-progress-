const crypto = require('crypto');

function _fallbackHashBlock(block) {
  const ZERO_HASH = '0'.repeat(64);
  let rewardsStr = '';
  if (Array.isArray(block.rewards)) {
    const normalized = block.rewards.map(r => {
      const n = {};
      for (const k of Object.keys(r).sort()) n[k] = r[k];
      return n;
    });
    rewardsStr = JSON.stringify(normalized);
  }
  let winnerProofStr = '';
  if (block.winner_proof && typeof block.winner_proof === 'object') {
    const wp = {};
    for (const k of Object.keys(block.winner_proof).sort()) wp[k] = block.winner_proof[k];
    winnerProofStr = JSON.stringify(wp);
  }
  const d = {
    contract_state_root: block.contract_state_root || '',
    generation_signature: block.generation_signature || ZERO_HASH,
    height: block.height || 0,
    miner: block.miner || '',
    nonce: String(block.nonce || '0'),
    parent_hash: block.parent_hash || '',
    reward_cc: String(block.reward_cc || '0'),
    rewards: rewardsStr,
    target: String(block.target || '0'),
    timestamp: block.timestamp || 0,
    tx_count: parseInt(block.tx_count || 0, 10),
    tx_root: block.tx_root || '',
    state_root: block.state_root || '',
    winner_proof: winnerProofStr,
  };
  return crypto.createHash('sha256').update(JSON.stringify(d, Object.keys(d).sort())).digest('hex');
}

function _fallbackVerifySignature(message, sigB64, pubB64) {
  try {
    const pubRaw = Buffer.from(pubB64, 'base64');
    if (pubRaw.length !== 32) return false;
    const sig = Buffer.from(sigB64, 'base64');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]);
    const pubObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), pubObj, sig);
  } catch { return false; }
}

function _fallbackCanonicalTxMessage(tx) {
  return JSON.stringify({
    chain_id: String(tx.chain_id || '0'),
    data: String(tx.data || ''),
    fee: String(tx.fee || '0'),
    from_addr: tx.from_addr,
    gas_limit: tx.gas_limit || 21000,
    gas_price: String(tx.gas_price || '1'),
    nonce: tx.nonce,
    priority_fee: String(tx.priority_fee || '0'),
    to_addr: tx.to_addr || '',
    value: String(tx.value),
  }, [
    'chain_id', 'data', 'fee', 'from_addr', 'gas_limit', 'gas_price',
    'nonce', 'priority_fee', 'to_addr', 'value',
  ].sort());
}

async function hashBlockAsync(block) {
  return _fallbackHashBlock(block);
}

async function verifySignatureAsync(message, signature, pubkey) {
  return _fallbackVerifySignature(message, signature, pubkey);
}

async function canonicalTxMessageAsync(tx) {
  return _fallbackCanonicalTxMessage(tx);
}

async function hashBlocksAsync(blocks) {
  return blocks.map(_fallbackHashBlock);
}

async function verifySignaturesAsync(items) {
  return items.map(i => _fallbackVerifySignature(i.message, i.signature, i.pubkey));
}

function terminateWorkerPool() {}

module.exports = {
  hashBlockAsync,
  verifySignatureAsync,
  canonicalTxMessageAsync,
  hashBlocksAsync,
  verifySignaturesAsync,
  terminateWorkerPool,
};