/* ================= ChocoHub MiniNode — frontend logic ================= */
(() => {
  'use strict';

  const TOKEN = document.querySelector('meta[name="csrf-token"]').content;

  const $ = (id) => document.getElementById(id);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  const state = {
    running: false,
    config: null,
    wallets: [],
    minerUnlocked: false,
    node: { health: null, stats: null, mining: null, mempool: [], mempool_count: 0 },
    networkStorage: { peers: [], local: { plots_count: 0, capacidade_gb: 0 }, fetched_at: 0 },
    dataDir: '',
    logs: [],
    blkOffset: 0,
    blkPage: 50,
  };

  /* ---------------- api ---------------- */
  async function api(path, opts = {}) {
    const init = {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers: { 'Authorization': 'Bearer ' + TOKEN },
    };
    if (init.method !== 'GET') init.headers['Content-Type'] = 'application/json';
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new Error('Cannot reach local node server');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* noop */ }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('HTTP ' + res.status));
    }
    return data;
  }

  /* ---------------- toasts ---------------- */
  function toast(msg, type = 'ok') {
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 800);
    }, 3400);
  }

  async function copyText(text, label = 'Copied') {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(label);
  }

  const trunc = (s, n = 10) =>
    s && s.length > n + 8 ? s.slice(0, n) + '…' + s.slice(-6) : (s || '—');

  const fmtCC = (n) => {
    if (n == null || isNaN(n)) return '—';
    if (n >= 1e6) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
    if (n > 0) return n.toLocaleString('en-US', { maximumSignificantDigits: 4 });
    return '0';
  };

  const fmtDur = (sec) => {
    if (sec == null) return '—';
    sec = Math.max(0, sec | 0);
    const d = (sec / 86400) | 0, h = ((sec % 86400) / 3600) | 0, m = ((sec % 3600) / 60) | 0;
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    return m + 'm ' + (sec % 60) + 's';
  };

  /* ---------------- tabs / theme ---------------- */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    t.classList.add('active');
    $('panel-' + t.dataset.tab).classList.add('active');
    if (t.dataset.tab === 'blocks') loadBlocks();
    if (t.dataset.tab === 'mempool') loadMempoolTab();
    if (t.dataset.tab === 'wallet') renderWalletTab();
  }));

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('themeBtn').textContent = theme === 'dark' ? '☀' : '☾';
  }
  setTheme(localStorage.getItem('ch_mini_theme') || 'dark');
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ch_mini_theme', next);
    setTheme(next);
  });

  $$('.modal [data-close], .modal-x').forEach(b => b.addEventListener('click', closeModal));

  function openModal(id) { $(id).hidden = false; }
  function closeModal() { $$('.modal').forEach(m => m.hidden = true); }
  document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('modal')) closeModal();
  });

  /* ---------------- state polling ---------------- */
  async function pollState() {
    try {
      const d = await api('/api/state');
      state.running = d.running;
      state.config = d.config;
      state.wallets = d.wallets;
      state.minerUnlocked = d.miner_unlocked;
      state.node = d.node;
      state.networkStorage = d.network_storage || state.networkStorage;
      state.dataDir = d.data_dir;
      renderAll();
    } catch (e) {
      document.body.classList.remove('running');
      setPill('offline', 'SERVER OFFLINE');
    }
  }

  async function pollLogs() {
    try {
      const res = await fetch('/api/logs', { headers: { 'x-admin-token': TOKEN } });
      if (res.ok) {
        const d = await res.json();
        state.logs = d.logs;
        renderLogs();
      }
    } catch (e) { /* noop */ }
  }

  /* ---------------- rendering ---------------- */
  function setPill(cls, text, sub) {
    const pill = $('nodePill');
    pill.classList.remove('online', 'offline', 'running');
    if (cls) pill.classList.add(cls);
    $('nodeText').textContent = text;
    $('nodeSub').textContent = sub || '';
  }

  function renderAll() {
    const h = state.node.health;
    if (state.running) {
      if (h && h.height != null) setPill('online', 'ONLINE · h' + h.height, state.config.port ? ':' + state.config.port : '');
      else setPill('running', 'STARTING…', state.config.port ? ':' + state.config.port : '');
    } else {
      setPill('offline', 'STOPPED', '');
    }

    const mb = $('minerBadge');
    const addr = (state.config && state.config.minerAddress) || '';
    if (addr) {
      mb.textContent = (state.minerUnlocked ? '✓ ' : '') + trunc(addr, 8);
      mb.className = 'badge ' + (state.minerUnlocked ? 'green' : 'yellow');
    } else {
      mb.textContent = 'NO MINER';
      mb.className = 'badge';
    }

    $('btnStart').classList.toggle('hidden', state.running);
    $('btnStop').classList.toggle('hidden', !state.running);
    $('statHeight').textContent = h && h.height != null ? h.height : '—';
    $('statPeers').textContent = h ? (h.peers != null ? h.peers : '—') : '—';
    const mining = state.node.mining;
    $('statMining').textContent = mining && mining.active ? 'ON' : (state.config && state.config.miningEnabled ? 'PENDING' : 'OFF');
    $('statUptime').textContent = h ? fmtDur(h.uptime) : '—';

    // network storage (local + peers)
    const ns = state.networkStorage;
    const localPlots = (ns.local && ns.local.plots_count) || 0;
    const localGb = (ns.local && ns.local.capacidade_gb) || 0;
    let peerPlots = 0, peerGb = 0;
    (ns.peers || []).forEach(p => { peerPlots += p.plots_count || 0; peerGb += p.capacidade_gb || 0; });
    const totalPlots = localPlots + peerPlots;
    const totalGb = localGb + peerGb;
    $('statNetStorage').textContent = totalPlots + ' plots';
    $('statNetStorageSub').textContent = fmtCC(totalGb) + ' GB total · ' + (ns.peers ? ns.peers.length : 0) + ' peers';

    const st = state.node.stats || {};
    $('dHash').textContent = h && h.hash ? trunc(h.hash, 12) : '—';
    $('dVersion').textContent = st.version || '—';
    $('dReward').textContent = st.current_reward_cc != null ? fmtCC(st.current_reward_cc) + ' CC' : '—';
    $('dHalving').textContent = st.blocks_to_halving != null ? st.blocks_to_halving.toLocaleString() : '—';
    $('dChain').textContent = (st.chain_name || '—') + ' · ' + (st.chain_id || '');

    renderWallets();
    renderMining();
  }

  /* ---------------- blocks ---------------- */
  async function loadBlocks() {
    try {
      const d = await api('/api/blocks?from=' + state.blkOffset + '&limit=' + state.blkPage);
      const blocks = d.blocks || [];
      const total = d.total || 0;
      const start = state.blkOffset;
      const end = Math.min(start + blocks.length, total);
      $('blkPage').textContent = total ? start + '–' + end + ' / ' + total : '—';
      const el = $('blocksList');
      if (!blocks.length) {
        el.innerHTML = '<div class="kv"><span>—</span><span class="mono">no blocks yet</span></div>';
        return;
      }
      el.innerHTML = blocks.slice().reverse().map(b => `
        <div class="block-row" data-h="${b.height}">
          <span class="blk-h">#${b.height}</span>
          <div class="blk-info">
            <div class="blk-miner">${trunc(b.miner || '', 14)}</div>
          </div>
          <span class="blk-txs">${(b.transactions || []).length} tx</span>
        </div>`).join('');
      $$('.block-row', el).forEach(r => r.addEventListener('click', () => showBlockDetail(r.dataset.h)));
    } catch (e) {
      $('blocksList').innerHTML = '<div class="hint bad">Failed to load blocks: ' + e.message + '</div>';
    }
  }

  async function showBlockDetail(h) {
    try {
      const b = await api('/api/block/' + h);
      $('blkDetailCard').style.display = '';
      const txs = b.transactions || [];
      $('blkDetail').innerHTML = `
        <div class="kv"><span>Height</span><span class="mono">#${b.height}</span></div>
        <div class="kv"><span>Hash</span><span class="mono" style="word-break:break-all;font-size:0.7rem">${b.hash || '—'}</span></div>
        <div class="kv"><span>Previous</span><span class="mono" style="word-break:break-all;font-size:0.7rem">${trunc(b.previous_hash || '', 16)}</span></div>
        <div class="kv"><span>Miner</span><span class="mono" style="word-break:break-all;font-size:0.7rem">${b.miner || '—'}</span></div>
        <div class="kv"><span>Transactions</span><span class="mono">${txs.length}</span></div>
        <div class="kv"><span>Nonce</span><span class="mono">${b.nonce || '—'}</span></div>
        <div class="kv"><span>Timestamp</span><span class="mono">${b.timestamp ? new Date(b.timestamp * 1000).toLocaleString() : '—'}</span></div>
        ${txs.length ? '<div style="margin-top:12px;font-size:0.72rem;color:var(--text-dim);letter-spacing:0.1em;text-transform:uppercase">Transactions</div>' + txs.map(tx => `
          <div class="mp-row">
            <div style="min-width:0">
              <div><span class="mp-from">${trunc(tx.from_addr || '', 8)}</span><span class="mp-arrow">→</span><span class="mp-to">${trunc(tx.to_addr || '', 8)}</span></div>
              <div class="mp-hash">${trunc(tx.hash || '', 12)}</div>
            </div>
            <span class="mp-val">${fmtCC(Number(tx.value || 0) / 1e18)} CC</span>
          </div>`).join('') : ''}`;
    } catch (e) {
      toast('Failed to load block: ' + e.message, 'err');
    }
  }

  $('blkPrev').addEventListener('click', () => {
    state.blkOffset = Math.max(0, state.blkOffset - state.blkPage);
    loadBlocks();
  });
  $('blkNext').addEventListener('click', () => {
    state.blkOffset += state.blkPage;
    loadBlocks();
  });
  $('blkDetailClose').addEventListener('click', () => {
    $('blkDetailCard').style.display = 'none';
  });

  $('blkSearchBtn').addEventListener('click', async () => {
    const q = $('blkSearch').value.trim();
    if (!q) return toast('Enter a block height or hash', 'err');
    await showBlockDetail(q);
  });
  $('blkSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('blkSearchBtn').click();
  });

  /* ---------------- mempool tab ---------------- */
  async function loadMempoolTab() {
    try {
      const [mp, gas] = await Promise.all([
        api('/api/mempool'),
        api('/api/gas/price'),
      ]);
      const txs = mp.transactions || [];
      $('mpTabCount').textContent = txs.length + ' pending';
      const el = $('mpList');
      if (!txs.length) {
        el.innerHTML = '<div class="kv"><span>—</span><span class="mono">mempool empty</span></div>';
      } else {
        el.innerHTML = txs.map(tx => `
          <div class="mp-row">
            <div style="min-width:0;flex:1">
              <div><span class="mp-from">${trunc(tx.from_addr || '', 10)}</span><span class="mp-arrow">→</span><span class="mp-to">${trunc(tx.to_addr || '', 10)}</span></div>
              <div class="mp-hash">${trunc(tx.hash || '', 16)}</div>
            </div>
            <span class="mp-val">${fmtCC(Number(tx.value || 0) / 1e18)} CC</span>
          </div>`).join('');
      }
      $('mpGas').innerHTML = `
        <div class="kv"><span>Gas Price (base fee)</span><span class="mono">${gas.gas_price || '—'} wei</span></div>`;
    } catch (e) {
      $('mpList').innerHTML = '<div class="hint bad">Failed to load: ' + e.message + '</div>';
    }
  }

  $('txSearchBtn').addEventListener('click', async () => {
    const q = $('txSearch').value.trim();
    if (!q) return toast('Enter a transaction hash', 'err');
    const el = $('txSearchResult');
    try {
      const tx = await api('/api/transaction/' + encodeURIComponent(q));
      el.innerHTML = `
        <div style="margin-top:14px">
          <div class="kv"><span>Hash</span><span class="mono" style="word-break:break-all;font-size:0.7rem">${tx.hash || '—'}</span></div>
          <div class="kv"><span>Block</span><span class="mono">#${tx.block_height || '—'}</span></div>
          <div class="kv"><span>From</span><span class="mono" style="word-break:break-all;font-size:0.72rem">${tx.from_addr || '—'}</span></div>
          <div class="kv"><span>To</span><span class="mono" style="word-break:break-all;font-size:0.72rem">${tx.to_addr || '—'}</span></div>
          <div class="kv"><span>Value</span><span class="mono">${fmtCC(Number(tx.value || 0) / 1e18)} CC</span></div>
          <div class="kv"><span>Fee</span><span class="mono">${fmtCC(Number(tx.fee || 0) / 1e18)} CC</span></div>
          <div class="kv"><span>Nonce</span><span class="mono">${tx.nonce || '—'}</span></div>
          <div class="kv"><span>Gas Limit</span><span class="mono">${tx.gas_limit || '—'}</span></div>
        </div>`;
    } catch (e) {
      el.innerHTML = '<div class="hint bad">TX not found: ' + e.message + '</div>';
    }
  });
  $('txSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('txSearchBtn').click();
  });

  /* ---------------- wallet tab ---------------- */
  function renderWalletTab() {
    const el = $('wlList');
    if (!state.wallets.length) {
      el.innerHTML = '<div class="hint">No wallets registered on this node.</div>';
      return;
    }
    el.innerHTML = state.wallets.map(w => `
      <div class="wl-item" data-addr="${w.address}">
        <span class="wl-addr">${w.address}</span>
      </div>`).join('');
    $$('.wl-item', el).forEach(item => {
      item.addEventListener('click', () => {
        const addr = item.dataset.addr;
        $('wlAddr').value = addr;
        $('wlQrAddr').value = addr;
        $('wlHistAddr').value = addr;
        genQr();
      });
    });
  }

  /* generate wallet (ephemeral, not stored) */
  $('wlGenBtn').addEventListener('click', async () => {
    const el = $('wlGenResult');
    try {
      const d = await api('/api/wallet/create', { body: {} });
      el.innerHTML = `
        <div class="wl-gen-box">
          <div><span class="card-sub">ADDRESS</span><code class="mono" style="word-break:break-all">${d.address}</code></div>
          <div><span class="card-sub">PUBLIC KEY</span><code class="mono" style="word-break:break-all;font-size:0.68rem">${d.public_key}</code></div>
          <div><span class="card-sub">PRIVATE KEY</span><code class="mono" style="word-break:break-all;font-size:0.68rem;color:var(--pink)">${d.private_key}</code></div>
          <p class="hint bad" style="margin-top:10px">Save these now. They won't be shown again.</p>
        </div>`;
      toast('Wallet generated — save your keys!');
    } catch (e) { el.innerHTML = '<div class="hint bad">' + e.message + '</div>'; }
  });

  /* balance lookup */
  $('wlBalBtn').addEventListener('click', async () => {
    const addr = $('wlAddr').value.trim();
    if (!addr) return toast('Enter an address', 'err');
    const el = $('wlBalResult');
    try {
      const d = await api('/api/accounts?address=' + encodeURIComponent(addr));
      el.innerHTML = `<div class="bal-display">
        <div class="bal-val">${fmtCC(Number(d.balance || 0) / 1e18)} CC</div>
        <div class="bal-label">${addr}</div>
        <div class="bal-nonce">Nonce: ${d.nonce || 0}</div>
      </div>`;
    } catch (e) {
      el.innerHTML = '<div class="hint bad">' + e.message + '</div>';
    }
  });

  /* generate wallet (mining tab modals only) */
  $('btnNewWallet').addEventListener('click', () => { $('newErr').classList.add('hidden'); openModal('newModal'); });
  $('btnImportWallet').addEventListener('click', () => { $('impErr').classList.add('hidden'); openModal('importModal'); });

  $('btnCreate').addEventListener('click', async () => {
    try {
      const d = await api('/api/wallet/create', { body: {} });
      closeModal();
      $('newName').value = ''; $('newPass').value = '';
      await api('/api/node/settings', { body: { minerAddress: d.address } });
      toast('Wallet created — address: ' + trunc(d.address, 12));
      pollState();
    } catch (e) { $('newErr').textContent = e.message; $('newErr').classList.remove('hidden'); }
  });

  $('btnDoImport').addEventListener('click', async () => {
    try {
      const d = await api('/api/wallet/import', { body: { private_key: $('impKey').value.trim() } });
      closeModal();
      $('impKey').value = ''; $('impName').value = '';
      await api('/api/node/settings', { body: { minerAddress: d.address } });
      toast('Wallet imported — address: ' + trunc(d.address, 12));
      pollState();
    } catch (e) { $('impErr').textContent = e.message; $('impErr').classList.remove('hidden'); }
  });

  /* QR code */
  function genQr() {
    const addr = $('wlQrAddr').value.trim();
    const wrap = $('wlQrWrap');
    wrap.innerHTML = '';
    if (!addr) { wrap.classList.add('qr-empty'); wrap.textContent = 'Select a wallet or paste an address above'; return; }
    wrap.classList.remove('qr-empty');
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    if (typeof QRCode !== 'undefined') {
      QRCode.toCanvas(canvas, addr, { width: 200, margin: 2, color: { dark: '#1c120c', light: '#fbf3e7' } }, (err) => {
        if (err) wrap.textContent = 'QR generation failed';
      });
    } else {
      wrap.textContent = 'QR library not loaded';
    }
  }
  $('wlQrAddr').addEventListener('input', genQr);
  $('wlQrCopy').addEventListener('click', () => {
    const addr = $('wlQrAddr').value.trim();
    if (addr) copyText(addr, 'Address copied');
  });

  /* send tx — server-side signing */
  $('wlSendBtn').addEventListener('click', async () => {
    const el = $('wlSendResult');
    const privKey = $('wlPrivKey').value.trim();
    const to = $('wlTo').value.trim();
    const amtStr = $('wlAmount').value.trim();
    if (!privKey) return toast('Enter private key', 'err');
    if (!to) return toast('Enter receiver', 'err');
    if (!amtStr || isNaN(parseFloat(amtStr)) || parseFloat(amtStr) <= 0) return toast('Enter valid amount', 'err');
    el.innerHTML = '<div class="hint">Signing and sending...</div>';
    try {
      const result = await api('/api/wallet/sign-and-send', {
        body: { private_key: privKey, to_addr: to, amount: amtStr }
      });
      el.innerHTML = '<div class="hint ok">Sent! TX: ' + trunc(result.hash, 12) + ' from ' + trunc(result.from, 10) + '</div>';
      $('wlPrivKey').value = '';
      toast('Transaction sent!');
    } catch (e) {
      el.innerHTML = '<div class="hint bad">Failed: ' + e.message + '</div>';
    }
  });

  /* tx history */
  $('wlHistBtn').addEventListener('click', async () => {
    const addr = $('wlHistAddr').value.trim();
    if (!addr) return toast('Enter an address', 'err');
    const el = $('wlHistList');
    try {
      const d = await api('/api/transactions?address=' + encodeURIComponent(addr) + '&limit=30');
      const txs = d.transactions || [];
      if (!txs.length) {
        el.innerHTML = '<div class="hint">No transactions found.</div>';
        return;
      }
      el.innerHTML = txs.map(tx => {
        const isIn = (tx.to_addr || '').toLowerCase() === addr.toLowerCase();
        return `<div class="hist-row">
          <span class="hist-dir ${isIn ? 'in' : 'out'}">${isIn ? 'IN' : 'OUT'}</span>
          <span class="hist-addr">${isIn ? trunc(tx.from_addr || '', 10) : trunc(tx.to_addr || '', 10)}</span>
          <span class="hist-val">${isIn ? '+' : '-'}${fmtCC(Number(tx.value || 0) / 1e18)}</span>
          <span class="hist-blk">#${tx.block_height || '—'}</span>
        </div>`;
      }).join('');
    } catch (e) {
      el.innerHTML = '<div class="hint bad">' + e.message + '</div>';
    }
  });

  function renderWallets() {
    const sel = $('minerSelect');
    const cur = (state.config && state.config.minerAddress) || '';
    if (sel.dataset.focused === '1') return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— select wallet —</option>' + state.wallets.map(w =>
      `<option value="${w.address}" data-name="${w.name}" ${w.encrypted ? 'data-enc="1"' : ''}>
        ${w.name} · ${trunc(w.address, 8)}${w.encrypted ? ' 🔒' : ''}</option>`).join('');
    if (cur) sel.value = cur; else if (prev) sel.value = prev;
  }

  function renderMining() {
    const mining = state.node.mining || {};
    const on = !!(state.config && state.config.miningEnabled);
    $('miningSwitch').checked = on;
    $('miningEm').textContent = mining.active ? 'active' : (on ? 'waiting' : 'off');
    $('mStatus').textContent = mining.active ? 'ACTIVE' : (mining.active === false ? 'stopped' : '—');
    $('mAddr').textContent = (state.config && state.config.minerAddress) ? trunc(state.config.minerAddress, 14) : '—';
    $('mDeadline').textContent = mining.best_deadline != null ? mining.best_deadline + 's' : '—';
    $('mShares').textContent = mining.shares != null ? mining.shares : '—';
    $('mRewards').textContent = mining.rewards != null ? fmtCC(mining.rewards) : '—';
    $('minerStatus').textContent = '';
    $('minerStatus').className = 'hint';
    if ((state.config && state.config.minerAddress) && !state.minerUnlocked) {
      $('minerStatus').textContent = 'Wallet locked — unlock it to enable block signing.';
      $('minerStatus').className = 'hint bad';
    }
    const mAddr = (state.config && state.config.minerAddress) || '';
    if (mAddr && state.running) fetchPlots(mAddr);
  }

  /* ---------------- logs ---------------- */
  function renderLogs() {
    const con = $('logConsole');
    if (con.dataset.frozen === '1') return;
    con.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const line of state.logs) {
      const d = document.createElement('div');
      d.className = 'l-' + (line.includes('[ERR]') ? 'err' : line.includes('[WRN]') ? 'warn' : 'info');
      d.textContent = line;
      frag.appendChild(d);
    }
    con.appendChild(frag);
    con.scrollTop = con.scrollHeight;
  }

  $('btnClearLogs').addEventListener('click', () => { state.logs = []; renderLogs(); });
  $('logConsole').addEventListener('wheel', (e) => {
    const con = $('logConsole');
    con.dataset.frozen = '1';
    clearTimeout(con.dataset.t);
    con.dataset.t = setTimeout(() => { delete con.dataset.frozen; }, 2500);
  });

  /* ---------------- node control ---------------- */
  $('btnStart').addEventListener('click', () => toast('Node is already running as the server'));
  $('btnStop').addEventListener('click', () => toast('Cannot stop — node IS the server process'));

  /* ---------------- config ---------------- */
  ['cfgPort', 'cfgPeers', 'cfgDisc'].forEach(id => {
    $(id).addEventListener('input', () => { $(id).dataset.dirty = '1'; });
  });

  $('btnSaveConfig').addEventListener('click', async () => {
    const body = {};
    const port = parseInt($('cfgPort').value, 10);
    if (!(port >= 1 && port <= 65535)) return toast('Invalid port', 'err');
    body.port = port;
    body.seedPeers = $('cfgPeers').value.split(/[,\s]+/).filter(Boolean);
    const disc = parseInt($('cfgDisc').value, 10);
    if (disc >= 0 && disc <= 65535) body.discoveryPort = disc;
    try {
      await api('/api/node/settings', { body });
      delete $('cfgPort').dataset.dirty;
      delete $('cfgPeers').dataset.dirty;
      delete $('cfgDisc').dataset.dirty;
      toast('Config saved');
    } catch (e) { toast(e.message, 'err'); }
  });

  /* ---------------- mining ---------------- */
  $('minerSelect').addEventListener('change', async (e) => {
    const addr = e.target.value;
    if (!addr) return;
    try {
      await api('/api/node/settings', { body: { minerAddress: addr } });
      toast('Miner set to ' + trunc(addr, 8));
    } catch (err) { toast(err.message, 'err'); }
  });
  $('minerSelect').addEventListener('focus', () => { $('minerSelect').dataset.focused = '1'; });
  $('minerSelect').addEventListener('blur', () => { delete $('minerSelect').dataset.focused; });

  $('btnMinerRefresh').addEventListener('click', () => { delete $('minerSelect').dataset.focused; pollState(); });

  $('btnUnlockMiner').addEventListener('click', async () => {
    const opt = $('minerSelect').selectedOptions[0];
    const name = opt && opt.dataset.name;
    const addr = $('minerSelect').value;
    if (!name && !addr) return toast('Select a wallet first', 'err');
    try {
      await api('/api/node/settings', { body: { minerAddress: addr || name } });
      $('minerPass').value = '';
      toast('Miner wallet set — web dashboard cannot decrypt local wallets');
      pollState();
    } catch (e) {
      toast(e.message, 'err');
    }
  });

  $('miningSwitch').addEventListener('change', async (e) => {
    const on = e.target.checked;
    const addr = (state.config && state.config.minerAddress) || '';
    if (on && !addr) { e.target.checked = false; toast('Select a miner wallet first', 'err'); return; }
    try {
      await api('/api/node/settings', { body: { miningEnabled: on } });
      if (state.running) {
        if (on) await api('/api/mining/start', { body: { address: addr } });
        else await api('/api/mining/stop', { body: {} });
      }
      toast(on ? 'Mining enabled' : 'Mining disabled');
    } catch (err) { toast(err.message, 'err'); }
  });

  /* ---------------- plots ---------------- */
  let plotCache = '';
  async function fetchPlots(addr) {
    if (plotCache === addr) return;
    try {
      const d = await api('/api/poc/plots/' + addr);
      plotCache = addr;
      const list = d.plots || [];
      $('plotList').innerHTML = list.length ? list.map(p =>
        `<div class="plot-item"><b>${p.plot_id}</b><span>${p.size_gb} GB · ${trunc(p.merkle_root || '', 6)}</span></div>`
      ).join('') : '<div class="hint">No plots yet for this address.</div>';
    } catch (e) { $('plotList').innerHTML = '<div class="hint">Node offline — start it to manage plots.</div>'; }
  }

  $('btnCreatePlot').addEventListener('click', async () => {
    const addr = (state.config && state.config.minerAddress) || '';
    const plotId = $('plotId').value.trim() || ('plot-' + Date.now());
    const sizeGb = parseFloat($('plotSize').value);
    if (!addr) return toast('Select a miner wallet first', 'err');
    if (!(sizeGb > 0)) return toast('Invalid size', 'err');
    $('btnCreatePlot').disabled = true;
    $('plotHint').textContent = 'Creating plot ' + plotId + ' (' + sizeGb + ' GB)… this takes a while.';
    $('plotHint').className = 'hint';
    try {
      const d = await api('/api/poc/create_plot', {
        body: { miner: addr, plot_id: plotId, size_gb: sizeGb },
        timeout: 120000,
      });
      $('plotHint').textContent = 'Plot created: ' + d.path;
      $('plotHint').className = 'hint ok';
      plotCache = '';
      fetchPlots(addr);
    } catch (e) {
      $('plotHint').textContent = 'Failed: ' + e.message;
      $('plotHint').className = 'hint bad';
    } finally {
      $('btnCreatePlot').disabled = false;
    }
  });

  /* ---------------- misc ---------------- */
  $('quitBtn').addEventListener('click', async () => {
    try { await api('/api/quit'); } catch (e) { /* noop */ }
  });

  $('btnOpenData').addEventListener('click', () => copyText(state.dataDir, 'Data path copied'));

  /* ---------------- boot ---------------- */
  pollState();
  setInterval(pollState, 2500);
  pollLogs();
  setInterval(pollLogs, 2500);
})();
