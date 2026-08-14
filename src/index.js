#!/usr/bin/env node
const { loadConfig } = require('./config');
const { ChocoNode } = require('./node');

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  ChocoNode — PoC Testnet Node

  USAGE:
    node src/index.js              Start the node
    node src/index.js --help       Show this help

  ENVIRONMENT VARIABLES:
    PORT=3001                      HTTP port
    MINING_ENABLED=true            Enable mining
    MINER_ADDRESS=0x...            Miner wallet address
    MINER_PRIVATE_KEY=hex          Private key for block signing
    LOG_LEVEL=info                 Log level (trace/debug/info/warn/error)
    DISCOVERY_PORT=7777            WebSocket discovery port
    DISCOVERY_URL=ws://...         Connect to remote discovery server
    NODE_URL=http://...            Public node URL
    SEED_PEERS=url1,url2           Comma-separated seed peers
    DB_PATH=./db/choco-node.db     Database path
    DATA_DIR=./node-data           Data directory
    PLOTS_DIR=./plots              Plot directory
    ADMIN_TOKEN=...                Admin API token

  CONFIG FILES:
    config.env                     KEY=VALUE overrides (loaded automatically)
    node_config.json               Auto-generated, overrides defaults

  EXAMPLES:
    node src/index.js
    PORT=3002 node src/index.js
    MINING_ENABLED=true MINER_ADDRESS=0x... node src/index.js
  `);
  process.exit(0);
}

const cfg = loadConfig();
const node = new ChocoNode(cfg);
node.start();
