const { ZERO_HASH, sha256hex, safeInt, safeBigInt, hashBlock, hashTransaction, merkleRoot, computeStateRoot, computeStateRootAfterTxs, computeContractStateRoot, verifySignature, calculateMiningReward, isBetterChainCandidate, canonicalTxMessage, blockMessage, signMessage, proofMessage } = require('./crypto');
const { estimateIntrinsicGas, nextBaseFee, GAS_PARAMS } = require('./consensus/gas');
const { log } = require('./config');
const BN = require('bn.js');
const Block = require('ethereumjs-block');

const FINALIZATION_DEPTH = 30;
function normalizeAddr(a) { return typeof a === 'string' ? a.toLowerCase() : a; }

class Chain {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
    this.altura = 0;
    this.melhorHash = ZERO_HASH;
    this.contracts = null;
    this._loadTip();
    if (!this.getBlock(0)) this._initGenesis();
    try { this.db.prepare('ALTER TABLE transactions ADD COLUMN block_hash TEXT DEFAULT ""').run(); } catch (e) { /* already exists */ }
      try { this.db.prepare('ALTER TABLE blocks ADD COLUMN base_target TEXT').run(); } catch (e) { /* already exists */ }
      try { this.db.prepare('ALTER TABLE blocks ADD COLUMN contract_state_root TEXT DEFAULT ""').run(); } catch (e) { /* already exists */ }
      try { this.db.prepare('ALTER TABLE transactions ADD COLUMN data TEXT DEFAULT ""').run(); } catch (e) { /* already exists */ }
  }

  setContractExecutor(sc) { this.contracts = sc; }

  _initGenesis() {
    const cfg = this.cfg;
    const now = cfg.genesisTimestamp || Math.floor(Date.now() / 1000);
    const target = cfg.initialTarget || '0x00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
    const reward = calculateMiningReward(0, cfg);
    const state_root = computeStateRoot(this.db);
    const genesis = {
      height: 0, parent_hash: ZERO_HASH, timestamp: now,
      miner: 'genesis', challenge_id: '', tx_root: ZERO_HASH,
      nonce: '0', difficulty: '0', target: String(target),
      reward_units: '0', reward_cc: String(reward), tx_count: 0,
      signature: '', generation_signature: ZERO_HASH,
      proof_digest: '', plot_id: '', state_root,
      origin: 'genesis', total_fees_units: '0', gas_used: 0, gas_limit: 30000000, base_target: this._defaultBaseTarget(),
      transactions: [], rewards: [],
    };
    genesis.hash = hashBlock(genesis);
    try {
      const work = this._blockWork(genesis);
      const totalFees = 0n;
      const gasUsed = 0;
      this.db.prepare(`INSERT INTO blocks (height, hash, parent_hash, timestamp, miner, challenge_id, tx_root, nonce, difficulty, target,
        reward_units, reward_cc, tx_count, chain_work, signature, generation_signature, proof_digest, plot_id, state_root, origin,
        total_fees_units, gas_used, gas_limit, base_target, base_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        0, genesis.hash, ZERO_HASH, now, 'genesis', '', ZERO_HASH, '0', '0', String(target),
        '0', String(reward), 0, String(work), '', ZERO_HASH, '', '', state_root, 'genesis',
        String(totalFees), gasUsed, 30000000, genesis.base_target, String(GAS_PARAMS.initialBaseFee)
      );
      this.altura = 0;
      this.melhorHash = genesis.hash;
      log('info', `Genesis block created — hash: ${genesis.hash.slice(0, 16)}`);
    } catch (e) {
      log('warn', `Genesis creation skipped (${e.message})`);
    }
  }

  _loadTip() {
    const row = this.db.prepare('SELECT height, hash FROM blocks ORDER BY LENGTH(chain_work) DESC, chain_work DESC, hash ASC LIMIT 1').get();
    if (row) { this.altura = row.height; this.melhorHash = row.hash; }
  }

  _attachTransactions(bloco) {
    if (bloco && !Array.isArray(bloco.transactions)) {
      bloco.transactions = this.db.prepare('SELECT * FROM transactions WHERE block_hash = ? ORDER BY rowid').all(bloco.hash);
    }
    return bloco;
  }

  getBlock(heightOrHash) {
    let row;
    if (typeof heightOrHash === 'number' || /^\d+$/.test(String(heightOrHash))) {
      row = this.db.prepare('SELECT * FROM blocks WHERE height = ? ORDER BY LENGTH(chain_work) DESC, chain_work DESC, hash ASC LIMIT 1').get(Number(heightOrHash));
    } else {
      row = this.db.prepare('SELECT * FROM blocks WHERE hash = ?').get(heightOrHash);
    }
    return this._attachTransactions(row);
  }

  getBlockByHash(hash) { return this._attachTransactions(this.db.prepare('SELECT * FROM blocks WHERE hash = ?').get(hash)); }

  getStats() {
    const tip = this.getBlock(this.altura);
    const totalTxs = this.db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
    const wallets = this.db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const mempoolCount = this.db.prepare('SELECT COUNT(*) as c FROM mempool').get().c;
    const plotsCount = this.db.prepare('SELECT COUNT(DISTINCT plot_id) as c FROM plot_commitments').get().c;
    const capacityGbRaw = this.db.prepare('SELECT COALESCE(SUM(size_gb), 0) as s FROM (SELECT DISTINCT plot_id, size_gb FROM plot_commitments)').get().s;
    const capacityGb = Number(capacityGbRaw) || 0;
    const totalBlocks = this.db.prepare('SELECT COUNT(*) as c FROM blocks').get().c;
    const supply = this.db.prepare("SELECT balance FROM users").all().reduce((s, r) => s + safeBigInt(r.balance, 0n), 0n).toString();
    return {
      altura: this.altura, hash: this.melhorHash, blocos: totalBlocks,
      usuarios: wallets, total_txs: totalTxs, mempool: mempoolCount,
      plots_count: plotsCount, capacidade_gb: Number(capacityGb.toFixed(2)), // capacityGb is now guaranteed numeric
      chain_work: (tip && tip.chain_work) || '0',
      supply: String(supply), max_deadline: this.computeMaxDeadline(),
      base_target: (tip && tip.base_target) || String(BigInt(2) ** BigInt(64) / BigInt(5898240)),
    };
  }

  _targetForHeight(height) {
    if (height === 0) {
      try { return BigInt(this.cfg.initialTarget); } catch { return BigInt('0x00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF'); }
    }
    const interval = this.cfg.difficultyAdjustBlocks || 8192;
    const expected = this.cfg.expectedTimePerBlock || 240;
    if (height % interval !== 0) {
      const prev = this.db.prepare('SELECT target FROM blocks WHERE height = ?').get(height - 1);
      if (prev) try { return BigInt(prev.target); } catch {}
      try { return BigInt(this.cfg.initialTarget); } catch { return 0n; }
    }
    const prevInterval = this.db.prepare('SELECT timestamp FROM blocks WHERE height = ?').get(Math.max(0, height - interval));
    const latest = this.db.prepare('SELECT timestamp FROM blocks WHERE height = ?').get(height - 1);
    if (prevInterval && latest) {
      const actual = latest.timestamp - prevInterval.timestamp;
      const target = BigInt(this._targetForHeight(height - 1));
      if (actual < expected / 2) return target * 2n;
      if (actual > expected * 2) return target / 2n;
      const ratio = BigInt(Math.floor((expected * 1000) / Math.max(1, actual)));
      return (target * ratio) / 1000n;
    }
    try { return BigInt(this.cfg.initialTarget); } catch { return 0n; }
  }

  _blockWork(block) {
    try {
      const target = BigInt(block.target || this.cfg.initialTarget || '0x00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
      if (target <= 0n) return 1n;
      return (BigInt(2) ** BigInt(256)) / target;
    } catch { return 1n; }
  }

  _defaultBaseTarget() {
    return String(BigInt(2) ** BigInt(64) / BigInt(120));
  }

  _baseTargetForHeight(height) {
    if (height === 0) return this._defaultBaseTarget();
    const windowSize = this.cfg.difficultyAdjustBlocks || 8192;
    if (height < windowSize) {
      const prev = this.db.prepare('SELECT base_target FROM blocks WHERE height = ?').get(height - 1);
      return (prev && prev.base_target) ? prev.base_target : this._defaultBaseTarget();
    }
    const latest = this.db.prepare('SELECT timestamp FROM blocks WHERE height = ?').get(height - 1);
    const oldest = this.db.prepare('SELECT timestamp FROM blocks WHERE height = ?').get(height - windowSize);
    if (!latest || !oldest) return this._defaultBaseTarget();
    const actualDuration = latest.timestamp - oldest.timestamp;
    const expectedDuration = (this.cfg.expectedTimePerBlock || 240) * (windowSize - 1);
    if (actualDuration <= 0) return this._defaultBaseTarget();
    const prevRow = this.db.prepare('SELECT base_target FROM blocks WHERE height = ?').get(height - 1);
    const prevTarget = BigInt((prevRow && prevRow.base_target) || this._defaultBaseTarget());
    const ratio = (BigInt(actualDuration) * 1000n) / BigInt(expectedDuration);
    let newTarget = (prevTarget * ratio) / 1000n;
    if (newTarget > prevTarget * 4n) newTarget = prevTarget * 4n;
    if (newTarget < prevTarget / 4n) newTarget = prevTarget / 4n;
    if (newTarget < 1n) newTarget = 1n;
    if (newTarget > 1000000000000000n) newTarget = 1000000000000000n;
    return String(newTarget);
  }

  _baseFeeForHeight(height) {
  if (height === 0) return GAS_PARAMS.initialBaseFee;
  const parent = this.db.prepare('SELECT base_fee, gas_used FROM blocks WHERE height = ?').get(height - 1);
  if (!parent) return GAS_PARAMS.initialBaseFee;
    return String(nextBaseFee(
      BigInt(parent.base_fee) || BigInt(GAS_PARAMS.initialBaseFee),
      parent.gas_used || 0,
      GAS_PARAMS.blockGasLimit / 2,
      this.cfg.minGasPrice
    ));
}

  async addBlock(bloco, opts = {}) {
    const { skipTxValidation = false, skipPocValidation = false, skipStateValidation = false, skipSignature = false, skipHashValidation = false, skipTargetValidation = false, forceSync = false, skipContractStateValidation = false } = opts;
    const isLocalForge = !!bloco._from_local_forge;
    const blockOrigin = isLocalForge ? 'local' : 'network';
    delete bloco._from_local_forge;
    const height = bloco.height;
    if (typeof height !== 'number') return { ok: false, motivo: 'height missing' };
    if (!bloco.hash || !bloco.parent_hash) return { ok: false, motivo: 'hash or parent_hash missing' };
    if (this.db.prepare('SELECT 1 FROM blocks WHERE hash = ?').get(bloco.hash)) return { ok: true, motivo: 'already known' };
    if (!skipHashValidation && hashBlock(bloco) !== bloco.hash) return { ok: false, motivo: 'block hash mismatch' };
    if (bloco.miner) bloco.miner = normalizeAddr(bloco.miner);
    if (Array.isArray(bloco.rewards)) bloco.rewards.forEach(r => { if (r.miner) r.miner = normalizeAddr(r.miner); });
    if (height > 0) {
      const parent = this.db.prepare('SELECT height, timestamp, hash, chain_work FROM blocks WHERE hash = ?').get(bloco.parent_hash);
      if (!parent) return { ok: false, motivo: 'parent not found' };
      if (parent.height !== height - 1) return { ok: false, motivo: 'height sequence error' };
      if (safeInt(bloco.timestamp, -1) <= safeInt(parent.timestamp, -1)) return { ok: false, motivo: 'timestamp <= parent' };
      if (safeInt(bloco.timestamp, 0) > Date.now() / 1000 + this.cfg.maxFutureBlockSec) return { ok: false, motivo: 'timestamp too far in future' };
      if (bloco.challenge_id && bloco.nonce) {
        const ch = this.db.prepare('SELECT created_at, winner_deadline FROM mining_challenges WHERE challenge_id = ?').get(bloco.challenge_id);
        if (ch && ch.winner_deadline) {
          const earliestForge = (ch.created_at || 0) + ch.winner_deadline;
          if (safeInt(bloco.timestamp, 0) < earliestForge) {
            return { ok: false, motivo: `block forged too early: timestamp ${bloco.timestamp} < earliest ${earliestForge} (deadline ${ch.winner_deadline}s)` };
          }
        }
      }
      const expectedTarget = this._targetForHeight(height);
      let blockTarget;
      try { blockTarget = BigInt(bloco.target || '0'); } catch { blockTarget = 0n; }
      if (blockTarget === 0n) try { blockTarget = BigInt(this.cfg.initialTarget); } catch { blockTarget = 0n; }
      if (!skipTargetValidation && blockTarget !== expectedTarget) return { ok: false, motivo: `incorrect target: got ${blockTarget}, expected ${expectedTarget}` };
      const expectedBaseTarget = BigInt(this._baseTargetForHeight(height));
      const blockBaseTarget = BigInt(bloco.base_target || String(BigInt(2) ** BigInt(64) / BigInt(5898240)));
      if (!skipTargetValidation && blockBaseTarget !== expectedBaseTarget) {
        return { ok: false, motivo: `incorrect base_target: got ${blockBaseTarget}, expected ${expectedBaseTarget}` };
      }
      if (!bloco.base_target) bloco.base_target = String(expectedBaseTarget);
    }
    const txs = bloco.transactions || [];
    if (!skipTxValidation) {
      const [ok, motivo] = this._validateTxOrder(txs);
      if (!ok) return { ok: false, motivo };
      if (!this._txRootMatches(bloco)) return { ok: false, motivo: 'tx_root mismatch' };
      if (safeInt(bloco.tx_count, txs.length) !== txs.length) return { ok: false, motivo: 'tx_count mismatch' };
    }
    if (height > 0 && !skipSignature) {
      if (!bloco.signature) return { ok: false, motivo: 'block not signed' };
      const pkRow = this.db.prepare('SELECT public_key_ed25519 FROM users WHERE address = ?').get(bloco.miner);
      if (!pkRow || !pkRow.public_key_ed25519) return { ok: false, motivo: 'miner not registered or no key' };
      if (!verifySignature(blockMessage(bloco), bloco.signature, pkRow.public_key_ed25519)) return { ok: false, motivo: 'invalid block signature' };

      // Verify winner_proof: proves the claimed miner actually submitted the winning proof
      const wp = bloco.winner_proof;
      if (bloco.challenge_id && wp && wp.proof_signature) {
        const wpMiner = normalizeAddr(wp.miner || '');
        if (wpMiner !== bloco.miner) {
          return { ok: false, motivo: 'winner_proof.miner does not match block.miner' };
        }
        const wpPk = this.db.prepare('SELECT public_key_ed25519 FROM users WHERE lower(address) = lower(?)').get(wpMiner);
        if (!wpPk || !wpPk.public_key_ed25519) {
          return { ok: false, motivo: 'winner_proof miner has no public key' };
        }
        const wpMsg = proofMessage(bloco.challenge_id, wpMiner, wp.deadline, wp.plot_id);
        if (!verifySignature(wpMsg, wp.proof_signature, wpPk.public_key_ed25519)) {
          return { ok: false, motivo: 'invalid winner_proof signature — miner did not submit this proof' };
        }
      } else if (bloco.challenge_id && height > 0 && !bloco.challenge_id.startsWith('0x0000')) {
        // For non-genesis blocks with a challenge, require winner_proof
        // (relaxed for backward compatibility with pre-security blocks)
        const hasSubmissions = this.db.prepare('SELECT 1 FROM challenge_submissions WHERE challenge_id = ? LIMIT 1').get(bloco.challenge_id);
        if (hasSubmissions) {
          return { ok: false, motivo: 'block missing winner_proof for challenge with submissions' };
        }
      }

      // Cross-check reward distribution against actual challenge submissions
      const rewardsData = bloco.rewards || [];
      if (rewardsData.length > 0 && bloco.challenge_id) {
        const subs = this.db.prepare('SELECT miner, plot_id, deadline FROM challenge_submissions WHERE challenge_id = ?').all(bloco.challenge_id);
        const subKeys = new Set(subs.map(s => `${normalizeAddr(s.miner)}:${s.plot_id || ''}:${s.deadline}`));
        for (const r of rewardsData) {
          if (typeof r !== 'object' || !r.miner) continue;
          const key = `${normalizeAddr(r.miner)}:${r.plot_id || ''}:${r.deadline}`;
          if (!subKeys.has(key)) {
            log('warn', `reward entry for ${r.miner} has no matching submission in challenge ${bloco.challenge_id.slice(0, 12)}`);
            // Reject blocks that reward miners who never submitted proofs
            return { ok: false, motivo: `reward for ${r.miner} has no matching proof submission` };
          }
        }
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const rewardsData = bloco.rewards || [];
    const reward = calculateMiningReward(height, this.cfg);
    const rewardStr = String(reward);
    const totalTxFees = txs.reduce((s, t) => s + safeBigInt(t.fee, 0n), 0n);
    const gasUsed = txs.reduce((s, t) => s + estimateIntrinsicGas(t), 0);
    const parentWork = height > 0 ? (() => { const p = this.db.prepare('SELECT chain_work FROM blocks WHERE hash = ?').get(bloco.parent_hash); return p ? safeBigInt(p.chain_work, 0n) : 0n; })() : 0n;
    const newWork = parentWork + this._blockWork(bloco);
    bloco.chain_work = String(newWork);
    if (!bloco.hash) bloco.hash = hashBlock(bloco);
    const existingAtHeight = this.db.prepare('SELECT hash, chain_work FROM blocks WHERE height = ?').get(height);
    if (existingAtHeight && existingAtHeight.hash !== bloco.hash) {
      if (forceSync) {
        log('debug', `addBlock forceSync h=${height} local=${existingAtHeight.hash.slice(0, 10)} remote=${bloco.hash.slice(0, 10)}`);
        const reorgResult = await this.reorganize(bloco, true);
        if (!reorgResult.ok) return { ok: false, motivo: `sync reorg failed: ${reorgResult.motivo}` };
        return { ok: true, motivo: 'sync reorg accepted', height: this.altura, hash: this.melhorHash };
      }
      const existingBlock = this.getBlockByHash(existingAtHeight.hash);
      if (isBetterChainCandidate(bloco, existingBlock)) {
        log('debug', `addBlock better candidate h=${height} local=${existingBlock.hash.slice(0, 10)} remote=${bloco.hash.slice(0, 10)}`);
        const reorgResult = await this.reorganize(bloco);
        if (!reorgResult.ok) return { ok: false, motivo: `reorg failed: ${reorgResult.motivo}` };
        return { ok: true, motivo: 'reorganized to better tip', height: this.altura, hash: this.melhorHash };
      } else {
        return { ok: false, motivo: 'competing block not better than incumbent' };
      }
    }

    // Pré-execução determinística de txs de contrato (create/call) fora da transação SQLite
    // (o VM é async). O estado de contratos resultante vai para as tabelas e é capturado no
    // contract_state_root / state_root. Em caso de rejeição do bloco, _restoreContractState
    // devolve as tabelas ao estado pré-bloqueio.
    let contractExec = null;
    const contractTxs = txs.filter(t => this._isContractOp(t));
    if (contractTxs.length) {
      if (!this.contracts) return { ok: false, motivo: 'block contains contract txs but smart contracts are disabled' };
      contractExec = await this._preExecuteContracts(bloco, txs);
      if (!contractExec.ok) {
        contractExec.rollback();
        return { ok: false, motivo: contractExec.motivo };
      }
    }

    try {
      this.db.transaction(() => {
        for (const d of rewardsData) {
          if (typeof d !== 'object' || !d.miner) continue;
          const rewardCc = safeBigInt(d.reward_cc, 0n);
          if (rewardCc > 0n) {
            const cur = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(d.miner);
            const curBalance = safeBigInt(cur ? cur.balance : 0n, 0n);
            const newBalance = curBalance + rewardCc;
            if (cur) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(newBalance), now, d.miner);
            else this.db.prepare('INSERT OR IGNORE INTO users (address, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?)').run(d.miner, String(rewardCc), 0, now, now);
          }
          this.db.prepare('INSERT OR IGNORE INTO block_rewards (block_height, block_hash, challenge_id, miner, plot_id, size_gb, share_pct, reward_cc, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(height, bloco.hash, bloco.challenge_id || '', d.miner, d.plot_id || '', d.size_gb || 0, d.share_pct || 0, String(rewardCc), now);
        }
        // Empty distribution fallback REMOVED: blocks without a verified reward distribution
        // no longer grant the entire reward to block.miner. This prevents forgers from
        // stealing rewards by omitting the distribution array.
        for (const tx of txs) {
          const txHash = tx.hash || hashTransaction(tx);
          // INSERT OR REPLACE (não IGNORE): se a mesma tx foi incluída antes num bloco
          // orfão/descartado, atualiza block_hash/block_height para o bloco canônico atual.
          // Sem isso, _attachTransactions (match por block_hash) não acha a tx no bloco
          // canônico, e peers que syncam o bloco nunca veem txs de contrato.
          this.db.prepare('INSERT OR REPLACE INTO transactions (hash, from_addr, to_addr, value, fee, nonce, gas_limit, gas_price, signature, block_height, timestamp, block_hash, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(txHash, tx.from_addr, tx.to_addr || '', String(tx.value || 0), String(tx.fee || 0), safeInt(tx.nonce, 0), safeInt(tx.gas_limit, 21000), String(tx.gas_price || '1'), tx.signature || '', height, tx.timestamp || now, bloco.hash, String(tx.data || ''));
          if (tx.from_addr) {
            const cur = this.db.prepare('SELECT balance, nonce FROM users WHERE address = ?').get(tx.from_addr);
            if (cur) {
              const curBalance = safeBigInt(cur.balance, 0n);
              const newBalance = curBalance - safeBigInt(tx.value, 0n) - safeBigInt(tx.fee, 0n);
              this.db.prepare('UPDATE users SET balance = ?, nonce = ?, updated_at = ? WHERE address = ?').run(String(newBalance), Math.max(safeInt(cur.nonce, 0) + 1, safeInt(tx.nonce, 0) + 1), now, tx.from_addr);
            }
          }
          const isContractRecipient = this._isContractCall(tx);
          if (tx.to_addr && !isContractRecipient) {
            const cur = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(tx.to_addr);
            const curBalance = safeBigInt(cur ? cur.balance : 0n, 0n);
            const newBalance = curBalance + safeBigInt(tx.value, 0n);
            if (cur) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(newBalance), now, tx.to_addr);
            else this.db.prepare('INSERT OR IGNORE INTO users (address, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?)').run(tx.to_addr, String(safeBigInt(tx.value, 0n)), 0, now, now);
          }
          this.db.prepare('DELETE FROM mempool WHERE hash = ?').run(txHash);
        }
        // state_root/contract_state_root são calculados APÓS a aplicação de recompensas e
        // txs (usuários), para que o root reflita o estado pós-bloco — o mesmo valor que
        // nós remotos validarão ao receber o bloco.
        if (isLocalForge) {
          bloco.contract_state_root = computeContractStateRoot(this.db);
          bloco.state_root = computeStateRoot(this.db);
          bloco.hash = hashBlock(bloco);
          if (this.cfg.minerPrivateKey) {
            try { bloco.signature = signMessage(blockMessage(bloco), this.cfg.minerPrivateKey); } catch {}
          }
        }
        this.db.prepare(`INSERT INTO blocks (height, hash, parent_hash, timestamp, miner, challenge_id, tx_root, nonce, difficulty, target,
          reward_units, reward_cc, tx_count, chain_work, signature, generation_signature, proof_digest, plot_id, state_root, origin,
          total_fees_units, gas_used, gas_limit, base_target, base_fee, contract_state_root) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          height, bloco.hash, bloco.parent_hash, bloco.timestamp, bloco.miner || '',
          bloco.challenge_id || '', bloco.tx_root || '', String(bloco.nonce || '0'),
          bloco.difficulty || '0', String(bloco.target || '0'), bloco.reward_units || '0',
          rewardStr, txs.length, String(newWork), bloco.signature || '',
          bloco.generation_signature || ZERO_HASH, bloco.proof_digest || '',
          bloco.plot_id || '', bloco.state_root || '', blockOrigin,
          String(totalTxFees), gasUsed, bloco.gas_limit || 30000000, bloco.base_target || String(BigInt(2) ** BigInt(64) / BigInt(5898240)),
          bloco.base_fee || String(this._baseFeeForHeight(height)),
          bloco.contract_state_root || ''
        );
        if (!skipStateValidation) {
          const actualStateRoot = computeStateRoot(this.db);
          const claimedStateRoot = bloco.state_root || '';
          if (claimedStateRoot && claimedStateRoot !== actualStateRoot) {
            log('warn', `state_root mismatch at #${height}`);
            throw new Error('state_root mismatch');
          }
        }
        if (!isLocalForge && !skipContractStateValidation && this.contracts && bloco.contract_state_root) {
          const actualCsr = computeContractStateRoot(this.db);
          if (actualCsr !== bloco.contract_state_root) {
            log('warn', `contract_state_root mismatch at #${height}: local=${actualCsr.slice(0, 16)} claimed=${bloco.contract_state_root.slice(0, 16)}`);
            throw new Error('contract_state_root mismatch');
          }
        }
        this._selectTip();
      })();
      if (height > 0) log('info', `Block #${height} accepted [${bloco.hash.slice(0, 10)}] from ${blockOrigin} (miner: ${(bloco.miner || '').slice(0, 10)}…)`);
      return { ok: true, motivo: 'block added', height, hash: bloco.hash };
    } catch (e) {
      if (contractExec) { try { contractExec.rollback(); } catch {} }
      return { ok: false, motivo: e.message || 'database error' };
    }
  }

  _isCreateTx(tx) { return !!(tx && !tx.to_addr && tx.data); }

  _isContractCall(tx) {
    if (!tx || !tx.to_addr || !tx.data) return false;
    if (!this.contracts) return false;
    return !!this.db.prepare('SELECT 1 FROM smart_contracts WHERE lower(address) = lower(?)').get(tx.to_addr);
  }

  _isContractOp(tx) { return this._isCreateTx(tx) || this._isContractCall(tx); }

  _blockContext(bloco) {
    try {
      const b = new Block();
      const ts = new BN(safeInt(bloco.timestamp, 0)).toString(16, 16).padStart(16, '0');
      b.header.timestamp = Buffer.from(ts, 'hex');
      const num = new BN(safeInt(bloco.height, 0)).toString(16, 16).padStart(16, '0');
      b.header.number = Buffer.from(num, 'hex');
      return b;
    } catch (e) { return undefined; }
  }

  _snapshotContractState(address) {
    return {
      address,
      storage: this.db.prepare('SELECT * FROM smart_contract_storage WHERE lower(contract_address) = lower(?)').all(address),
      account: this.db.prepare('SELECT * FROM smart_contract_accounts WHERE lower(address) = lower(?)').get(address) || null,
      contract: this.db.prepare('SELECT * FROM smart_contracts WHERE lower(address) = lower(?)').get(address) || null,
    };
  }

  _restoreContractState(snaps) {
    for (const s of snaps) {
      this.db.prepare('DELETE FROM smart_contract_storage WHERE lower(contract_address) = lower(?)').run(s.address);
      this.db.prepare('DELETE FROM smart_contract_accounts WHERE lower(address) = lower(?)').run(s.address);
      this.db.prepare('DELETE FROM smart_contracts WHERE lower(address) = lower(?)').run(s.address);
      for (const row of s.storage) this.db.prepare('INSERT OR REPLACE INTO smart_contract_storage (contract_address, slot, value) VALUES (?,?,?)').run(row.contract_address, row.slot, row.value);
      if (s.account) this.db.prepare('INSERT OR REPLACE INTO smart_contract_accounts (address, balance) VALUES (?,?)').run(s.account.address, s.account.balance);
      if (s.contract) this.db.prepare('INSERT OR REPLACE INTO smart_contracts (address, creator, code, created_at, updated_at) VALUES (?,?,?,?,?)').run(s.contract.address, s.contract.creator, s.contract.code, s.contract.created_at, s.contract.updated_at);
    }
    // a trie do VM é cacheada por processo; após rollback as linhas no DB foram restauradas,
    // mas o estado em memória pode reter slots stale — descarta o cache para a próxima execução
    // recarregar do DB de forma determinística.
    if (this.contracts && this.contracts.clearVmCache) this.contracts.clearVmCache();
  }

  // Executa txs de contrato (create/call) na ordem do bloco, com contexto de bloco
  // (timestamp/height) para determinismo. Txs que revertem são marcadas como falhas —
  // o remetente ainda paga a fee e o nonce avança, mas o valor não é transferido.
  async _preExecuteContracts(bloco, txs) {
    const backup = [];
    const blkCtx = this._blockContext(bloco);
    try {
      for (const tx of txs) {
        const txHash = tx.hash || hashTransaction(tx);
        if (this.db.prepare('SELECT 1 FROM transactions WHERE hash = ?').get(txHash)) {
          tx._ccApplied = true;
          continue;
        }
        if (this._isCreateTx(tx)) {
          const nonce = safeInt(tx.nonce, 0);
          const address = this.contracts.deriveContractAddress(tx.from_addr, nonce);
          backup.push(this._snapshotContractState(address));
          try {
            await this.contracts.CreateSmartContract(
              tx.data,
              blkCtx,
              tx.from_addr,
              nonce,
              safeBigInt(tx.value, 0n).toString(),
              tx.gas_limit,
              tx.gas_price
            );
            tx._ccApplied = true;
          } catch (e) {
            tx._ccError = e.message || String(e);
            tx._ccApplied = false;
          }
        } else if (this._isContractCall(tx)) {
          const to = tx.to_addr;
          backup.push(this._snapshotContractState(to));
          try {
            await this.contracts.runSmartContract(to, tx.from_addr, tx.data || '0x', safeBigInt(tx.value, 0n).toString(), tx.gas_limit, tx.gas_price, blkCtx);
            if (safeBigInt(tx.value, 0n) > 0n) {
              await this.contracts.creditContractBalance(to, safeBigInt(tx.value, 0n).toString());
            }
            tx._ccApplied = true;
          } catch (e) {
            tx._ccError = e.message || String(e);
            tx._ccApplied = false;
          }
        }
      }
      return { ok: true, rollback: () => this._restoreContractState(backup) };
    } catch (e) {
      this._restoreContractState(backup);
      return { ok: false, motivo: e.message || 'contract execution error', rollback: () => {} };
    }
  }


  _validateTxOrder(txs) {
    const projectedNonce = {}, projectedBalance = {};
    for (const tx of txs) {
      const sender = tx.from_addr;
      if (!sender) return [false, 'invalid tx sender'];
      if (!projectedNonce[sender]) {
        const user = this.db.prepare('SELECT nonce, balance FROM users WHERE address = ?').get(sender);
        projectedNonce[sender] = user ? safeInt(user.nonce, 0) : 0;
        projectedBalance[sender] = user ? safeBigInt(user.balance, 0n) : 0n;
      }
      if (safeInt(tx.nonce, -1) < 0 || safeInt(tx.value, -1) < 0) return [false, `invalid tx values for ${sender}`];
      if (safeInt(tx.nonce, 0) !== projectedNonce[sender]) return [false, 'transactions not ordered by nonce'];
      if (projectedBalance[sender] < safeBigInt(tx.value, 0n) + safeBigInt(tx.fee, 0n)) return [false, `insufficient balance for ${sender}`];
      const sig = tx.signature || '';
      if (!sig) return [false, `missing signature from ${sender}`];
      const pubkey = this.db.prepare('SELECT public_key_ed25519 FROM users WHERE address = ?').get(sender);
      if (!pubkey || !pubkey.public_key_ed25519) return [false, `sender ${sender} has no public key`];
      if (!verifySignature(canonicalTxMessage(tx), sig, pubkey.public_key_ed25519)) return [false, `invalid tx signature from ${sender}`];
      projectedBalance[sender] -= safeBigInt(tx.value, 0n) + safeBigInt(tx.fee, 0n);
      projectedNonce[sender]++;
    }
    return [true, ''];
  }

  _txRootMatches(bloco) {
    const txs = bloco.transactions || [];
    if (!txs.length) return !bloco.tx_root || bloco.tx_root === ZERO_HASH;
    const txHashes = txs.map(t => t.hash || hashTransaction(t));
    return bloco.tx_root === merkleRoot(txHashes);
  }

  validateTxForMempool(tx) {
  if (tx.from_addr) tx.from_addr = normalizeAddr(tx.from_addr);
  if (tx.to_addr) tx.to_addr = normalizeAddr(tx.to_addr);
  const sender = tx.from_addr;
  if (!sender) return { ok: false, motivo: 'missing from_addr' };
  if (!tx.to_addr && !tx.data) return { ok: false, motivo: 'missing to_addr (or data for contract creation)' };
  if (tx.to_addr && !/^0x[0-9a-fA-F]{42}$/.test(tx.to_addr)) return { ok: false, motivo: 'invalid to_addr' };
  if (tx.data && !/^0x[0-9a-fA-F]*$/.test(tx.data)) return { ok: false, motivo: 'invalid data' };
  if (safeInt(tx.nonce, -1) < 0 || safeInt(tx.value, -1) < 0) return { ok: false, motivo: 'invalid nonce/value' };
  const sig = tx.signature || '';
  if (!sig) return { ok: false, motivo: `missing signature from ${sender}` };
  const pubkey = this.db.prepare('SELECT public_key_ed25519 FROM users WHERE lower(address) = lower(?)').get(sender);
  if (!pubkey || !pubkey.public_key_ed25519) return { ok: false, motivo: `sender ${sender} has no public key registered` };
  if (!verifySignature(canonicalTxMessage(tx), sig, pubkey.public_key_ed25519)) return { ok: false, motivo: `invalid tx signature from ${sender}` };
  const user = this.db.prepare('SELECT balance, nonce FROM users WHERE lower(address) = lower(?)').get(sender);
  const curNonce = user ? safeInt(user.nonce, 0) : 0;
  const curBalance = user ? safeBigInt(user.balance, 0n) : 0n;
  if (safeInt(tx.nonce, 0) < curNonce) return { ok: false, motivo: `stale nonce (tx=${tx.nonce}, account=${curNonce})` };
  if (curBalance < safeBigInt(tx.value, 0n) + safeBigInt(tx.fee, 0n)) return { ok: false, motivo: `insufficient balance for ${sender}` };
  if (!tx.to_addr && this.contracts) {
    const address = this.contracts.deriveContractAddress(sender, safeInt(tx.nonce, 0));
    if (this.db.prepare('SELECT 1 FROM smart_contracts WHERE lower(address) = lower(?)').get(address)) {
      return { ok: false, motivo: `contract already exists at ${address}` };
    }
  }

  // gas
  const requiredGas = estimateIntrinsicGas(tx);
  if (safeInt(tx.gas_limit, 0) < requiredGas) return { ok: false, motivo: `gas_limit too low (need ${requiredGas})` };
  const currentBaseFee = BigInt(this._baseFeeForHeight(this.altura + 1));
  if (safeBigInt(tx.gas_price, 0n) < currentBaseFee) return { ok: false, motivo: `gas_price below base fee (${currentBaseFee})` };

  return { ok: true, motivo: 'valid' };
}

  addMempoolTx(tx) {
    const txHash = tx.hash || hashTransaction(tx);
    const existing = this.db.prepare('SELECT 1 FROM mempool WHERE hash = ?').get(txHash);
    if (existing) return { ok: true, motivo: 'Tx already in mempool' };
    const inBlock = this.db.prepare('SELECT 1 FROM transactions WHERE hash = ?').get(txHash);
    if (inBlock) return { ok: false, motivo: 'Tx already in chain' };
    const maxMempool = this.cfg.maxMempoolSize || 5000;
    const count = this.db.prepare('SELECT COUNT(*) as c FROM mempool').get().c;
    if (count >= maxMempool) return { ok: false, motivo: 'mempool full' };
    const ttl = this.cfg.mempoolTxTtlSec || 3600;
    this.db.prepare('DELETE FROM mempool WHERE timestamp < ?').run(Math.floor(Date.now() / 1000) - ttl);
    try {
      const raw = JSON.stringify(tx);
      this.db.prepare('INSERT INTO mempool (hash, raw, timestamp, fee) VALUES (?, ?, ?, ?)').run(txHash, raw, Math.floor(Date.now() / 1000), String(tx.fee || 0));
      return { ok: true, motivo: 'added', hash: txHash };
    } catch (e) { return { ok: false, motivo: e.message || 'insert error' }; }
  }

  getMempoolForBlock(maxCount = 100) {
    const raw = this.db.prepare('SELECT * FROM mempool ORDER BY CAST(fee AS INTEGER) DESC, timestamp ASC LIMIT ?').all(maxCount);
    if (raw.length) log('info', `[TX] getMempoolForBlock: ${raw.length} raw entries in mempool`);
    return raw.map(r => { try { return JSON.parse(r.raw); } catch { return null; } }).filter(Boolean);
  }

  cleanMempool() {
    const ttl = this.cfg.mempoolTxTtlSec || 3600;
    this.db.prepare('DELETE FROM mempool WHERE timestamp < ?').run(Math.floor(Date.now() / 1000) - ttl);
  }

  computeMaxDeadline() {
    const row = this.db.prepare('SELECT COALESCE(SUM(size_gb), 0) as total FROM plot_commitments').get();
    const capacity = parseFloat(row ? row.total : 0) || 0;
    const expected = this.cfg.expectedTimePerBlock || 240;
    if (capacity <= 0) return 21600;
    return Math.max(600, Math.min(86400, Math.floor(expected * 36000 / Math.max(capacity, 1))));
  }

  async reorganize(targetOrHash, forceSync) {
    const target = typeof targetOrHash === 'string' ? this.getBlockByHash(targetOrHash) : targetOrHash;
    if (!target) return { ok: false, motivo: 'target block not found' };
    if (target.height >= this.altura && this.getBlock(target.height) && this.getBlock(target.height).hash === target.hash) {
      return { ok: true, motivo: 'already at tip', height: this.altura, hash: this.melhorHash };
    }
    const depth = this.altura - target.height;
    if (!forceSync && depth > FINALIZATION_DEPTH) return { ok: false, motivo: `reorg exceeds finalization depth (${depth} > ${FINALIZATION_DEPTH})` };
    const forkPoint = this.getBlockByHash(target.parent_hash);
    if (!forkPoint) return { ok: false, motivo: 'fork point not found' };
    const oldTip = this.getBlock(this.altura);
    if (!oldTip) return { ok: false, motivo: 'old tip not found' };
    const hashes = [];
    let current = target;
    while (current && current.height > forkPoint.height) {
      hashes.push(current.hash);
      current = this.getBlock(current.parent_hash);
    }
    hashes.reverse();
    let oldWalker = oldTip;
    while (oldWalker && oldWalker.height > forkPoint.height) {
      if (oldWalker.height <= target.height && oldWalker.miner && oldWalker.miner !== 'genesis') {
        const reward = BigInt(oldWalker.reward_cc || '0');
        if (reward > 0n) {
          const cur = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(oldWalker.miner);
          if (cur) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(BigInt(cur.balance || 0) - reward), Math.floor(Date.now() / 1000), oldWalker.miner);
        }
      }
      oldWalker = this.getBlock(oldWalker.parent_hash);
    }
    for (const h of hashes) {
      let blk = this.getBlockByHash(h);
      if (!blk) {
        if (h === target.hash) blk = target;
        else return { ok: false, motivo: `block ${h} not in DB` };
      }
      const res = await this._insertBlockDirect(blk);
      if (!res.ok) return { ok: false, motivo: res.motivo };
    }
    this._selectTip();
    this._purgeOrphanedDescendants(forkPoint.height, target.height);
    this._recomputeBalances();
    // _purgeOrphanedBlocks was previously defined but never invoked anywhere, so stale
    // side-chain blocks left behind by reorgs accumulated in the DB indefinitely. Run it
    // here as a final sweep now that the new tip is selected and balances are correct.
    this._purgeOrphanedBlocks();
    log('info', `Reorg to #${this.altura} ${this.melhorHash.slice(0, 10)} (depth ${depth})`);
    return { ok: true, motivo: 'reorganized', height: this.altura, hash: this.melhorHash };
  }

  _rollbackRewardsForBlocks(miner, reward_cc) {
    if (miner && miner !== 'genesis') {
      const reward = BigInt(reward_cc || '0');
      if (reward > 0n) {
        const cur = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(miner);
        if (cur) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(BigInt(cur.balance || 0) - reward), Math.floor(Date.now() / 1000), miner);
      }
    }
  }

  _purgeOrphanedDescendants(fromHeight, skipRollbackUpTo = -1) {
    const maxH = this.db.prepare('SELECT MAX(height) as m FROM blocks').get().m || 0;
    if (maxH <= fromHeight) return;
    const doRollback = (doomed) => {
      for (const d of doomed) {
        if (d.height > skipRollbackUpTo) this._rollbackRewardsForBlocks(d.miner, d.reward_cc);
      }
    };
    for (let h = fromHeight + 1; h <= maxH; h++) {
      const bestParent = this.db.prepare('SELECT hash FROM blocks WHERE height = ? ORDER BY LENGTH(chain_work) DESC, chain_work DESC, hash ASC LIMIT 1').get(h - 1);
      if (!bestParent) {
        const doomed = this.db.prepare('SELECT height, miner, reward_cc FROM blocks WHERE height >= ?').all(h);
        doRollback(doomed);
        this.db.prepare('DELETE FROM blocks WHERE height >= ?').run(h);
        break;
      }
      const doomed = this.db.prepare('SELECT height, miner, reward_cc FROM blocks WHERE height = ? AND parent_hash != ?').all(h, bestParent.hash);
      doRollback(doomed);
      this.db.prepare('DELETE FROM blocks WHERE height = ? AND parent_hash != ?').run(h, bestParent.hash);
      const remaining = this.db.prepare('SELECT 1 FROM blocks WHERE height = ? LIMIT 1').get(h);
      if (!remaining) {
        const doomed2 = this.db.prepare('SELECT height, miner, reward_cc FROM blocks WHERE height > ?').all(h);
        doRollback(doomed2);
        this.db.prepare('DELETE FROM blocks WHERE height > ?').run(h);
        break;
      }
    }
    this._selectTip();
  }

  _recomputeBalances() {
    const hashes = [];
    let h = this.db.prepare('SELECT hash, parent_hash, height, reward_cc, miner FROM blocks WHERE hash = ?').get(this.melhorHash);
    while (h) {
      hashes.push(h);
      if (h.height === 0) break;
      h = this.db.prepare('SELECT hash, parent_hash, height, reward_cc, miner FROM blocks WHERE hash = ?').get(h.parent_hash);
    }
    const bal = {};
    const nonces = {};
    for (const b of hashes) {
      if (b.miner && b.miner !== 'genesis') {
        const reward = BigInt(b.reward_cc || '0');
        if (reward > 0n) bal[b.miner] = (bal[b.miner] || 0n) + reward;
      }
      const txs = this.db.prepare('SELECT from_addr, to_addr, value, fee, nonce FROM transactions WHERE block_hash = ?').all(b.hash);
      for (const tx of txs) {
        if (tx.from_addr) {
          bal[tx.from_addr] = (bal[tx.from_addr] || 0n) - BigInt(tx.value || 0) - BigInt(tx.fee || 0);
          nonces[tx.from_addr] = Math.max(nonces[tx.from_addr] || 0, safeInt(tx.nonce, 0) + 1);
        }
        if (tx.to_addr && !this.db.prepare('SELECT 1 FROM smart_contracts WHERE lower(address) = lower(?)').get(tx.to_addr)) {
          bal[tx.to_addr] = (bal[tx.to_addr] || 0n) + BigInt(tx.value || 0);
        }
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const all = this.db.prepare('SELECT address, balance FROM users').all();
    for (const u of all) {
      const expected = bal[u.address];
      if (expected !== undefined) {
        if (String(expected) !== u.balance) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(expected), now, u.address);
      }
    }
    for (const [addr, expected] of Object.entries(bal)) {
      if (!this.db.prepare('SELECT 1 FROM users WHERE address = ?').get(addr)) {
        this.db.prepare('INSERT OR IGNORE INTO users (address, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?)').run(addr, String(expected), nonces[addr] || 0, now, now);
      } else if (nonces[addr] !== undefined) {
        const cur = this.db.prepare('SELECT nonce FROM users WHERE address = ?').get(addr);
        if (cur && safeInt(cur.nonce, 0) < nonces[addr]) this.db.prepare('UPDATE users SET nonce = ?, updated_at = ? WHERE address = ?').run(nonces[addr], now, addr);
      }
    }
  }

  async _insertBlockDirect(blk) {
    const parentWork = blk.height > 0 ? (() => { const p = this.db.prepare('SELECT chain_work FROM blocks WHERE hash = ?').get(blk.parent_hash); return p ? safeBigInt(p.chain_work, 0n) : 0n; })() : 0n;
    const work = blk.chain_work || String(parentWork + this._blockWork(blk));
    const now = Math.floor(Date.now() / 1000);
    const txs = blk.transactions || [];
    const contractTxs = txs.filter(t => this._isContractOp(t));
    let contractExec = null;
    if (contractTxs.length) {
      if (!this.contracts) return { ok: false, motivo: 'contract txs but smart contracts disabled' };
      contractExec = await this._preExecuteContracts(blk, txs);
      if (!contractExec.ok) {
        contractExec.rollback();
        return { ok: false, motivo: contractExec.motivo };
      }
    }
    try {
      this.db.transaction(() => {
        this.db.prepare(`INSERT OR REPLACE INTO blocks (height, hash, parent_hash, timestamp, miner, challenge_id, tx_root, nonce, difficulty, target,
          reward_units, reward_cc, tx_count, chain_work, signature, generation_signature, proof_digest, plot_id, state_root, origin,
          total_fees_units, gas_used, gas_limit, base_target, contract_state_root) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          blk.height, blk.hash, blk.parent_hash || '', blk.timestamp || now, blk.miner || '',
          blk.challenge_id || '', blk.tx_root || '', String(blk.nonce || '0'), blk.difficulty || '0',
          String(blk.target || '0'), blk.reward_units || '0', blk.reward_cc || '0', blk.tx_count || 0,
          String(work), blk.signature || '', blk.generation_signature || ZERO_HASH,
          blk.proof_digest || '', blk.plot_id || '', blk.state_root || '', blk.origin || 'reorg',
          blk.total_fees_units || '0', blk.gas_used || 0, blk.gas_limit || 30000000, blk.base_target || String(BigInt(2) ** BigInt(64) / BigInt(5898240)),
          blk.contract_state_root || ''
        );
        for (const tx of txs) {
          const txHash = tx.hash || hashTransaction(tx);
          // INSERT OR REPLACE (não IGNORE): corrige block_hash/block_height quando a tx
          // já existe apontando para um bloco orfão descartado, para que peers que syncam
          // o bloco canônico recebam as txs (inclusive txs de contrato).
          this.db.prepare('INSERT OR REPLACE INTO transactions (hash, from_addr, to_addr, value, fee, nonce, gas_limit, gas_price, signature, block_height, timestamp, block_hash, data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(txHash, tx.from_addr, tx.to_addr || '', String(tx.value || 0), String(tx.fee || 0), safeInt(tx.nonce, 0), safeInt(tx.gas_limit, 21000), String(tx.gas_price || '1'), tx.signature || '', blk.height, tx.timestamp || now, blk.hash, String(tx.data || ''));
        }
        if (blk.miner && blk.miner !== 'genesis' && blk.height > 0) {
          const reward = BigInt(blk.reward_cc || '0');
          if (reward > 0n) {
            const cur = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(blk.miner);
            if (cur) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(BigInt(cur.balance || 0) + reward), now, blk.miner);
            else this.db.prepare('INSERT OR IGNORE INTO users (address, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?)').run(blk.miner, String(reward), 0, now, now);
          }
        }
      })();
      return { ok: true };
    } catch (e) {
      if (contractExec) { try { contractExec.rollback(); } catch {} }
      return { ok: false, motivo: e.message || 'database error' };
    }
  }

  _selectTip() {
    const row = this.db.prepare('SELECT height, hash FROM blocks ORDER BY LENGTH(chain_work) DESC, chain_work DESC, hash ASC LIMIT 1').get();
    if (row) { this.altura = row.height; this.melhorHash = row.hash; }
  }

  _purgeOrphanedBlocks() {
    const activeChain = new Set();
    let cur = this.db.prepare('SELECT hash, parent_hash, height FROM blocks WHERE hash = ?').get(this.melhorHash);
    while (cur) {
      activeChain.add(`${cur.height}:${cur.hash}`);
      if (cur.height === 0) break;
      cur = this.db.prepare('SELECT hash, parent_hash, height FROM blocks WHERE hash = ?').get(cur.parent_hash);
    }
    const maxH = this.db.prepare('SELECT MAX(height) as m FROM blocks').get().m || 0;
    let purged = 0;
    for (let h = 0; h <= maxH; h++) {
      const rows = this.db.prepare('SELECT hash, miner, reward_cc FROM blocks WHERE height = ?').all(h);
      for (const r of rows) {
        if (!activeChain.has(`${h}:${r.hash}`)) {
          if (r.miner && r.miner !== 'genesis' && h > 0) {
            const reward = BigInt(r.reward_cc || '0');
            if (reward > 0n) {
              const curBal = this.db.prepare('SELECT balance FROM users WHERE address = ?').get(r.miner);
              if (curBal) this.db.prepare('UPDATE users SET balance = ?, updated_at = ? WHERE address = ?').run(String(BigInt(curBal.balance || 0) - reward), Math.floor(Date.now() / 1000), r.miner);
            }
          }
          this.db.prepare('DELETE FROM blocks WHERE hash = ?').run(r.hash);
          purged++;
        }
      }
    }
    if (purged > 0) {
      log('info', `Purged ${purged} orphaned blocks, chain now height=${this.altura} tip=${this.melhorHash.slice(0, 10)}`);
    }
    return purged;
  }

  prune() {
    if (!this.cfg.pruningEnabled) return;
    const keep = this.cfg.pruneKeepBlocks || 1000;
    const keepDays = this.cfg.pruneKeepDays || 30;
    const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
    this.db.prepare("DELETE FROM blocks WHERE height < (SELECT MAX(height) - ? FROM blocks) AND timestamp < ?").run(keep, cutoff);
    this.db.prepare("DELETE FROM transactions WHERE block_height < (SELECT MAX(height) - ? FROM blocks)").run(keep);
    this.db.prepare("VACUUM");
  }


}

module.exports = { Chain, FINALIZATION_DEPTH };
