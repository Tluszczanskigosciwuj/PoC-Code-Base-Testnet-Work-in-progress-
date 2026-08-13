const GAS_PARAMS = {
  simpleTransferGas: 21000,
  gasPerByteZero: 4,
  gasPerByteNonZero: 16,
  initialBaseFee: 10 ** 9,
  blockGasLimit: 10500000,
};

function estimateIntrinsicGas(tx) {
  let gas = GAS_PARAMS.simpleTransferGas;
  const data = tx.data ? Buffer.from(tx.data, 'hex') : Buffer.alloc(0);
  for (const byte of data) {
    gas += byte === 0 ? GAS_PARAMS.gasPerByteZero : GAS_PARAMS.gasPerByteNonZero;
  }
  return gas;
}

function nextBaseFee(parentBaseFee, parentGasUsed, targetGas, minGasPrice, mempoolPendingCount) {
  if (parentGasUsed === targetGas) return parentBaseFee;
  const delta = parentGasUsed > targetGas
    ? (parentBaseFee * BigInt(parentGasUsed - targetGas)) / BigInt(targetGas) / 8n
    : -(parentBaseFee * BigInt(targetGas - parentGasUsed)) / BigInt(targetGas) / 8n;
  let next = parentBaseFee + delta;

  if (mempoolPendingCount < targetGas / GAS_PARAMS.simpleTransferGas / 4) {
    next = (next * 95n) / 100n;
  }

  if (next < BigInt(minGasPrice)) next = BigInt(minGasPrice);
  return next;
}

module.exports = {
  GAS_PARAMS,
  estimateIntrinsicGas,
  nextBaseFee,
};