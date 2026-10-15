const fs = require('fs');

function replaceOnce(source, find, replacement, label) {
  if (!source.includes(find)) throw new Error('SweepLab MT5 bridge marker missing: ' + label);
  return source.replace(find, replacement);
}

let server = fs.readFileSync('server.js', 'utf8');

if (!server.includes('SWEEPLAB_MT5_BRIDGE')) {
  server = replaceOnce(
    server,
    "let trades = Array.isArray(runtime.trades) ? runtime.trades : []; // SWEEPLAB_TRADE_STATS_PATCH",
    `let trades = Array.isArray(runtime.trades) ? runtime.trades : []; // SWEEPLAB_TRADE_STATS_PATCH
let mt5Quotes = runtime.mt5Quotes || {};
let mt5Bars = {};
const MT5_BRIDGE_TOKEN = String(process.env.MT5_BRIDGE_TOKEN || '').trim();
const MT5_QUOTE_FRESH_MS = 12000;
const MT5_BARS_FRESH_MS = 90000; // SWEEPLAB_MT5_BRIDGE`,
    'bridge runtime state'
  );

  server = replaceOnce(
    server,
    "JSON.stringify({ subscriptions, lastNotified, lastFetchAt, budget, state, fxCache, trades })",
    "JSON.stringify({ subscriptions, lastNotified, lastFetchAt, budget, state, fxCache, trades, mt5Quotes })",
    'persist MT5 quotes'
  );

  server = server.replace("if (body.length > 200000) req.destroy();", "if (body.length > 1500000) req.destroy();");

  const beforeRefresh = `function refreshMeta() {`;
  const bridgeHelpers = `function mt5OmanDatetime(epochSeconds) {
  const d = new Date(Number(epochSeconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return \`${'${parts.year}'}-${'${parts.month}'}-${'${parts.day}'} ${'${parts.hour}'}:${'${parts.minute}'}:${'${parts.second}'}\`;
}
function mt5QuoteFresh(pair) {
  const q = mt5Quotes[pair];
  return !!q && Number.isFinite(Number(q.bid)) && Number.isFinite(Number(q.ask)) && Date.now() - Number(q.at || 0) <= MT5_QUOTE_FRESH_MS;
}
function mt5BarsFresh(pair) {
  const b = mt5Bars[pair];
  return !!b && Array.isArray(b.bars) && b.bars.length >= 300 && Date.now() - Number(b.at || 0) <= MT5_BARS_FRESH_MS;
}
function evaluateTradesFromMt5(pair, quote) {
  const bid = Number(quote.bid), ask = Number(quote.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
  let changed = false;
  for (const trade of trades.filter(t => t.pair === pair && t.status === 'OPEN')) {
    const px = trade.direction === 'BUY' ? bid : ask;
    const hitTp = trade.direction === 'BUY' ? px >= Number(trade.tp) : px <= Number(trade.tp);
    const hitSl = trade.direction === 'BUY' ? px <= Number(trade.sl) : px >= Number(trade.sl);
    if (hitTp || hitSl) {
      trade.status = hitTp ? 'WIN' : 'LOSS';
      trade.closedAt = Date.now();
      trade.closedCandle = 'MT5 ' + new Date(Number(quote.ts || Date.now())).toISOString();
      trade.closePrice = px;
      trade.closeSource = 'MT5';
      changed = true;
    }
  }
  if (changed) persist();
}
function applyMt5Packet(body) {
  const pair = String(body.pair || '').toUpperCase();
  if (!PAIRS[pair]) throw new Error('Unknown pair');
  const bid = Number(body.bid), ask = Number(body.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) throw new Error('Invalid quote');
  const quote = { pair, bid, ask, spread: ask - bid, ts: Number(body.ts || Date.now()), at: Date.now() };
  mt5Quotes[pair] = quote;
  evaluateTradesFromMt5(pair, quote);
  const current = state.pairs?.[pair] || {};
  state.pairs[pair] = enrichPairMeta(pair, {
    ...current,
    pair,
    price: bid,
    bid,
    ask,
    spread: ask - bid,
    priceSource: 'MT5',
    mt5UpdatedAt: quote.at
  });
  if (Array.isArray(body.bars) && body.bars.length) {
    const bars = body.bars.slice(-1600).map(b => ({
      dt: mt5OmanDatetime(b.t), o: Number(b.o), h: Number(b.h), l: Number(b.l), c: Number(b.c)
    })).filter(b => b.dt && [b.o, b.h, b.l, b.c].every(Number.isFinite)).sort((a, b) => a.dt.localeCompare(b.dt));
    if (bars.length >= 300) mt5Bars[pair] = { at: Date.now(), bars };
  }
  state.lastScan = Date.now();
  refreshMeta();
  persist();
  return pair;
}

function refreshMeta() {`;
  server = replaceOnce(server, beforeRefresh, bridgeHelpers, 'bridge helper functions');

  server = replaceOnce(
    server,
    "  const active = Object.keys(PAIRS).filter(p => pairActive(p));",
    `  const mt5ConnectedPairs = Object.keys(PAIRS).filter(p => mt5QuoteFresh(p));
  state.mt5Bridge = {
    enabled: !!MT5_BRIDGE_TOKEN,
    connectedPairs: mt5ConnectedPairs,
    connected: mt5ConnectedPairs.length > 0,
    lastQuoteAt: Math.max(0, ...Object.values(mt5Quotes).map(q => Number(q?.at || 0)))
  };
  const active = Object.keys(PAIRS).filter(p => pairActive(p));`,
    'bridge state in status'
  );

  server = replaceOnce(
    server,
    "    const data = await fetchPair(pair);",
    "    const data = mt5BarsFresh(pair) ? mt5Bars[pair].bars : await fetchPair(pair);",
    'prefer MT5 candles'
  );

  server = replaceOnce(
    server,
    "    const result = analyze(pair, data);",
    `    const result = analyze(pair, data);

    // Never send a new ENTER from a fallback/stale price when MT5 bridge is configured.
    // A valid signal must have BOTH fresh MT5 bars and a fresh executable MT5 quote.
    if (result && result.decision === 'ENTER' && MT5_BRIDGE_TOKEN) {
      const q = mt5Quotes[pair];
      const liveReady = mt5QuoteFresh(pair) && mt5BarsFresh(pair);
      if (!liveReady) {
        result.decision = 'WAIT';
        result.reason = 'Waiting for fresh MT5 quote + candles before sending ENTER';
        delete result.entry; delete result.sl; delete result.tp;
      } else {
        const liveEntry = result.bias === 'BUY' ? Number(q.ask) : Number(q.bid);
        const modelEntry = Number(result.entry);
        const pip = pair.includes('JPY') ? 0.01 : 0.0001;
        const allowedDrift = Math.max(pip * 2, Number(q.spread || 0) * 2);

        // If the model candle price and the actual broker quote disagree materially,
        // do not alert. This prevents entries at prices the user's MT5 chart never reached.
        if (!Number.isFinite(liveEntry) || !Number.isFinite(modelEntry) || Math.abs(liveEntry - modelEntry) > allowedDrift) {
          result.decision = 'WAIT';
          result.reason = 'MT5 live price does not match setup entry yet — waiting';
          delete result.entry; delete result.sl; delete result.tp;
        } else {
          const sl = Number(result.sl);
          const risk = Math.abs(liveEntry - sl);
          const validRisk = Number.isFinite(sl) && Number.isFinite(risk) && risk > 0 &&
            (result.bias === 'BUY' ? sl < liveEntry : sl > liveEntry);
          if (!validRisk) {
            result.decision = 'WAIT';
            result.reason = 'Invalid MT5 live entry/SL relationship — waiting';
            delete result.entry; delete result.sl; delete result.tp;
          } else {
            result.entry = liveEntry;
            result.price = liveEntry;
            result.tp = result.bias === 'BUY' ? liveEntry + risk * 3 : liveEntry - risk * 3;
            result.rr = '1:3';
            result.entrySource = 'MT5 LIVE';
            result.reason = 'Setup complete — entry confirmed against live MT5 quote';
          }
        }
      }
    } // SWEEPLAB_MT5_LIVE_ENTRY_GATE`,
    'gate ENTER on live MT5 price'
  );

  server = replaceOnce(
    server,
    "    if (req.method === 'GET' && u.pathname === '/health') {",
    `    if (req.method === 'POST' && u.pathname === '/api/mt5/push') {
      if (!MT5_BRIDGE_TOKEN) return sendJson(res, 503, { ok: false, error: 'MT5 bridge not configured' });
      const auth = String(req.headers.authorization || '');
      if (auth !== 'Bearer ' + MT5_BRIDGE_TOKEN) return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      const body = await readJson(req);
      try {
        const pair = applyMt5Packet(body);
        if (Array.isArray(body.bars) && body.bars.length) setImmediate(() => updatePair(pair).catch(() => {}));
        return sendJson(res, 200, { ok: true, pair, source: 'MT5' });
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: String(e.message || e) });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/mt5/status') {
      refreshMeta();
      return sendJson(res, 200, state.mt5Bridge || { enabled: !!MT5_BRIDGE_TOKEN, connected: false, connectedPairs: [] });
    }

    if (req.method === 'GET' && u.pathname === '/health') {`,
    'MT5 bridge routes'
  );

  fs.writeFileSync('server.js', server);
}

let html = fs.readFileSync('public/index.html', 'utf8');
if (!html.includes('SWEEPLAB_MT5_UI')) {
  const oldHeartbeat = "el('online').textContent='ONLINE · '+new Date().toLocaleTimeString('ar-OM',{hour:'2-digit',minute:'2-digit',second:'2-digit'});";
  const newHeartbeat = "el('online').textContent='ONLINE · '+new Date().toLocaleTimeString('ar-OM',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+((s.mt5Bridge&&s.mt5Bridge.connectedPairs&&s.mt5Bridge.connectedPairs.length)?' · MT5 LIVE':' · TWELVE'); // SWEEPLAB_MT5_UI";
  if (html.includes(oldHeartbeat)) html = html.replace(oldHeartbeat, newHeartbeat);
  fs.writeFileSync('public/index.html', html);
}

require('./server.js');
