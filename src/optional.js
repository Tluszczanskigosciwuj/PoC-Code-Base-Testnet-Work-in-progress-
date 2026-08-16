const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const readline = require('readline');
const { log, saveConfig } = require('./config');

const OPTIONAL_MODULES_DIR = path.join(__dirname, '..', 'optional_modules');

const REGISTRY = [
  {
    name: 'discord.js',
    url: 'https://raw.githubusercontent.com/seilaman2210-rgb/PoC-Code-Base-Testnet-Work-in-progress-/main/optional_modules/discord.js',
    size_kb: 2,
    description: 'Discord webhook notifications for mined blocks',
  },
];

function registryTotalKb() {
  return REGISTRY.reduce((s, m) => s + (m.size_kb || 0), 0);
}

function isTty() {
  return Boolean(process.stdin && process.stdin.isTTY);
}

function download(url, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    transport.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          return reject(new Error('Too many redirects'));
        }
        return download(new URL(res.headers.location, u).toString(), redirectCount + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      let totalSize = 0;
      res.on('data', (c) => {
        totalSize += c.length;
        if (totalSize > MAX_SIZE) {
          res.destroy();
          return reject(new Error('Download too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function installOptionalModules() {
  fs.mkdirSync(OPTIONAL_MODULES_DIR, { recursive: true });
  for (const mod of REGISTRY) {
    try {
      const buf = await download(mod.url);
      let content = buf.toString('utf8');
      content = content.replace(/require\(['"]\.\/([^'"]+)['"]\)/g, (match, rel) => {
        const srcCandidate = path.join(__dirname, '..', 'src', rel);
        return fs.existsSync(srcCandidate) || fs.existsSync(srcCandidate + '.js')
          ? `require('../src/${rel}')`
          : match;
      });
      fs.writeFileSync(path.join(OPTIONAL_MODULES_DIR, mod.name), content);
      log('info', `Optional module installed: ${mod.name} (${(Buffer.byteLength(content) / 1024).toFixed(1)} KB)`);
    } catch (e) {
      log('warn', `Failed to download optional module ${mod.name}: ${e.message}`);
    }
  }
}

function promptDownload() {
  const totalKb = registryTotalKb();
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      try { rl.close(); } catch {}
      resolve(answer);
    };
    rl.question(`\nWould you like to download optional modules? [~${totalKb} KB] (S/n) `, (answer) => {
      const a = (answer || '').trim().toLowerCase();
      settle(a === '' || a === 's' || a === 'sim' || a === 'y' || a === 'yes' ? 'yes' : 'no');
    });
    setTimeout(() => settle('no'), 15000);
  });
}

async function setupOptionalModules(cfg) {
  const force = process.env.OPTIONAL_MODULES;
  if (force === '0') {
    cfg.optionalModulesAsked = true;
    saveConfig(cfg);
    return 'disabled';
  }
  if (force === '1') {
    cfg.optionalModulesAsked = true;
    saveConfig(cfg);
    await installOptionalModules();
    return 'installed';
  }
  if (cfg.optionalModulesAsked) return 'skipped';
  if (!isTty()) return 'skipped';
  const answer = await promptDownload();
  cfg.optionalModulesAsked = true;
  saveConfig(cfg);
  if (answer === 'yes') {
    await installOptionalModules();
    return 'installed';
  }
  return 'no';
}

function loadOptionalModules() {
  const loaded = {};
  if (!fs.existsSync(OPTIONAL_MODULES_DIR)) return loaded;
  for (const file of fs.readdirSync(OPTIONAL_MODULES_DIR)) {
    if (!file.endsWith('.js')) continue;
    try {
      const mod = require(path.join(OPTIONAL_MODULES_DIR, file));
      for (const hook of Object.keys(mod)) {
        if (typeof mod[hook] === 'function') {
          loaded[hook] = loaded[hook] || [];
          loaded[hook].push({ name: file, fn: mod[hook] });
        }
      }
      log('info', `Optional module loaded: ${file}`);
    } catch (e) {
      log('warn', `Failed to load optional module ${file}: ${e.message}`);
    }
  }
  return loaded;
}

function runHook(modules, hook, ...args) {
  for (const m of (modules && modules[hook]) || []) {
    try { m.fn(...args); } catch (e) { log('warn', `Optional module ${m.name} ${hook} error: ${e.message}`); }
  }
}

module.exports = {
  REGISTRY,
  OPTIONAL_MODULES_DIR,
  setupOptionalModules,
  loadOptionalModules,
  runHook,
};
