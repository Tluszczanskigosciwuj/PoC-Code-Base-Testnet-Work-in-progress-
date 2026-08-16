process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e && e.stack ? e.stack : e); });

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, log, setLogLevel } = require('./config');
const { initDB } = require('./Blockchain/db');
const { Chain } = require('./Blockchain/chain');
const { ChallengeManager, getTier } = require('./Blockchain/challenge');
const { PeerManager } = require('./P2P/peers');
const { SyncEngine } = require('./P2P/sync');
const { Miner } = require('./miner');
const { Server } = require('./server');
const { P2PWebSocketServer } = require('./P2P/p2p-ws');
const { setupOptionalModules, loadOptionalModules } = require('./optional');

class NodeRegistry {
  constructor(db) {
    this.db = db;
  }
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    return { total_nodes: total, active_nodes: total, seed_version: '3.6.0-js' };
  }
  registerNode(url, nodeId, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('INSERT OR REPLACE INTO nodes (url, node_id, height, chain_work, version, peers, first_seen, last_seen) VALUES (?,?,?,?,?,?,COALESCE((SELECT first_seen FROM nodes WHERE url = ?), ?),?)').run(url, nodeId, opts.height || 0, opts.chain_work || '0', opts.version || '', opts.peers || 0, url, now, now);
  }
  all() { return this.db.prepare('SELECT * FROM nodes ORDER BY last_seen DESC').all(); }
}

class ChocoNode {
  constructor(cfg) {
    this.cfg = cfg;
    this.NODE_ID = crypto.randomBytes(16).toString('hex');
    this.db = null;
    this.chain = null;
    this.peers = null;
    this.challengeMgr = null;
    this.sync = null;
    this.miner = null;
    this.server = null;
    this.p2pWsServer = null;
    this._stopDiscovery = null;
  }

  async start() {
    const cfg = this.cfg;
    setLogLevel(cfg.logLevel);

    for (const d of [cfg.dataDir, path.dirname(cfg.dbPath), cfg.plotsDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch {}
    }

    if (!cfg.adminToken || cfg.adminToken.length < 16) {
      cfg.adminToken = crypto.randomBytes(16).toString('hex');
      try { fs.writeFileSync(path.join(cfg.dataDir, 'admin_token.txt'), cfg.adminToken); } catch {}
      log('info', `Admin token: ${cfg.adminToken}`);
    }

    this._configPath = require('./config').CONFIG_PATH;

    this._printBanner();

    try {
      await setupOptionalModules(cfg);
    } catch (e) {
      log('warn', `Optional modules setup skipped: ${e.message}`);
    }
    this.optionalModules = loadOptionalModules();
    if (Object.keys(this.optionalModules).length > 0) {
      log('info', `Optional modules hooks: ${Object.keys(this.optionalModules).join(', ')}`);
    }

    this.db = initDB(cfg.dbPath, cfg);
    this.smartContracts = null;
    if (cfg.smartContractsEnabled) {
      try {
        this.smartContracts = require('./vm/smartcontracts');
        this.smartContracts.setDatabase(this.db);
        log('info', `Smart contracts (EVM) enabled`);
      } catch (e) {
        log('warn', `Smart contracts enabled but VM unavailable: ${e.message}`);
        this.smartContracts = null;
      }
    } else {
      log('info', `Smart contracts (EVM) disabled`);
    }

    this.chain = new Chain(this.db, cfg);
    if (this.smartContracts) this.chain.setContractExecutor(this.smartContracts);
    this.peers = new PeerManager(this.db, cfg);
    for (const seed of (cfg.seedPeers || [])) this.peers.add(seed);
    this.challengeMgr = new ChallengeManager(this.db, this.chain, cfg, this.optionalModules);
    this.registry = new NodeRegistry(this.db);
    this.sync = new SyncEngine(this.db, cfg, this.chain, this.peers, this.challengeMgr, this.NODE_ID);
    this.miner = new Miner(this.db, cfg, this.chain, this.challengeMgr, this.sync, this.peers, this.NODE_ID);

    this.server = new Server(cfg, this.db, this.chain, this.peers, this.sync, this.miner, this.challengeMgr, this.registry, this.NODE_ID, this.smartContracts, this.p2pWsServer);
    this.server.start();

    if (cfg.p2pWsPort && cfg.p2pWsPort > 0) {
      this.p2pWsServer = new P2PWebSocketServer(cfg.p2pWsPort, this.chain, this.sync, this.peers);
      await this.p2pWsServer.start();
      log('info', `[P2P-WS] WebSocket P2P server started on port ${cfg.p2pWsPort}`);
    }

    setInterval(() => { try { this.peers.decayHealth(); } catch {} }, 300000);
    setInterval(() => { try { this.chain.cleanMempool(); } catch {} }, 60000);
    setInterval(() => { try { this.chain.prune(); } catch {} }, 600000);
    setInterval(() => { this.challengeMgr.finalizeExpiredChallenges(this.chain, this.sync).catch(e => log('error', `Finalize error: ${e.message}`)); }, 5000);
    setInterval(() => { this.sync.loopSync().catch(() => {}); }, cfg.syncIntervalMs || 10000);
    setInterval(() => { this.sync.heartbeat().catch(() => {}); }, cfg.heartbeatMs || 20000);
    setInterval(() => { this.sync.discoverPeers().catch(() => {}); }, cfg.discoveryMs || 30000);

    setTimeout(async () => {
      log('info', 'Initial sync...');
      for (let i = 0; i < 3; i++) { try { await this.sync.loopSync(); } catch {} if (this.chain.height > 0) break; }
      try { await this.sync.mempoolSync(); } catch {}
      if (cfg.nodeUrl) {
        await this.sync.announce();
        await this.sync.announce();
      }
      if (cfg.miningEnabled && cfg.minerAddress) {
        setTimeout(() => this.miner.start(cfg.minerAddress), 3000);
      }
    }, 2000);

    this._setupShutdown();
  }

  _printBanner() {
    const cfg = this.cfg;
    console.log('');
    console.log('\x1b[32m\x1b[1m' +
      '     _               _       _     \n' +
      ' ___| |_ ___ ___ ___| |_ _ _| |_   \n' +
      '|  _|   | . |  _| . |   | | | . |  \n' +
      '|___|_|_|___|___|___|_|_|___|___|  \n' +
      '                                    \n' +
      ' _____ _     _              _      \n' +
      '|     |_|___|_|   ___ ___ _| |___  \n' +
      '| | | | |   | |  |   | . | . | -_| \n' +
      '|_|_|_|_|_|_|_|  |_|_|___|___|___|\x1b[0m');
    console.log('');
    console.log(`  \x1b[2mPort: ${cfg.port}  |  Peers: ${cfg.seedPeers.length} seeds  |  Mining: ${cfg.miningEnabled ? '\x1b[32mON' : '\x1b[2mOFF'}\x1b[0m`);
    if (cfg.nodeUrl) console.log(`  \x1b[2mURL: ${cfg.nodeUrl}\x1b[0m`);
    if (cfg.discoveryPort > 0) console.log(`  \x1b[2mDiscovery: WS on port ${cfg.discoveryPort}\x1b[0m`);
    if (cfg.discoveryUrl) console.log(`  \x1b[2mDiscovery client: ${cfg.discoveryUrl}\x1b[0m`);
    console.log('');
  }

  _setupShutdown() {
    const shutdown = () => {
      if (this._stopDiscovery) this._stopDiscovery();
      log('info', 'Shutting down...');
      this.miner.stop();
      try { this.db.close(); } catch {}
      if (this.server) this.server.stop();
      setTimeout(() => process.exit(0), 5000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

module.exports = { ChocoNode, NodeRegistry };
