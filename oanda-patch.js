const fs = require('fs');

function replaceRequired(source, find, replacement, label) {
  if (!source.includes(find)) throw new Error('SweepLab OANDA marker missing: ' + label);
  return source.replace(find, replacement);
}
function replaceOptional(source, find, replacement) {
  return source.includes(find) ? source.replace(find, replacement) : source;
}
function replaceBetween(source, start, end, replacement, label) {
  const a = source.indexOf(start);
  if (a < 0) throw new Error('SweepLab OANDA start marker missing: ' + label);
  const b = source.indexOf(end, a);
  if (b < 0) throw new Error('SweepLab OANDA end marker missing: ' + label);
  return source.slice(0, a) + replacement + source.slice(b + end.length);
}

let server = fs.readFileSync('server.js', 'utf8');

if (!server.includes('SWEEPLAB_OANDA_SOURCE')) {
  server = replaceRequired(
    server,
    "const PAIR_REFRESH_MS = 120000;",
    "const PAIR_REFRESH_MS = 30000; // OANDA chart refresh",
    'refresh interval'
  );

  server = replaceRequired(
    server,
    "function refreshMeta() {",
    `const OANDA_API_TOKEN = String(process.env.OANDA_API_TOKEN || '').trim();
const OANDA_ACCOUNT_ID = String(process.env.OANDA_ACCOUNT_ID || '').trim();
const OANDA_REST_BASE = String(process.env.OANDA_REST_BASE || 'https://api-fxpractice.oanda.com').replace(/\\/$/, '');
let oandaLastQuoteAt = 0;
let oandaLastError = null;

function oandaConfigured() {
  return !!OANDA_API_TOKEN && !!OANDA_ACCOUNT_ID;
}
function oandaInstrument(pair) {
  const symbol = PAIRS[pair]?.symbol;
  if (!symbol) throw new Error('Unknown pair');
  return symbol.replace('/', '_');
}
function oandaOmanDatetime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Muscat', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return \`${'${parts.year}'}-${'${parts.month}'}-${'${parts.day}'} ${'${parts.hour}'}:${'${parts.minute}'}:${'${parts.second}'}\`;
}
async function oandaJson(url) {
  if (!oandaConfigured()) throw new Error('OANDA credentials are not configured');
  const r = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + OANDA_API_TOKEN,
      'Content-Type': 'application/json',
      'Accept-Datetime-Format': 'RFC3339'
    },
    signal: AbortSignal.timeout(10000)
  });
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const msg = j?.errorMessage || j?.errorCode || ('OANDA HTTP ' + r.status);
    throw new Error(msg);
  }
  return j || {};
}
async function fetchOandaCandles(pair) {
  const instrument = oandaInstrument(pair);
  const u = new URL(OANDA_REST_BASE + '/v3/accounts/' + encodeURIComponent(OANDA_ACCOUNT_ID) + '/instruments/' + encodeURIComponent(instrument) + '/candles');
  u.searchParams.set('price', 'M');
  u.searchParams.set('granularity', 'M1');
  u.searchParams.set('count', '1400');
  u.searchParams.set('smooth', 'false');
  u.searchParams.set('alignmentTimezone', 'Asia/Muscat');
  const j = await oandaJson(u);
  const candles = Array.isArray(j.candles) ? j.candles : [];
  return candles.map(c => ({
    dt: oandaOmanDatetime(c.time),
    o: Number(c.mid?.o), h: Number(c.mid?.h), l: Number(c.mid?.l), c: Number(c.mid?.c)
  })).filter(c => c.dt && [c.o, c.h, c.l, c.c].every(Number.isFinite)).sort((a, b) => a.dt.localeCompare(b.dt));
}
async function fetchOandaInstrumentPrice(instrument) {
  const u = new URL(OANDA_REST_BASE + '/v3/accounts/' + encodeURIComponent(OANDA_ACCOUNT_ID) + '/pricing');
  u.searchParams.set('instruments', instrument);
  u.searchParams.set('includeUnitsAvailable', 'false');
  const j = await oandaJson(u);
  const p = Array.isArray(j.prices) ? j.prices[0] : null;
  const bid = Number(p?.bids?.[0]?.price ?? p?.closeoutBid);
  const ask = Number(p?.asks?.[0]?.price ?? p?.closeoutAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) throw new Error('Invalid OANDA quote');
  oandaLastQuoteAt = Date.now();
  oandaLastError = null;
  return { bid, ask, spread: ask - bid, time: p?.time || j.time || null, status: p?.status || null };
}
async function fetchOandaPrice(pair) {
  return fetchOandaInstrumentPrice(oandaInstrument(pair));
}

function refreshMeta() { // SWEEPLAB_OANDA_SOURCE`,
    'OANDA helpers'
  );

  server = replaceRequired(
    server,
    "    const data = mt5BarsFresh(pair) ? mt5Bars[pair].bars : []; // MT5 ONLY: never fall back to Twelve Data for chart candles",
    "    const data = await fetchOandaCandles(pair);\n    const oandaQuote = await fetchOandaPrice(pair);",
    'OANDA candles + quote'
  );

  server = replaceBetween(
    server,
    "    if (MT5_BRIDGE_TOKEN) {",
    "    } // SWEEPLAB_MT5_LIVE_ENTRY_GATE",
    `    {
      const q = oandaQuote;
      const liveReady = oandaConfigured() && Array.isArray(data) && data.length >= 300 &&
        q && Number.isFinite(Number(q.bid)) && Number.isFinite(Number(q.ask));
      if (!liveReady) {
        result.decision = 'WAIT';
        result.reason = 'Waiting for fresh OANDA chart data';
        result.priceSource = 'OANDA';
        delete result.entry; delete result.sl; delete result.tp;
      } else if (result.decision === 'ENTER') {
        const liveEntry = result.bias === 'BUY' ? Number(q.ask) : Number(q.bid);
        const modelEntry = Number(result.entry);
        const pip = pair.includes('JPY') ? 0.01 : 0.0001;
        const allowedDrift = Math.max(pip * 2, Number(q.spread || 0) * 2);
        if (!Number.isFinite(liveEntry) || !Number.isFinite(modelEntry) || Math.abs(liveEntry - modelEntry) > allowedDrift) {
          result.decision = 'WAIT';
          result.reason = 'OANDA live price does not match setup entry yet — waiting';
          delete result.entry; delete result.sl; delete result.tp;
        } else {
          const sl = Number(result.sl);
          const risk = Math.abs(liveEntry - sl);
          const validRisk = Number.isFinite(sl) && Number.isFinite(risk) && risk > 0 &&
            (result.bias === 'BUY' ? sl < liveEntry : sl > liveEntry);
          if (!validRisk) {
            result.decision = 'WAIT';
            result.reason = 'Invalid OANDA live entry/SL relationship — waiting';
            delete result.entry; delete result.sl; delete result.tp;
          } else {
            result.entry = liveEntry;
            result.price = liveEntry;
            result.tp = result.bias === 'BUY' ? liveEntry + risk * 3 : liveEntry - risk * 3;
            result.rr = '1:3';
            result.entrySource = 'OANDA LIVE';
            result.priceSource = 'OANDA';
            result.reason = 'Setup complete — entry confirmed against OANDA live quote';
          }
        }
      } else {
        result.priceSource = 'OANDA';
        result.price = Number(q.bid);
      }
    } // SWEEPLAB_OANDA_LIVE_ENTRY_GATE`,
    'replace MT5 decision gate'
  );

  server = replaceRequired(
    server,
    "  state.marketDataSource = 'MT5 ONLY';",
    `  state.oanda = {
    configured: oandaConfigured(),
    connected: oandaConfigured() && !!oandaLastQuoteAt && Date.now() - oandaLastQuoteAt < 120000,
    lastQuoteAt: oandaLastQuoteAt || 0,
    lastError: oandaLastError
  };
  state.marketDataSource = 'OANDA';`,
    'market data source label'
  );

  server = replaceOptional(server, "  state.configured = !!apiKey;", "  state.configured = oandaConfigured();");
  server = replaceOptional(
    server,
    "  state.paused = active.length === 0 || Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP;",
    "  state.paused = active.length === 0 || !oandaConfigured();"
  );
  server = replaceOptional(
    server,
    "  if (Date.now() < (budget.lockUntil || 0)) state.pauseReason = 'تم إيقاف طلبات Twelve Data مؤقتاً لحماية رصيد الـ API.';\n  else if ((budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) state.pauseReason = 'وصل SweepLab للحد الآمن اليومي. سيعود تلقائياً بعد تجدد الرصيد.';\n  else if (!active.length) state.pauseReason = 'حالياً خارج أفضل أوقات التداول للأزواج الثلاثة.';\n  else state.pauseReason = null;",
    "  if (!oandaConfigured()) state.pauseReason = 'OANDA API غير مربوط بعد.';\n  else if (!active.length) state.pauseReason = 'حالياً خارج أفضل أوقات التداول للأزواج الثلاثة.';\n  else state.pauseReason = null;"
  );

  server = replaceOptional(
    server,
    "    if (!apiKey || state.paused && state.activePairs.length === 0) { persist(); return; }",
    "    if (!oandaConfigured() || state.paused && state.activePairs.length === 0) { persist(); return; }"
  );
  server = replaceOptional(
    server,
    "      if (Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) break;",
    "      // OANDA is the market-data source; Twelve Data budget does not gate scanning."
  );

  server = replaceBetween(
    server,
    "async function usdPerQuoteCurrency(currency) {",
    "function floorLot(value) {",
    `async function usdPerQuoteCurrency(currency) {
  if (currency === 'USD') return 1;
  const cached = fxCache[currency];
  if (cached && Number.isFinite(cached.usdPerUnit) && Date.now() - cached.at < 5 * 60 * 1000) return cached.usdPerUnit;
  if (!oandaConfigured()) throw new Error('OANDA API غير مربوط.');
  const q = await fetchOandaInstrumentPrice('USD_' + currency);
  const mid = (Number(q.bid) + Number(q.ask)) / 2;
  if (!Number.isFinite(mid) || mid <= 0) throw new Error('تعذر جلب سعر التحويل من OANDA.');
  const usdPerUnit = 1 / mid;
  fxCache[currency] = { usdPerUnit, at: Date.now(), source: 'OANDA' };
  persist();
  return usdPerUnit;
}
function floorLot(value) {`,
    'OANDA FX conversion'
  );

  server = replaceOptional(
    server,
    "      if (!apiKey) return sendJson(res, 503, { error: 'مصدر أسعار التحويل غير مضبوط في السيرفر.' });",
    "      if (!oandaConfigured()) return sendJson(res, 503, { error: 'OANDA API غير مربوط في السيرفر.' });"
  );

  // If an OANDA request fails, expose that failure instead of silently using another feed.
  server = replaceOptional(
    server,
    "  } catch (e) {\n    const message = String(e.message || e);\n    state.pairs[pair] = enrichPairMeta(pair, { pair, decision: 'WAIT', progress: 0, apiError: message, reason: 'Market-data error' });",
    "  } catch (e) {\n    const message = String(e.message || e);\n    oandaLastError = message;\n    state.pairs[pair] = enrichPairMeta(pair, { pair, decision: 'WAIT', progress: 0, apiError: message, priceSource: 'OANDA', reason: 'OANDA market-data error' });"
  );

  fs.writeFileSync('server.js', server);
}

let html = fs.readFileSync('public/index.html', 'utf8');
html = html.replace("((s.mt5Bridge&&s.mt5Bridge.connectedPairs&&s.mt5Bridge.connectedPairs.length)?' · MT5 LIVE':' · MT5 OFFLINE')", "((s.oanda&&s.oanda.connected)?' · OANDA LIVE':' · OANDA OFFLINE')");
fs.writeFileSync('public/index.html', html);

require('./server.js');
