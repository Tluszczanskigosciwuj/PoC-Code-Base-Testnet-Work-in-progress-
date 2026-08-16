const fs = require('fs');
const crypto = require('crypto');
const { sha256hex, sha256buf, merkleRootBuf2, computeMerkleProofBuf2, computeMerkleTreeNodes, merkleTreeInternalNodeCount, computeDeadline, plotScoopCount, SCOOP_SIZE, SCOOPS_PER_NONCE, MINING_SCOOP_MODULUS, ZERO_HASH, PLOT_FORMAT_V3 } = require('./crypto');
const { log } = require('./config');

const HEADER_SIZE = 256;

function plotTotalSize(totalScoops) {
  return HEADER_SIZE + totalScoops * SCOOP_SIZE + merkleTreeInternalNodeCount(totalScoops) * 32;
}

function detectPlotFormat(plotPath) {
  try {
    const stat = fs.statSync(plotPath);
    if (stat.size < HEADER_SIZE + 32) return null;
    const fd = fs.openSync(plotPath, 'r');
    try {
      const header = Buffer.alloc(104);
      fs.readSync(fd, header, 0, 104, 0);
      if (header.toString('ascii', 0, 8) !== 'CHOCOHUB') return null;
      const version = header.readUInt32LE(8);
      const totalScoops = header.readUInt32LE(64);
      const scoopSize = header.readUInt32LE(68);
      if (totalScoops < 1) return null;
      if (version !== PLOT_FORMAT_V3 || scoopSize !== 32) return null;
      const expected = plotTotalSize(totalScoops);
      if (stat.size !== expected) return null;
      return { version: PLOT_FORMAT_V3, totalScoops, accountId: header.slice(104, 136).toString('hex') };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readMerkleProofFromFile(plotPath, totalScoops, scoopIndex) {
  const treeStart = HEADER_SIZE + totalScoops * SCOOP_SIZE;
  const fd = fs.openSync(plotPath, 'r');
  try {
    const proof = [];
    let idx = scoopIndex;
    let count = totalScoops;
    let treeOffset = 0;

    while (count > 1) {
      const siblingIdx = idx ^ 1;
      if (siblingIdx < count) {
        if (count === totalScoops) {
          const pos = HEADER_SIZE + siblingIdx * SCOOP_SIZE;
          const buf = Buffer.alloc(SCOOP_SIZE);
          fs.readSync(fd, buf, 0, SCOOP_SIZE, pos);
          proof.push(buf);
        } else {
          const pos = treeStart + (treeOffset + siblingIdx) * 32;
          const nodeBuf = Buffer.alloc(32);
          fs.readSync(fd, nodeBuf, 0, 32, pos);
          proof.push(nodeBuf);
        }
      }
      idx >>= 1;
      const nextCount = (count + 1) >> 1;
      if (count !== totalScoops) treeOffset += count;
      count = nextCount;
    }
    return proof;
  } finally { fs.closeSync(fd); }
}

function readPlotScoops(plotPath, totalScoops) {
  const fd = fs.openSync(plotPath, 'r');
  try {
    const buf = Buffer.alloc(totalScoops * 32);
    const scoop = Buffer.alloc(SCOOP_SIZE);
    for (let i = 0; i < totalScoops; i++) {
      const pos = HEADER_SIZE + i * SCOOP_SIZE;
      const bytes = fs.readSync(fd, scoop, 0, SCOOP_SIZE, pos);
      if (bytes < SCOOP_SIZE) scoop.fill(0, bytes);
      sha256buf(scoop).copy(buf, i * 32);
    }
    return buf;
  } finally { fs.closeSync(fd); }
}

function buildPocProof(plotPath, plotId, challenge, plotSizeGb) {
  if (!fs.existsSync(plotPath)) return null;
  const fmt = detectPlotFormat(plotPath);
  if (!fmt) return null;
  const totalScoops = fmt.totalScoops;
  const miningModulus = MINING_SCOOP_MODULUS;
  try {
    const fd = fs.openSync(plotPath, 'r');
    try {
      const height = parseInt(challenge.block_height || challenge.height || 0, 10) || 0;
      const genSig = challenge.challenge_seed || challenge.generation_signature || '';
      const scoopNum = (height + parseInt(sha256hex(genSig).slice(0, 8), 16)) % miningModulus;
      let bestDeadline = Infinity, bestScoopData = null;
      let bestScoopIndex = 0;
      for (let i = scoopNum; i < totalScoops; i += miningModulus) {
        const pos = HEADER_SIZE + i * SCOOP_SIZE;
        const buf = Buffer.alloc(SCOOP_SIZE);
        const bytes = fs.readSync(fd, buf, 0, SCOOP_SIZE, pos);
        if (bytes < SCOOP_SIZE) buf.fill(0, bytes);
        const dl = computeDeadline(buf, genSig, plotSizeGb, challenge.base_target || undefined);
        if (dl < bestDeadline) { bestDeadline = dl; bestScoopData = buf; bestScoopIndex = i; }
      }
      if (bestDeadline === Infinity || bestDeadline <= 0) return null;

      const merkleProof = readMerkleProofFromFile(plotPath, totalScoops, bestScoopIndex);

      const proofDigest = sha256hex(Buffer.concat([bestScoopData, Buffer.from(String(bestDeadline))]));
      return { proof_version: 1, scoop_num: scoopNum, deadline: Math.floor(bestDeadline), proof_digest: proofDigest, read_count: Math.ceil(totalScoops / miningModulus), scoop_data: bestScoopData.toString('hex'), merkle_proof: merkleProof.map(b => b.toString('hex')), scoop_index: bestScoopIndex, total_scoops: totalScoops };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function computePlotMerkleRoot(plotPath, plotSizeGb) {
  if (!fs.existsSync(plotPath)) return null;
  const fmt = detectPlotFormat(plotPath);
  if (!fmt) return null;
  const totalScoops = fmt.totalScoops;
  const treeCount = merkleTreeInternalNodeCount(totalScoops);
  const treeStart = HEADER_SIZE + totalScoops * SCOOP_SIZE;
  const rootOffset = treeStart + (treeCount - 1) * 32;
  const buf = Buffer.alloc(32);
  const fd = fs.openSync(plotPath, 'r');
  try {
    fs.readSync(fd, buf, 0, 32, rootOffset);
    return buf.toString('hex');
  } finally { fs.closeSync(fd); }
}

function computeAccountId(publicKey) {
  if (typeof publicKey === 'string') publicKey = Buffer.from(publicKey, 'hex');
  return crypto.createHash('sha256').update(publicKey).digest();
}

function generateV3Scoops(accountId, nonce, count) {
  const base = crypto.createHash('sha256').update(Buffer.concat([accountId, Buffer.from([nonce & 0xFF, (nonce >> 8) & 0xFF, (nonce >> 16) & 0xFF, (nonce >> 24) & 0xFF])])).digest();
  const scoops = Buffer.alloc(count * 32);
  for (let i = 0; i < count; i++) {
    const idxBuf = Buffer.from([i & 0xFF, (i >> 8) & 0xFF, (i >> 16) & 0xFF, (i >> 24) & 0xFF]);
    crypto.createHash('sha256').update(Buffer.concat([base, idxBuf])).digest().copy(scoops, i * 32);
  }
  return scoops;
}

function createPlotFile(plotPath, plotId, minerAddress, sizeGb, accountId) {
  const totalScoops = plotScoopCount(sizeGb);
  if (totalScoops < 1) return null;

  const scoopsPerNonce = SCOOPS_PER_NONCE;
  const numNonces = Math.ceil(totalScoops / scoopsPerNonce);

  if (!accountId) {
    accountId = crypto.randomBytes(32);
  } else if (typeof accountId === 'string') {
    accountId = Buffer.from(accountId, 'hex');
  }

  const leafBuf = Buffer.alloc(totalScoops * 32);
  for (let n = 0; n < numNonces; n++) {
    const nonceScoops = Math.min(scoopsPerNonce, totalScoops - n * scoopsPerNonce);
    const scoopData = generateV3Scoops(accountId, n, nonceScoops);
    scoopData.copy(leafBuf, n * scoopsPerNonce * 32, 0, nonceScoops * 32);
  }

  const treeNodes = computeMerkleTreeNodes(leafBuf, totalScoops);
  const root = treeNodes.subarray(-32).toString('hex') || ZERO_HASH;

  const plotSize = plotTotalSize(totalScoops);
  const buf = Buffer.alloc(plotSize);

  buf.write('CHOCOHUB', 0, 'ascii');
  buf.writeUInt32LE(PLOT_FORMAT_V3, 8);
  const idHigh = parseInt(plotId.slice(0, 8), 16) || 0;
  const idLow = parseInt(plotId.slice(8, 16), 16) || 0;
  buf.writeUInt32LE(idHigh, 12);
  buf.writeUInt32LE(idLow, 16);
  buf.write(minerAddress.padEnd(44, '\0'), 20, 44, 'ascii');
  buf.writeUInt32LE(totalScoops, 64);
  buf.writeUInt32LE(SCOOP_SIZE, 68);
  buf.write(root, 72, 64, 'hex');
  accountId.copy(buf, 104);

  let offset = HEADER_SIZE;
  for (let n = 0; n < numNonces; n++) {
    const nonceScoops = Math.min(scoopsPerNonce, totalScoops - n * scoopsPerNonce);
    const scoopData = generateV3Scoops(accountId, n, nonceScoops);
    scoopData.copy(buf, offset);
    offset += nonceScoops * 32;
  }

  treeNodes.copy(buf, HEADER_SIZE + totalScoops * 32);

  fs.writeFileSync(plotPath, buf);
  return { plotId, sizeGb, totalScoops, merkleRoot: root, accountId: accountId.toString('hex') };
}

module.exports = { buildPocProof, computePlotMerkleRoot, createPlotFile, detectPlotFormat, computeAccountId, generateV3Scoops };