const https = require('https');
const http = require('http');
const { URL } = require('url');

// Importação segura do log e da configuração
let log = () => {}; // fallback
try {
  const configModule = require('../src/config');
  if (configModule && typeof configModule.log === 'function') {
    log = configModule.log;
  }
} catch (_) {}

let config = {};
try {
  config = require('../config.env');
} catch (_) {
  // arquivo de configuração opcional
}

// Obtém o webhook de forma robusta
const webhookUrl = (config && config.discord_webhook_url) || process.env.discord_webhook_url || null;

// Função auxiliar para enviar requisições ao Discord
function sendDiscordEmbed(embed) {
  if (!webhookUrl) return;

  const payload = JSON.stringify({ embeds: [embed] });

  try {
    const url = new URL(webhookUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    req.on('error', (e) => log('warn', `Discord webhook error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    log('warn', `Discord webhook failed: ${e.message}`);
  }
}

// Função exportada para notificar novo bloco
function notifyNewBlock(block, cfg) {
  if (!webhookUrl || !block) return;

  const nodeName = cfg?.nodeName || cfg?.nodeUrl || 'Node';
  const rewardCc = block.reward_cc ? (Number(block.reward_cc) / 1e18).toFixed(2) : '0.00';
  const txCount = block.tx_count || 0;
  const height = block.height || 0;
  const hash = (block.hash || '').slice(0, 16);
  const miner = (block.miner || '').length > 20
    ? block.miner.slice(0, 8) + '...' + block.miner.slice(-6)
    : block.miner || 'unknown';
  const ts = new Date(block.timestamp * 1000).toLocaleString('en-US', {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const embed = {
    title: `Block #${height} Mined`,
    color: 0x09ff00,
    fields: [
      { name: 'Hash', value: `\`${hash}\``, inline: true },
      { name: 'Miner', value: `\`${miner}\``, inline: true },
      { name: 'Reward', value: `${rewardCc} CC`, inline: true },
      { name: 'Txs', value: String(txCount), inline: true },
      { name: 'Node', value: nodeName, inline: true },
    ],
    timestamp: new Date(block.timestamp * 1000).toISOString(),
  };

  sendDiscordEmbed(embed);
}

// Função exportada para notificar nova prova (AGORA FORA DO ESCOPO)
function notifyNewProof(miner, plotid, deadline, result) {
  if (!webhookUrl) return;

  const embed = {
    title: 'New Proof Submitted',
    color: 0x09ff00,
    fields: [
      { name: 'Miner', value: `\`${miner}\``, inline: true },
      { name: 'Plot ID', value: `\`${plotid}\``, inline: true },
      { name: 'Deadline', value: String(deadline), inline: true },
      { name: 'Result', value: result, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  sendDiscordEmbed(embed);
}

module.exports = { notifyNewBlock, notifyNewProof };