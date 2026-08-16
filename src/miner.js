const path = require('path');
const { safeInt, safeBigInt, signMessage, proofMessage, verifyMerkleProofBuf } = require('./crypto');
const { buildPocProof } = require('./plot');
const { fetchJSON } = require('./P2P/sync');
const { log } = require('./config');

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.includes(':')) {
      const parts = url.split(':');
      const port = parseInt(parts[parts.length - 1], 10);
      if (port >= 1 && port <= 65535) {
        const host = parts.slice(0, -1).join(':').replace(/^\[|]$/g, '');
        return `http://${host}:${port}`;
      }
    }
    return null;
  }
  try {
    const u = new (require('url').URL)(url);
    if (!u.hostname) return null;
    return u.port ? `${u.protocol}//${u.hostname}:${u.port}` : `${u.protocol}//${u.hostname}`;
  } catch { return null; }
}

class Miner {
  constructor(db, cfg, chain, cm, sync, peers, NODE_ID) {
    this.db = db;
    this.cfg = cfg;
    this.chain = chain;
    this.cm = cm;
    this.sync = sync;
    this.peers = peers;
    this.NODE_ID = NODE_ID;
    this.active = false;
    this.address = '';
    this.startTime = 0;
    this.totalScans = 0;
    this.bytesRead = 0;
    this.bestDeadline = null;
    this.shares = 0;
    this._timer = null;
  }

  start(address) {
    if (!address) { log('warn', 'Miner: no address provided'); return; }
    this.address = address.toLowerCase();
    this.active = true;
    this.startTime = Date.now();
    this.totalScans = 0;
    this.bestDeadline = null;
    this.shares = 0;
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO users (address, public_key_ed25519, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(this.address, this.cfg.minerPublicKey || '', '0', 0, now, now);
      if (this.cfg.plotSizeGb) {
        const up = this.db.prepare('UPDATE plot_commitments SET size_gb = ? WHERE miner = ?').run(this.cfg.plotSizeGb, this.address);
        if (up.changes > 0) log('info', `Miner: plot size override PLOT_SIZE=${this.cfg.plotSizeGb} GB applied to ${up.changes} plot(s)`);
      }
    });
    tx();
    log('info', `Miner started — address ${address.slice(0, 10)}…`);
    this._loop();
  }

  stop() {
    this.active = false;
    clearTimeout(this._timer);
    log('info', 'Miner stopped');
  }

  _loop() {
    if (!this.active) return;
    this._mine().catch(e => log('error', `Mining error: ${e.message}`));
    const base = this.cfg.blockTimeTarget || 20;
    const jitter = 0.8 + Math.random() * 0.4;
    this._timer = setTimeout(() => this._loop(), Math.max(1000, Math.floor(base * jitter * 1000)));
  }

  async _mine() {
    try { await this.sync.loopSync(); } catch {}
    const plots = this.db.prepare('SELECT * FROM plot_commitments WHERE miner = ?').all(this.address);
    if (!plots.length) return;
    const challenge = await this._resolveMiningChallenge();
    if (!challenge) return;
    let bestProof = null, bestDeadline = Infinity, bestPlot = null;
    for (const plot of plots) {
      const plotPath = path.join(this.cfg.plotsDir, `${plot.plot_id}.plot`);
      const proof = buildPocProof(plotPath, plot.plot_id, challenge, this.cfg.plotSizeGb || plot.size_gb);
      if (!proof) continue;
      const leafHash = Buffer.from(proof.scoop_data, 'hex');
      if (!plot.merkle_root || !verifyMerkleProofBuf(leafHash, proof.scoop_index, proof.total_scoops, proof.merkle_proof, plot.merkle_root)) {
        log('warn', `Miner: skipping plot ${plot.plot_id} — merkle proof fails verification (incompatible plot format?)`);
        continue;
      }
      this.totalScans++;
      if (proof.deadline < bestDeadline) { bestDeadline = proof.deadline; bestProof = proof; bestPlot = plot; }
    }
    if (bestDeadline < Infinity) {
      this.bestDeadline = bestDeadline;
      log('info', `Miner: best deadline ${bestDeadline}s (plot ${(bestPlot.plot_id || '').slice(0, 10)}…)`);
    }
    if (!bestProof) return;
    await this._submitProof(challenge.challenge_id, bestPlot.plot_id, bestDeadline, bestProof);
  }

  async _resolveMiningChallenge() {
    const now = Math.floor(Date.now() / 1000);
    const local = this.cm.getOrCreate();
    if (local && safeInt(local.expires_at, 0) > now) return local;
    for (const p of this.peers.active(5)) {
      try {
        const d = await fetchJSON(`${p.url}/api/mining/challenge`, { timeout: 8 });
        if (d && d.challenge_id) return d;
      } catch {}
    }
    return null;
  }

  async _submitProof(challengeId, plotId, deadline, proof) {
    const targets = [normalizeUrl(`http://127.0.0.1:${this.cfg.port}`)];
    const plot = this.db.prepare('SELECT size_gb FROM plot_commitments WHERE plot_id = ? AND miner = ?').get(plotId, this.address);

    let proofSignature = '';
    if (this.cfg.minerPrivateKey) {
      try {
        const msg = proofMessage(challengeId, this.address, deadline, plotId);
        proofSignature = signMessage(msg, this.cfg.minerPrivateKey);
      } catch (e) { log('warn', `Miner: failed to sign proof: ${e.message}`); }
    }

    this.db.prepare('INSERT OR IGNORE INTO challenge_submissions (challenge_id, miner, plot_id, size_gb, deadline, proof_digest, proof_signature, submitted_at) VALUES (?,?,?,?,?,?,?,?)').run(challengeId, this.address, plotId, plot ? plot.size_gb : 0, deadline, proof.proof_digest || '', proofSignature, Math.floor(Date.now() / 1000));
    for (const target of targets) {
      try {
        const resp = await fetchJSON(`${target}/api/mining/submit-proof`, {
          method: 'POST', body: { challenge_id: challengeId, miner: this.address, plot_id: plotId, deadline, proof_packet: proof, proof_signature: proofSignature }, timeout: 8,
        });
        if (resp && resp.ok) { this.shares++; log('info', `Proof accepted at ${target}`); return true; }
      } catch {}
    }
    return false;
  }

  getMetrics() {
    const elapsed = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    let totalRewardsRaw = 0n;
    if (this.address) {
      for (const r of this.db.prepare('SELECT reward_cc FROM block_rewards WHERE miner = ?').all(this.address)) totalRewardsRaw += safeBigInt(r.reward_cc, 0n);
    }
    return {
      active: this.active, address: this.address, elapsed_sec: elapsed,
      total_scans: this.totalScans, bytes_read: this.bytesRead, best_deadline: this.bestDeadline,
      shares: this.shares, rewards: Number(totalRewardsRaw) / 1e18, rewards_raw: String(totalRewardsRaw),
      proofsBuilt: this.shares,
    };
  }
}

module.exports = { Miner };
