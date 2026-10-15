const fs = require('fs');

function replaceOnce(source, find, replacement, label) {
  if (!source.includes(find)) {
    console.error('SweepLab open-trade patch skipped marker: ' + label);
    return source;
  }
  return source.replace(find, replacement);
}

let server = fs.readFileSync('server.js', 'utf8');

if (!server.includes('SWEEPLAB_OPEN_TRADE_MONITOR')) {
  server = replaceOnce(
    server,
    "  const active = Object.keys(PAIRS).filter(p => pairActive(p));\n  state.activePairs = active;\n  state.paused = active.length === 0 || Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP;\n  if (Date.now() < (budget.lockUntil || 0)) state.pauseReason = 'تم إيقاف طلبات Twelve Data مؤقتاً لحماية رصيد الـ API.';\n  else if ((budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) state.pauseReason = 'وصل SweepLab للحد الآمن اليومي. سيعود تلقائياً بعد تجدد الرصيد.';\n  else if (!active.length) state.pauseReason = 'حالياً خارج أفضل أوقات التداول للأزواج الثلاثة.';\n  else state.pauseReason = null;",
    "  const active = Object.keys(PAIRS).filter(p => pairActive(p));\n  const openTradePairs = [...new Set(trades.filter(t => t.status === 'OPEN').map(t => t.pair))];\n  state.activePairs = active;\n  state.openTradePairs = openTradePairs;\n  state.paused = (active.length === 0 && openTradePairs.length === 0) || Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP;\n  if (Date.now() < (budget.lockUntil || 0)) state.pauseReason = 'تم إيقاف طلبات Twelve Data مؤقتاً لحماية رصيد الـ API.';\n  else if ((budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) state.pauseReason = 'وصل SweepLab للحد الآمن اليومي. سيعود تلقائياً بعد تجدد الرصيد.';\n  else if (!active.length && openTradePairs.length) state.pauseReason = 'لا توجد إشارات جديدة الآن، لكن SweepLab يراقب الصفقات المفتوحة حتى TP أو SL.';\n  else if (!active.length) state.pauseReason = 'حالياً خارج أفضل أوقات التداول للأزواج الثلاثة.';\n  else state.pauseReason = null; // SWEEPLAB_OPEN_TRADE_MONITOR",
    'refresh meta open trades'
  );

  server = replaceOnce(
    server,
    "    const data = await fetchPair(pair);\n    evaluateTrades(pair, data);\n    const result = analyze(pair, data);",
    "    const data = await fetchPair(pair);\n    evaluateTrades(pair, data);\n    if (!pairActive(pair)) {\n      const current = state.pairs?.[pair] || {};\n      const last = data[data.length - 1];\n      const openTrade = trades.slice().reverse().find(t => t.pair === pair && t.status === 'OPEN');\n      const latestTrade = trades.slice().reverse().find(t => t.pair === pair);\n      state.pairs[pair] = enrichPairMeta(pair, {\n        ...current,\n        pair,\n        decision: 'WAIT',\n        price: last?.c ?? current.price,\n        heldSignal: !!openTrade,\n        ...(openTrade ? { entry: openTrade.entry, sl: openTrade.sl, tp: openTrade.tp, rr: openTrade.rr || '1:3', bias: openTrade.direction, model: openTrade.model } : { entry: undefined, sl: undefined, tp: undefined }),\n        reason: openTrade ? 'Monitoring open trade until TP or SL' : (latestTrade && latestTrade.status === 'LOSS' ? 'Last tracked trade hit SL' : latestTrade && latestTrade.status === 'WIN' ? 'Last tracked trade hit TP' : 'Outside setup window')\n      });\n      lastFetchAt[pair] = Date.now();\n      state.lastScan = Date.now();\n      refreshMeta();\n      persist();\n      return;\n    }\n    const result = analyze(pair, data);",
    'monitor open trade outside setup window'
  );

  server = replaceOnce(
    server,
    "    if (!apiKey || state.paused && state.activePairs.length === 0) { persist(); return; }",
    "    const hasAnyOpenTrade = trades.some(t => t.status === 'OPEN');\n    if (!apiKey || (state.paused && state.activePairs.length === 0 && !hasAnyOpenTrade)) { persist(); return; }",
    'scheduler early return'
  );

  server = replaceOnce(
    server,
    "      if (!pairActive(pair)) continue;",
    "      const hasOpenTrade = trades.some(t => t.pair === pair && t.status === 'OPEN');\n      if (!pairActive(pair) && !hasOpenTrade) continue;",
    'scheduler open trade pair'
  );

  fs.writeFileSync('server.js', server);
}

require('./mt5-bridge-patch.js');
