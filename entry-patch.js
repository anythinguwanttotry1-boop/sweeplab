const fs = require('fs');

// One-time reset requested after the MT5 live-entry fix.
try {
  const runtimeFile = '/data/sweeplab-runtime.json';
  if (fs.existsSync(runtimeFile)) {
    const rt = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (!rt.tradeResetLiveEntryV1) {
      rt.trades = [];
      rt.lastNotified = {};
      rt.tradeResetLiveEntryV1 = true;

      if (rt.state && typeof rt.state === 'object') {
        rt.state.tradeStats = {
          sent: 0,
          wins: 0,
          losses: 0,
          open: 0,
          ambiguous: 0,
          winRate: null,
          riskUsd: 140,
          rewardUsd: 420,
          grossProfitUsd: 0,
          grossLossUsd: 0,
          netUsd: 0,
          netR: 0
        };
        rt.state.tradeHistory = [];
        rt.state.openTradePairs = [];
        if (rt.state.pairs && typeof rt.state.pairs === 'object') {
          for (const p of Object.values(rt.state.pairs)) {
            if (!p || typeof p !== 'object') continue;
            delete p.entry;
            delete p.sl;
            delete p.tp;
            delete p.rr;
            delete p.signalSignature;
            delete p.signalExpiresAt;
            delete p.heldSignal;
          }
        }
      }

      fs.writeFileSync(runtimeFile, JSON.stringify(rt));
      console.log('SWEEPLAB_TRADE_HISTORY_RESET {"sent":0,"wins":0,"losses":0,"open":0,"netUsd":0}');
    }
  }
} catch (e) {
  console.error('SWEEPLAB_TRADE_HISTORY_RESET_ERROR ' + String(e.message || e));
}

const statsFile = 'stats-patch.js';
let stats = fs.readFileSync(statsFile, 'utf8');
if (!stats.includes("require('./open-trade-monitor-patch.js');")) {
  stats = stats.replace("require('./server.js');", "require('./open-trade-monitor-patch.js');");
  fs.writeFileSync(statsFile, stats);
}

require('./stability-patch.js');
