const fs = require('fs');

function replaceOnce(source, find, replacement, label) {
  if (!source.includes(find)) {
    console.error('SweepLab stats patch skipped marker: ' + label);
    return source;
  }
  return source.replace(find, replacement);
}

let server = fs.readFileSync('server.js', 'utf8');
if (!server.includes('SWEEPLAB_TRADE_STATS_PATCH')) {
  server = replaceOnce(
    server,
    "let lastTestPushAt = 0;",
    "let lastTestPushAt = 0;\nlet trades = Array.isArray(runtime.trades) ? runtime.trades : []; // SWEEPLAB_TRADE_STATS_PATCH",
    'runtime trades state'
  );

  server = replaceOnce(
    server,
    "JSON.stringify({ subscriptions, lastNotified, lastFetchAt, budget, state, fxCache })",
    "JSON.stringify({ subscriptions, lastNotified, lastFetchAt, budget, state, fxCache, trades })",
    'persist trades'
  );

  const broadcastBlock = `async function broadcastPush(payload) {
  const keep = [];
  for (const sub of subscriptions) if (await sendPushTo(sub, payload)) keep.push(sub);
  subscriptions = keep;
  persist();
}`;

  const tradeCode = `async function broadcastPush(payload) {
  const keep = [];
  for (const sub of subscriptions) if (await sendPushTo(sub, payload)) keep.push(sub);
  subscriptions = keep;
  persist();
}

function registerTrade(pair, result, signalCandle, signature) {
  if (!result || result.decision !== 'ENTER') return;
  if (![result.entry, result.sl, result.tp].every(Number.isFinite)) return;
  if (trades.some(t => t.signature === signature)) return;
  trades.push({
    id: Date.now().toString(36) + '-' + pair,
    signature,
    pair,
    direction: result.bias,
    model: result.model,
    entry: result.entry,
    sl: result.sl,
    tp: result.tp,
    rr: result.rr || '1:3',
    riskUsd: 140,
    openedAt: Date.now(),
    openedCandle: signalCandle,
    status: 'OPEN',
    closedAt: null,
    closedCandle: null
  });
  if (trades.length > 500) trades = trades.slice(-500);
  persist();
}

function evaluateTrades(pair, candles) {
  if (!Array.isArray(candles) || !candles.length) return;
  const open = trades.filter(t => t.pair === pair && t.status === 'OPEN');
  if (!open.length) return;
  let changed = false;
  for (const trade of open) {
    const future = candles.filter(c => !trade.openedCandle || c.dt > trade.openedCandle);
    for (const c of future) {
      const hitTp = trade.direction === 'BUY' ? c.h >= trade.tp : c.l <= trade.tp;
      const hitSl = trade.direction === 'BUY' ? c.l <= trade.sl : c.h >= trade.sl;
      if (hitTp && hitSl) {
        trade.status = 'AMBIGUOUS';
        trade.closedAt = Date.now();
        trade.closedCandle = c.dt;
        changed = true;
        break;
      }
      if (hitTp) {
        trade.status = 'WIN';
        trade.closedAt = Date.now();
        trade.closedCandle = c.dt;
        changed = true;
        break;
      }
      if (hitSl) {
        trade.status = 'LOSS';
        trade.closedAt = Date.now();
        trade.closedCandle = c.dt;
        changed = true;
        break;
      }
    }
  }
  if (changed) persist();
}

function getTradeStats() {
  const wins = trades.filter(t => t.status === 'WIN').length;
  const losses = trades.filter(t => t.status === 'LOSS').length;
  const open = trades.filter(t => t.status === 'OPEN').length;
  const ambiguous = trades.filter(t => t.status === 'AMBIGUOUS').length;
  const closed = wins + losses;
  const riskUsd = 140;
  const rewardUsd = riskUsd * 3;
  const grossProfitUsd = wins * rewardUsd;
  const grossLossUsd = losses * riskUsd;
  const netUsd = grossProfitUsd - grossLossUsd;
  return {
    sent: trades.length,
    wins,
    losses,
    open,
    ambiguous,
    winRate: closed ? Number((wins / closed * 100).toFixed(1)) : null,
    riskUsd,
    rewardUsd,
    grossProfitUsd,
    grossLossUsd,
    netUsd,
    netR: wins * 3 - losses
  };
}`;

  server = replaceOnce(server, broadcastBlock, tradeCode, 'trade functions');

  server = replaceOnce(
    server,
    "    const data = await fetchPair(pair);\n    const result = analyze(pair, data);",
    "    const data = await fetchPair(pair);\n    evaluateTrades(pair, data);\n    const result = analyze(pair, data);",
    'evaluate open trades'
  );

  server = replaceOnce(
    server,
    "    if (result.decision === 'ENTER' && lastNotified[pair] !== signature) {\n      lastNotified[pair] = signature;",
    "    if (result.decision === 'ENTER' && lastNotified[pair] !== signature) {\n      registerTrade(pair, result, data[data.length - 1]?.dt || null, signature);\n      lastNotified[pair] = signature;",
    'register sent trade'
  );

  server = replaceOnce(
    server,
    "  state.pairs = pairs;\n  state.configured = !!apiKey;",
    "  state.pairs = pairs;\n  state.configured = !!apiKey;\n  state.tradeStats = getTradeStats();\n  state.tradeHistory = trades.slice(-20).reverse();",
    'expose trade stats'
  );

  fs.writeFileSync('server.js', server);
}

let html = fs.readFileSync('public/index.html', 'utf8');
if (!html.includes('SWEEPLAB_PERFORMANCE_UI')) {
  html = replaceOnce(
    html,
    "    .grid{display:grid;gap:12px}.card{padding:16px}",
    "    .performance{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:16px;margin-bottom:14px} .performance h2{margin:0 0 12px;font-size:20px}.perf-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.perf-item{background:var(--panel2);border-radius:14px;padding:10px;text-align:center}.perf-item .n{font-size:22px;font-weight:950;margin-top:4px}.perf-item.win .n{color:var(--green)}.perf-item.loss .n{color:var(--red)}.perf-item.net.positive .n{color:var(--green)}.perf-item.net.negative .n{color:var(--red)}.history{margin-top:12px;display:grid;gap:7px}.trade-row{background:#0b1a2e;border-radius:12px;padding:9px 10px;display:grid;grid-template-columns:1.1fr .8fr .8fr 1fr;gap:7px;align-items:center;font-size:12px}.trade-row .WIN{color:var(--green)}.trade-row .LOSS{color:var(--red)}.trade-row .OPEN{color:var(--yellow)}.trade-row .AMBIGUOUS{color:#b9c4d4}@media(max-width:620px){.perf-grid{grid-template-columns:repeat(2,1fr)}.trade-row{grid-template-columns:1fr 1fr}} /* SWEEPLAB_PERFORMANCE_UI */\n    .grid{display:grid;gap:12px}.card{padding:16px}",
    'performance css'
  );

  html = replaceOnce(
    html,
    "  <!-- MAX_RISK_USD=140 -->",
    `  <section class="performance">
    <h2>أداء إشارات SweepLab</h2>
    <div class="perf-grid">
      <div class="perf-item"><div class="lab">الإشارات المرسلة</div><div class="n" id="statSent">0</div></div>
      <div class="perf-item win"><div class="lab">ربح</div><div class="n" id="statWins">0</div></div>
      <div class="perf-item loss"><div class="lab">خسارة</div><div class="n" id="statLosses">0</div></div>
      <div class="perf-item"><div class="lab">مفتوحة</div><div class="n" id="statOpen">0</div></div>
      <div class="perf-item"><div class="lab">Win Rate</div><div class="n" id="statRate">—</div></div>
      <div class="perf-item win"><div class="lab">إجمالي الربح</div><div class="n" id="statProfit">$0</div></div>
      <div class="perf-item loss"><div class="lab">إجمالي الخسارة</div><div class="n" id="statLossUsd">$0</div></div>
      <div class="perf-item net" id="statNetBox"><div class="lab">الصافي</div><div class="n" id="statNet">$0</div></div>
    </div>
    <div id="tradeHistory" class="history"></div>
    <div class="margin-help" style="margin-top:10px">الحساب المالي يفترض مخاطرة 140$ لكل صفقة وRR = 1:3: الربح الكامل = +420$ والخسارة الكاملة = -140$. المبلغ الفعلي في حساب MT5 قد يختلف قليلاً حسب اللوت والانزلاق والتنفيذ.</div>
  </section>

  <!-- MAX_RISK_USD=140 -->`,
    'performance section'
  );

  html = replaceOnce(
    html,
    "async function getConfig(){",
    `function renderPerformance(s){
  const st=s.tradeStats||{};
  el('statSent').textContent=st.sent||0;
  el('statWins').textContent=st.wins||0;
  el('statLosses').textContent=st.losses||0;
  el('statOpen').textContent=st.open||0;
  el('statRate').textContent=st.winRate==null?'—':st.winRate+'%';
  el('statProfit').textContent='$'+Number(st.grossProfitUsd||0).toFixed(0);
  el('statLossUsd').textContent='$'+Number(st.grossLossUsd||0).toFixed(0);
  const net=Number(st.netUsd||0);
  el('statNet').textContent=(net<0?'-$':'$')+Math.abs(net).toFixed(0);
  const box=el('statNetBox');
  box.classList.toggle('positive',net>0);
  box.classList.toggle('negative',net<0);
  const rows=(s.tradeHistory||[]).slice(0,10).map(t=>{
    const label=t.status==='WIN'?'ربح +$420':t.status==='LOSS'?'خسارة -$140':t.status==='OPEN'?'مفتوحة':'غير محسومة';
    return '<div class="trade-row"><b>'+t.pair+'</b><span>'+t.direction+'</span><span>'+t.rr+'</span><b class="'+t.status+'">'+label+'</b></div>';
  }).join('');
  el('tradeHistory').innerHTML=rows||'<div class="margin-help">ما توجد إشارات مسجلة بعد.</div>';
}

async function getConfig(){`,
    'performance renderer'
  );

  html = replaceOnce(
    html,
    "    el('monitorState').textContent=s.paused?(s.pauseReason||'متوقفة مؤقتاً'):'تعمل الآن';",
    "    el('monitorState').textContent=s.paused?(s.pauseReason||'متوقفة مؤقتاً'):'تعمل الآن';\n    renderPerformance(s);",
    'render performance in load'
  );

  fs.writeFileSync('public/index.html', html);
}

require('./server.js');

try {
  const file = '/data/sweeplab-runtime.json';
  if (fs.existsSync(file)) {
    const rt = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(rt.trades) ? rt.trades : [];
    const wins = list.filter(t => t.status === 'WIN').length;
    const losses = list.filter(t => t.status === 'LOSS').length;
    const open = list.filter(t => t.status === 'OPEN').length;
    const ambiguous = list.filter(t => t.status === 'AMBIGUOUS').length;
    const summary = {
      sent: list.length,
      wins,
      losses,
      open,
      ambiguous,
      grossProfitUsd: wins * 420,
      grossLossUsd: losses * 140,
      netUsd: wins * 420 - losses * 140
    };
    console.log('SWEEPLAB_TRADE_SUMMARY ' + JSON.stringify(summary));
  }
} catch (e) {
  console.error('SWEEPLAB_TRADE_SUMMARY_ERROR ' + String(e.message || e));
}
