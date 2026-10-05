const http = require('http');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');
const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const DATA_FILE = path.join(DATA_DIR, 'sweeplab-runtime.json');
const KEY_FILE = path.join(DATA_DIR, 'twelve-data-key.txt');

const PAIRS = {
  EURJPY: { symbol: 'EUR/JPY', tz: 'Europe/London', start: '08:00', end: '11:00', note: 'افتتاح لندن + تداخل طوكيو/لندن' },
  GBPCHF: { symbol: 'GBP/CHF', tz: 'Europe/London', start: '08:00', end: '12:00', note: 'صباح لندن، أعلى سيولة للجنيه والفرنك' },
  EURCAD: { symbol: 'EUR/CAD', tz: 'America/New_York', start: '08:00', end: '12:00', note: 'تداخل لندن/نيويورك ونشاط الدولار الكندي' }
};

const ASIA_START = '04:00';
const ASIA_END = '08:00';
const PAIR_REFRESH_MS = 120000;
const SCHEDULER_MS = 15000;
const SAFE_DAILY_REQUEST_CAP = 450;

function loadRuntime() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {}
  return {};
}

const runtime = loadRuntime();
let apiKey = (process.env.TWELVE_DATA_API_KEY || '').trim();
if (!apiKey) {
  try { if (fs.existsSync(KEY_FILE)) apiKey = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch {}
}

let subscriptions = Array.isArray(runtime.subscriptions) ? runtime.subscriptions : [];
let lastNotified = runtime.lastNotified || {};
let lastFetchAt = runtime.lastFetchAt || {};
let budget = runtime.budget || {};
let state = runtime.state || { configured: !!apiKey, lastScan: null, error: null, pairs: {} };
let lastTestPushAt = 0;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:sweeplab@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ subscriptions, lastNotified, lastFetchAt, budget, state }));
    fs.renameSync(tmp, DATA_FILE);
  } catch {}
}

function utcDay() { return new Date().toISOString().slice(0, 10); }
function nextUtcMidnightMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 5);
}
function resetBudgetIfNeeded() {
  const today = utcDay();
  if (budget.dayUTC !== today) {
    budget = { dayUTC: today, requests: 0, lockUntil: 0, providerUsed: null, providerLeft: null };
    persist();
  }
  if (!Number.isFinite(budget.requests)) budget.requests = 0;
  if (!Number.isFinite(budget.lockUntil)) budget.lockUntil = 0;
}
resetBudgetIfNeeded();

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendText(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 200000) req.destroy();
    });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function localParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((o, p) => (o[p.type] = p.value, o), {});
  return parts;
}
function hmToMinutes(s) {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function isWeekday(short) { return !['Sat', 'Sun'].includes(short); }
function pairActive(pair, date = new Date()) {
  const cfg = PAIRS[pair];
  const p = localParts(date, cfg.tz);
  if (!isWeekday(p.weekday)) return false;
  const now = Number(p.hour) * 60 + Number(p.minute);
  return now >= hmToMinutes(cfg.start) && now < hmToMinutes(cfg.end);
}
function omanDateString(date = new Date()) {
  const p = localParts(date, 'Asia/Muscat');
  return `${p.year}-${p.month}-${p.day}`;
}
function formatOmanTime(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Muscat', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function omanWindowFor(pair, base = new Date()) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const ymd = omanDateString(new Date(base.getTime() + dayOffset * 86400000));
    const start = new Date(`${ymd}T00:00:00+04:00`);
    let first = null, last = null;
    for (let i = 0; i < 288; i++) {
      const t = new Date(start.getTime() + i * 5 * 60000);
      if (pairActive(pair, t)) {
        if (!first) first = t;
        last = t;
      }
    }
    if (first && last) return `${formatOmanTime(first)}–${formatOmanTime(new Date(last.getTime() + 5 * 60000))}`;
  }
  return '—';
}

function avgBody(candles, endIndex) {
  const sample = candles.slice(Math.max(0, endIndex - 20), endIndex);
  return sample.length ? sample.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / sample.length : 0;
}
function isDisplacement(candles, i, dir) {
  if (i < 20) return false;
  const c = candles[i], avg = avgBody(candles, i);
  if (!avg || Math.abs(c.c - c.o) < 1.5 * avg) return false;
  return dir === 'BUY' ? c.c > c.o : c.c < c.o;
}
function findRecentDisplacement(candles, dir, startIndex) {
  for (let i = candles.length - 1; i >= Math.max(20, startIndex); i--) if (isDisplacement(candles, i, dir)) return i;
  return -1;
}
function aggregate(candles, minutes) {
  const map = new Map();
  for (const c of candles) {
    const hh = c.dt.slice(11, 13), mm = Number(c.dt.slice(14, 16));
    const key = c.dt.slice(0, 11) + hh + ':' + String(Math.floor(mm / minutes) * minutes).padStart(2, '0');
    const g = map.get(key);
    if (!g) map.set(key, { dt: key, o: c.o, h: c.h, l: c.l, c: c.c });
    else { g.h = Math.max(g.h, c.h); g.l = Math.min(g.l, c.l); g.c = c.c; }
  }
  return [...map.values()].sort((a, b) => a.dt.localeCompare(b.dt));
}
function lastSwing(candles, type, endIndex) {
  const end = Math.min(endIndex ?? candles.length - 2, candles.length - 2);
  for (let i = end; i >= 2; i--) {
    if (type === 'H' && candles[i].h > candles[i - 1].h && candles[i].h > candles[i + 1].h) return candles[i];
    if (type === 'L' && candles[i].l < candles[i - 1].l && candles[i].l < candles[i + 1].l) return candles[i];
  }
  return null;
}
function latestFvg(candles, dir) {
  for (let i = candles.length - 1; i >= 2; i--) {
    if (dir === 'BUY' && candles[i - 2].h < candles[i].l) return { low: candles[i - 2].h, high: candles[i].l };
    if (dir === 'SELL' && candles[i - 2].l > candles[i].h) return { low: candles[i].h, high: candles[i - 2].l };
  }
  return null;
}
function analyze(pair, m1) {
  if (!m1.length) return { pair, decision: 'WAIT', progress: 0, reason: 'No market data' };
  const day = m1[m1.length - 1].dt.slice(0, 10);
  const asia = m1.filter(c => c.dt.startsWith(day) && c.dt.slice(11, 16) >= ASIA_START && c.dt.slice(11, 16) < ASIA_END);
  const after = m1.filter(c => c.dt.startsWith(day) && c.dt.slice(11, 16) >= ASIA_END);
  const price = m1[m1.length - 1].c;
  if (!asia.length || !after.length) return { pair, decision: 'WAIT', price, progress: 0, reason: 'Waiting for complete Asia-session data' };

  const asiaHigh = Math.max(...asia.map(c => c.h));
  const asiaLow = Math.min(...asia.map(c => c.l));
  const highSweep = after.findIndex(c => c.h > asiaHigh);
  const lowSweep = after.findIndex(c => c.l < asiaLow);
  if (highSweep < 0 && lowSweep < 0) {
    return { pair, decision: 'SKIP', price, asiaHigh, asiaLow, progress: 10, reason: 'Asia High/Low has not been swept', checks: { sweep: false } };
  }

  let bias, sweepCandle;
  if (highSweep >= 0 && lowSweep >= 0) {
    if (highSweep > lowSweep) { bias = 'SELL'; sweepCandle = after[highSweep]; }
    else { bias = 'BUY'; sweepCandle = after[lowSweep]; }
  } else if (lowSweep >= 0) { bias = 'BUY'; sweepCandle = after[lowSweep]; }
  else { bias = 'SELL'; sweepCandle = after[highSweep]; }

  const sweepIndex = Math.max(0, m1.findIndex(c => c.dt === sweepCandle.dt));
  const m5 = aggregate(m1, 5), m15 = aggregate(m1, 15);
  const displacement = findRecentDisplacement(m1, bias, sweepIndex) >= 0;
  const swing = lastSwing(m1, bias === 'BUY' ? 'H' : 'L', m1.length - 3);
  const bos = !!swing && (bias === 'BUY' ? price > swing.h : price < swing.l);

  const recent = m1.slice(sweepIndex);
  const hi = Math.max(...recent.map(c => c.h)), lo = Math.min(...recent.map(c => c.l));
  const fib50 = bias === 'BUY' ? hi - (hi - lo) * 0.5 : lo + (hi - lo) * 0.5;
  const fib618 = bias === 'BUY' ? hi - (hi - lo) * 0.618 : lo + (hi - lo) * 0.618;
  const retrace = price >= Math.min(fib50, fib618) && price <= Math.max(fib50, fib618);
  const fvg5 = latestFvg(m5, bias), fvg15 = latestFvg(m15, bias);
  const confluence = !!(fvg5 || fvg15);

  let model = 'Model 1 Reversal';
  let enter = displacement && bos && retrace && confluence;
  if (!enter) {
    const disp15 = findRecentDisplacement(m15, bias, 20) >= 0;
    const sw15 = lastSwing(m15, bias === 'BUY' ? 'H' : 'L', m15.length - 3);
    const break15 = !!sw15 && (bias === 'BUY' ? m15[m15.length - 1].c > sw15.h : m15[m15.length - 1].c < sw15.l);
    const zone = fvg15 || fvg5;
    const retraceZone = !!zone && price >= zone.low && price <= zone.high;
    if (disp15 && break15 && zone && retraceZone && bos && fvg5) { enter = true; model = 'Model 2 Continuation'; }
  }

  const checks = { sweep: true, displacement, bos, retrace, confluence };
  const score = Object.values(checks).filter(Boolean).length;
  return {
    pair, decision: enter ? 'ENTER' : 'WAIT', bias, model, price, asiaHigh, asiaLow,
    progress: enter ? 100 : Math.round(score / 5 * 100), checks,
    reason: enter ? 'Setup complete' : 'Waiting for remaining conditions',
    note: 'Rule-based implementation of the strategy'
  };
}

function parseCreditHeaders(r) {
  const namesUsed = ['api-credits-used', 'x-api-credits-used'];
  const namesLeft = ['api-credits-left', 'x-api-credits-left', 'api-credits-remaining'];
  for (const n of namesUsed) { const v = r.headers.get(n); if (v != null && v !== '' && Number.isFinite(Number(v))) budget.providerUsed = Number(v); }
  for (const n of namesLeft) { const v = r.headers.get(n); if (v != null && v !== '' && Number.isFinite(Number(v))) budget.providerLeft = Number(v); }
}
function applyProviderLimit(message, status) {
  const msg = String(message || '');
  if (/current minute|per minute/i.test(msg)) budget.lockUntil = Date.now() + 65000;
  else if (/for the day|daily limit|next day/i.test(msg)) budget.lockUntil = nextUtcMidnightMs();
  else if (status === 429) budget.lockUntil = Date.now() + 65000;
  if (Number.isFinite(budget.providerLeft) && budget.providerLeft <= 20) budget.lockUntil = Math.max(budget.lockUntil || 0, nextUtcMidnightMs());
}
async function fetchPair(pair) {
  resetBudgetIfNeeded();
  if (budget.requests >= SAFE_DAILY_REQUEST_CAP) throw new Error('SweepLab safe daily API limit reached');
  if (Date.now() < (budget.lockUntil || 0)) throw new Error('Twelve Data temporarily paused to protect API credits');

  const u = new URL('https://api.twelvedata.com/time_series');
  u.searchParams.set('symbol', PAIRS[pair].symbol);
  u.searchParams.set('interval', '1min');
  u.searchParams.set('outputsize', '1400');
  u.searchParams.set('timezone', 'Asia/Muscat');
  u.searchParams.set('format', 'JSON');
  u.searchParams.set('apikey', apiKey);

  budget.requests += 1;
  persist();
  const r = await fetch(u);
  parseCreditHeaders(r);
  const j = await r.json();
  if (!r.ok || j.status === 'error' || !Array.isArray(j.values)) {
    applyProviderLimit(j.message, r.status);
    persist();
    throw new Error(j.message || `Twelve Data HTTP ${r.status}`);
  }
  persist();
  return j.values.map(v => ({ dt: v.datetime, o: +v.open, h: +v.high, l: +v.low, c: +v.close })).sort((a, b) => a.dt.localeCompare(b.dt));
}

async function sendPushTo(sub, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 900, urgency: 'high' });
    return true;
  } catch { return false; }
}
async function broadcastPush(payload) {
  const keep = [];
  for (const sub of subscriptions) if (await sendPushTo(sub, payload)) keep.push(sub);
  subscriptions = keep;
  persist();
}

function enrichPairMeta(pair, current) {
  return {
    pair,
    ...(current || { decision: 'WAIT', progress: 0, reason: 'Waiting for monitoring window' }),
    activeNow: pairActive(pair),
    bestTimeOman: omanWindowFor(pair),
    windowNote: PAIRS[pair].note
  };
}
function refreshMeta() {
  resetBudgetIfNeeded();
  const pairs = {};
  for (const pair of Object.keys(PAIRS)) pairs[pair] = enrichPairMeta(pair, state.pairs?.[pair]);
  state.pairs = pairs;
  state.configured = !!apiKey;
  state.apiBudget = {
    requestsToday: budget.requests || 0,
    safeCap: SAFE_DAILY_REQUEST_CAP,
    providerUsed: budget.providerUsed ?? null,
    providerLeft: budget.providerLeft ?? null,
    lockedUntil: budget.lockUntil || 0
  };
  const active = Object.keys(PAIRS).filter(p => pairActive(p));
  state.activePairs = active;
  state.paused = active.length === 0 || Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP;
  if (Date.now() < (budget.lockUntil || 0)) state.pauseReason = 'تم إيقاف طلبات Twelve Data مؤقتاً لحماية رصيد الـ API.';
  else if ((budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) state.pauseReason = 'وصل SweepLab للحد الآمن اليومي. سيعود تلقائياً بعد تجدد الرصيد.';
  else if (!active.length) state.pauseReason = 'حالياً خارج أفضل أوقات التداول للأزواج الثلاثة.';
  else state.pauseReason = null;
}

async function updatePair(pair) {
  try {
    const data = await fetchPair(pair);
    const result = analyze(pair, data);
    state.pairs[pair] = enrichPairMeta(pair, result);
    const signature = [result.decision, result.bias, result.model, result.asiaHigh, result.asiaLow].join('|');
    if (result.decision === 'ENTER' && lastNotified[pair] !== signature) {
      lastNotified[pair] = signature;
      await broadcastPush({ title: `${pair} · ${result.bias}`, body: `${result.model} · ${result.price}`, tag: `${pair}-${signature}`, url: '/' });
    }
  } catch (e) {
    const message = String(e.message || e);
    state.pairs[pair] = enrichPairMeta(pair, { pair, decision: 'WAIT', progress: 0, apiError: message, reason: 'Market-data error' });
  }
  lastFetchAt[pair] = Date.now();
  state.lastScan = Date.now();
  state.error = null;
  refreshMeta();
  persist();
}

let tickRunning = false;
async function schedulerTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    refreshMeta();
    if (!apiKey || state.paused && state.activePairs.length === 0) { persist(); return; }
    for (const pair of Object.keys(PAIRS)) {
      if (!pairActive(pair)) continue;
      if (Date.now() < (budget.lockUntil || 0) || (budget.requests || 0) >= SAFE_DAILY_REQUEST_CAP) break;
      if (Date.now() - Number(lastFetchAt[pair] || 0) < PAIR_REFRESH_MS) continue;
      await updatePair(pair);
    }
  } finally { tickRunning = false; }
}
setInterval(() => schedulerTick().catch(() => {}), SCHEDULER_MS);
setTimeout(() => schedulerTick().catch(() => {}), 1500);

function serveStatic(res, fileName, type) {
  fs.readFile(path.join(ROOT, fileName), (err, data) => {
    if (err) return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    sendText(res, 200, type, data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && u.pathname === '/health') {
      refreshMeta();
      return sendJson(res, 200, { ok: true, configured: !!apiKey, service: 'SweepLab-Final', volume: DATA_DIR === '/data' });
    }
    if (req.method === 'GET' && u.pathname === '/') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/sw.js') return serveStatic(res, 'sw.js', 'application/javascript; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/manifest.webmanifest') return serveStatic(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/icon.svg') return serveStatic(res, 'icon.svg', 'image/svg+xml');

    if (req.method === 'GET' && u.pathname === '/api/config') {
      refreshMeta();
      const windows = {};
      for (const pair of Object.keys(PAIRS)) windows[pair] = { oman: omanWindowFor(pair), note: PAIRS[pair].note };
      return sendJson(res, 200, { configured: !!apiKey, asia: `${ASIA_START}-${ASIA_END}`, timezone: 'Asia/Muscat', pairWindows: windows, vapidPublicKey: VAPID_PUBLIC_KEY });
    }
    if (req.method === 'GET' && u.pathname === '/api/status') {
      refreshMeta();
      return sendJson(res, 200, state);
    }
    if (req.method === 'POST' && u.pathname === '/api/key') {
      if (process.env.TWELVE_DATA_API_KEY) return sendJson(res, 409, { ok: false, error: 'API key is already managed securely in Railway' });
      const b = await readJson(req), key = String(b.key || '').trim();
      if (key.length < 8) return sendJson(res, 400, { ok: false, error: 'Invalid API key' });
      apiKey = key;
      try { fs.writeFileSync(KEY_FILE, key, { mode: 0o600 }); } catch {}
      refreshMeta(); persist();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/scan') {
      await schedulerTick();
      refreshMeta();
      return sendJson(res, 200, state);
    }
    if (req.method === 'POST' && u.pathname === '/api/push/subscribe') {
      const sub = await readJson(req);
      if (!sub.endpoint) return sendJson(res, 400, { ok: false });
      subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
      subscriptions.push(sub); persist();
      return sendJson(res, 200, { ok: true, count: subscriptions.length });
    }
    if (req.method === 'POST' && u.pathname === '/api/push/unsubscribe') {
      const b = await readJson(req);
      subscriptions = subscriptions.filter(s => s.endpoint !== b.endpoint); persist();
      return sendJson(res, 200, { ok: true, count: subscriptions.length });
    }
    if (req.method === 'POST' && u.pathname === '/api/push/test') {
      if (Date.now() - lastTestPushAt < 30000) return sendJson(res, 429, { ok: false, error: 'Please wait before another test' });
      lastTestPushAt = Date.now();
      const b = await readJson(req);
      const sub = subscriptions.find(s => s.endpoint === b.endpoint);
      if (!sub) return sendJson(res, 404, { ok: false, error: 'This device is not subscribed' });
      const ok = await sendPushTo(sub, { title: 'SweepLab', body: 'الإشعارات شغالة حتى لو سكرت التطبيق', tag: 'test', url: '/' });
      return sendJson(res, ok ? 200 : 500, { ok });
    }
    return sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('SweepLab listening on port', PORT));
