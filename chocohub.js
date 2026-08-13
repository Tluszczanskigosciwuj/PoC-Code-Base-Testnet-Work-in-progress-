#!/usr/bin/env node
'use strict';

const { ChocoNode, NodeRegistry } = require('./src/node');
const { loadConfig, saveConfig, normalizeUrl, normalizeSeedPeers, log, setLogLevel, getLogBuffer, BASE_DIR, CONFIG_PATH } = require('./src/config');
const crypto_utils = require('./src/crypto');
const db = require('./src/db');
const chain = require('./src/chain');
const { Chain } = chain;
const challenge = require('./src/challenge');
const { PeerManager } = require('./src/peers');
const sync = require('./src/sync');
const { Miner } = require('./src/miner');
const plot = require('./src/plot');
const { DiscoveryServer, connectDiscoveryServer } = require('./src/discovery');
const { Server } = require('./src/server');

const {
  ZERO_HASH, sha256hex, safeInt, safeBigInt, pubkeyToAddress, pubKeyToAddress,
  signMessage, verifySignature, merkleRoot, computeMerkleProof, verifyMerkleProof,
  canonicalTxMessage, hashTransaction, hashBlock, blockMessage,
  computeStateRoot, computeStateRootAfterTxs, calculateMiningReward, isBetterChainCandidate,
  SCOOP_SIZE, SCOOPS_PER_NONCE, MINING_SCOOP_MODULUS, plotScoopCount, plotScoopCountOrig,
  computeDeadline, deriveSampleIndexes, getChainWorkForBlock,
} = crypto_utils;

const GWEI = 10 ** 9;
const TX_GAS = 21000;
function computeBaseFee(activeMiners = 1, parentGasUsed, parentGasLimit) {
  const minerAdjusted = Math.floor(GWEI / Math.max(1, activeMiners));
  if (parentGasUsed != null && parentGasLimit && parentGasLimit > 0) {
    const util = parentGasUsed / parentGasLimit;
    const mult = util > 0.5 ? 1 + (util - 0.5) / 8 : 1 - (0.5 - util) / 8;
    return Math.max(Math.floor(minerAdjusted * mult), Math.floor(GWEI / 100));
  }
  return Math.max(minerAdjusted, Math.floor(GWEI / 100));
}
function suggestedGasPrice(activeMiners = 1) { return computeBaseFee(activeMiners); }
function computeFee(gasLimit, gasPrice, priorityFee = 0) { return gasLimit * gasPrice + priorityFee; }

const { ChallengeManager, TIERS, TIER_REWARD_PCT, getTier, computeBaseTargetWithTier } = challenge;
const { initDB } = db;
const { buildPocProof, computePlotMerkleRoot, createPlotFile } = plot;

function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const node = new ChocoNode(cfg);
  node.start();
}

module.exports = {
  loadConfig, saveConfig, normalizeUrl, normalizeSeedPeers, log, setLogLevel, getLogBuffer, BASE_DIR, CONFIG_PATH,
  ZERO_HASH, sha256hex, safeInt, safeBigInt, pubkeyToAddress, pubKeyToAddress,
  signMessage, verifySignature, merkleRoot, computeMerkleProof, verifyMerkleProof,
  canonicalTxMessage, hashTransaction, hashBlock, blockMessage,
  computeStateRoot, computeStateRootAfterTxs, calculateMiningReward, isBetterChainCandidate,
  SCOOP_SIZE, SCOOPS_PER_NONCE, MINING_SCOOP_MODULUS, plotScoopCount, plotScoopCountOrig,
  computeDeadline, deriveSampleIndexes, getChainWorkForBlock,
  GWEI, TX_GAS, computeBaseFee, suggestedGasPrice, computeFee,
  TIERS, TIER_REWARD_PCT, getTier, computeBaseTargetWithTier,
  buildPocProof, computePlotMerkleRoot, createPlotFile,
  initDB,
  DiscoveryServer, connectDiscoveryServer,
  Blockchain: Chain,
  ChallengeManager,
  PeerManager,
  Miner,
  ChocoNode, NodeRegistry, Server,
};

if (require.main === module) { main(); }
