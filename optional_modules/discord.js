const https = require('https');
const http = require('http');
const { URL } = require('url');
const { log } = require('./config');

function notifyNewBlock(block, cfg) {
  const webhookUrl = cfg.discordWebhook || 'https://discord.com/api/webhooks/1527117380994465914/Jnx5a3vXZT6Mff1hzKFwU5dG5EvjNl7d5SRKsH2sfsxW71dkfTPWnDvFEnxgW2dnRW61';
  if (!webhookUrl || !block) return;

  const nodeName = cfg.nodeName || cfg.nodeUrl || 'Node';
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
    color: 0x00b300,
    fields: [
      { name: 'Hash', value: `\`${hash}\``, inline: true },
      { name: 'Miner', value: `\`${miner}\``, inline: true },
      { name: 'Reward', value: `${rewardCc} CC`, inline: true },
      { name: 'Txs', value: String(txCount), inline: true },
      { name: 'Node', value: nodeName, inline: true },
    ],
    timestamp: new Date(block.timestamp * 1000).toISOString(),
  };

  const payload = JSON.stringify({ embeds: [embed] });

  try {
    const url = new URL(webhookUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    });
    req.on('error', (e) => log('warn', `Discord webhook error: ${e.message}`));
    req.write(payload);
    req.end();
  } catch (e) {
    log('warn', `Discord webhook failed: ${e.message}`);
  }
}

module.exports = { notifyNewBlock };
