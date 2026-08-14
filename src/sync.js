const { URL } = require('url');
const { safeInt, safeBigInt, hashBlock, hashTransaction, isBetterChainCandidate } = require('./crypto');
const { log } = require('./config');

function fetchJSON(url, opts = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const timeout = (opts.timeout || 10) * 1000;
    const req = mod.request(url, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

class SyncEngine {
  constructor(db, cfg, chain, peers, challengeMgr, NODE_ID) {
    this.db = db;
    this.cfg = cfg;
    this.chain = chain;
    this.peers = peers;
    this.challengeMgr = challengeMgr;
    this.NODE_ID = NODE_ID;
    this.syncing = false;
    this._lastReorg = 0;
  }

  async discoverPeers() {
    const selfHost = (() => { try { return this.cfg.nodeUrl ? new (require('url').URL)(this.cfg.nodeUrl).hostname : null; } catch { return null; } })();
    const targets = [...new Set([...(this.cfg.seedPeers || []), ...this.peers.active(20).map(p => p.url)])];
    for (const url of targets) {
      try {
        const normalized = new (require('url').URL)(url);
        if (selfHost && normalized.hostname === selfHost) continue;
        const data = await fetchJSON(`${url.replace(/\/+$/, '')}/peers`, { timeout: 8 });
        log('info', `[P2P] Discovered peers from ${url}: ${data && Array.isArray(data.peers) ? data.peers.length + ' peers' : data}`);
        if (data && Array.isArray(data.peers) && data.peers.length > 0) {
          for (const p of data.peers) {
            if (p.url) this.peers.add(p.url);
          }
        }
      } catch {
        this.peers.fail(url);
      }
    }
  }

  async loopSync() {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const peers = this.peers.active(10).filter(p => {
        try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
      });
      for (const peer of peers) {
        try {
          const remote = await fetchJSON(`${peer.url}/api/stats`, { timeout: 5 });
          if (!remote || typeof remote.altura !== 'number') continue;
          const remoteWork = safeBigInt(remote.chain_work, 0n);
          const localTip = this.chain.getBlock(this.chain.altura);
          const localWork = safeBigInt(localTip ? localTip.chain_work : 0n, 0n);
          if (remoteWork <= localWork) continue;
          log('debug', `loopSync: peer=${peer.url} remoteHeight=${remote.altura} remoteWork=${remote.chain_work} localHeight=${this.chain.altura} localWork=${localTip ? localTip.chain_work : 0}`);
          await this._syncFromPeer(peer.url, remote.altura);
          break;
        } catch (e) { log('debug', `loopSync: peer=${peer.url} error=${e.message}`); }
      }
    } finally { this.syncing = false; }
  }

  async _findCommonAncestor(peerUrl) {
    let h = this.chain.altura;
    while (h >= 0) {
      const local = this.chain.getBlock(h);
      if (!local) { h = Math.max(0, h - 50); continue; }
      const remote = await fetchJSON(`${peerUrl}/api/block/${h}`, { timeout: 5 });
      if (remote && remote.hash && remote.hash === local.hash) return h;
      h--;
      if (h % 100 === 0) await new Promise(r => setTimeout(r, 10));
    }
    return 0;
  }

  async _syncFromPeer(peerUrl, remoteHeight) {
    const commonHeight = await this._findCommonAncestor(peerUrl);
    let from = Math.max(0, commonHeight + 1);
    let inserted = 0;
    const maxBlocks = this.cfg.maxBlocksPerSync || 10000;
    log('info', `Syncing from ${peerUrl} — ancestor=${commonHeight} target=${remoteHeight}`);
    while (from <= remoteHeight && inserted < maxBlocks) {
      try {
        const data = await fetchJSON(`${peerUrl}/api/blocks?from=${from}&limit=50`, { timeout: 15 });
        if (!data || !Array.isArray(data.blocks) || !data.blocks.length) break;
        let advanced = false;
        for (const block of data.blocks) {
          if (block.height < from) continue;
          if (this.db.prepare('SELECT 1 FROM blocks WHERE hash = ?').get(block.hash)) {
            if (block.height >= from) { from = block.height + 1; advanced = true; }
            continue;
          }
          block._from_local_forge = false;
          const insertResult = await this.chain._insertBlockDirect(block);
          if (!insertResult.ok) { log('debug', `sync: block insert rejected at #${block.height}: ${insertResult.motivo}`); break; }
          inserted++;
          from = block.height + 1;
          advanced = true;
        }
        if (!advanced) break;
        log('info', `Sync progress: ${inserted} blocks inserted, at #${from - 1}/${remoteHeight}`);
      } catch (e) { log('debug', `sync fetch error: ${e.message}`); break; }
    }
    if (inserted > 0) {
      this.chain._selectTip();
      this.chain._purgeOrphanedBlocks();
      const peerTip = await fetchJSON(`${peerUrl}/api/block/${remoteHeight}`, { timeout: 5 });
      if (peerTip && peerTip.hash) {
        const reorgResult = await this.chain.reorganize(peerTip, true);
        if (reorgResult.ok) {
          log('info', `Synced ${inserted} blocks from ${peerUrl}, reorged to #${reorgResult.height} ${(reorgResult.hash || '').slice(0, 10)}`);
        } else {
          log('debug', `sync: reorg after bulk insert failed: ${reorgResult.motivo}`);
        }
      }
    }
  }

  async mempoolSync() {
    const peers = this.peers.active(5).filter(p => {
      try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
    });
    for (const peer of peers) {
      try {
        const data = await fetchJSON(`${peer.url}/api/mempool`, { timeout: 5 });
        if (data && Array.isArray(data.transactions)) {
          for (const tx of data.transactions) {
            this.chain.addMempoolTx(tx);
          }
        }
      } catch {}
    }
  }

  async heartbeat() {
    const peers = this.peers.active(20).filter(p => {
      try { const u = new (require('url').URL)(p.url); if (this.cfg.nodeUrl && u.hostname === new (require('url').URL)(this.cfg.nodeUrl).hostname) return false; } catch {} return true;
    });
    for (const peer of peers) {
      try {
        const stats = this.chain.getStats();
        const res = await fetchJSON(`${peer.url}/api/node/announce`, {
          method: 'POST', body: {
            url: this.cfg.nodeUrl, height: this.chain.altura,
            node_id: this.NODE_ID, chain_work: stats.chain_work,
          }, timeout: 5,
        });
        if (res) {
          this.peers.seen(peer.url, safeInt(res.our_height, 0), res.node_id);
          if (Array.isArray(res.peers)) {
            for (const p of res.peers) if (p.url) this.peers.add(p.url);
            log('info', `[P2P] Heartbeat: ${peer.url} reported ${res.peers.length} peers, our_height=${res.our_height}, node_id=${res.node_id}`)
          }
        }
      } catch { this.peers.fail(peer.url); }
    }
  }

  async announce() {
    if (!this.cfg.nodeUrl) return;
    const selfHost = (() => { try { return new (require('url').URL)(this.cfg.nodeUrl).hostname; } catch { return null; } })();
    for (const seed of this.cfg.seedPeers || []) {
      try {
        if (selfHost && new (require('url').URL)(seed).hostname === selfHost) continue;
        const stats = this.chain.getStats();
        log('info', `[P2P] Announcing to seed peer ${seed}: height=${this.chain.altura}, chain_work=${stats.chain_work}, node_id=${this.NODE_ID}`);
        await fetchJSON(`${seed.replace(/\/+$/, '')}/register`, {
          method: 'POST', body: {
            url: this.cfg.nodeUrl, node_id: this.NODE_ID, height: this.chain.altura,
            chain_work: stats.chain_work, version: this.cfg.version, peers: this.peers.count(),
          }, timeout: 8,
        });
      } catch { this.peers.fail(seed); }
    }
  }

  async broadcastBlock(block) {
    const peers = this.peers.active(10);
    if (!peers.length) return { accepted: 0, total: 0, noPeers: true };
    let accepted = 0;
    for (const peer of peers) {
      try {
        const res = await fetchJSON(`${peer.url}/api/node/broadcast/block`, {
          method: 'POST', body: { block }, timeout: 10,
        });
        if (res && res.ok) accepted++;
      } catch {}
    }
    return { accepted, total: peers.length, noPeers: false };
  }

  async broadcastTx(tx) {
    const peers = this.peers.active(10);
    for (const peer of peers) {
      try {
        await fetchJSON(`${peer.url}/api/node/broadcast/tx`, {
          method: 'POST', body: { tx }, timeout: 5,
        });
      } catch {}
    }
  }

  getStatus() {
    return { syncing: this.syncing, current_height: this.chain.altura, last_reorg: this._lastReorg };
  }
}

module.exports = { SyncEngine, fetchJSON };
