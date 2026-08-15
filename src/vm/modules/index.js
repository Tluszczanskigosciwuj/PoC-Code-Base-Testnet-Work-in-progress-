const fs = require('fs');
const path = require('path');

function load(dir) {
  const base = dir || __dirname;
  const map = {};
  const tryLoad = (p) => {
    let mod;
    try {
      mod = require(p);
    } catch (e) {
      console.error('[plugins] falha ao carregar ' + p + ': ' + (e.message || e));
      return;
    }
    if (mod && mod.id) map[mod.id] = mod;
  };
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const p = path.join(base, entry.name);
    if (entry.isDirectory()) {
      tryLoad(path.join(p, 'index.js'));
    } else if (entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'index.js') {
      tryLoad(p);
    }
  }
  return map;
}

function register(map, plugin) {
  if (!plugin || !plugin.id) throw new Error('plugin sem id');
  map[plugin.id] = plugin;
  return map;
}

module.exports = { load, register };
