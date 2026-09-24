const http = require("http");
const fs = require("fs");
const path = require("path");
const webpush = require("web-push");

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, "public");
const PAIRS = {
  EURJPY: "EUR/JPY",
  GBPCHF: "GBP/CHF",
  EURCAD: "EUR/CAD"
};
const ASIA_START = "04:00";
const ASIA_END = "08:00";

let apiKey = (process.env.TWELVE_DATA_API_KEY || "").trim();
let subscriptions = [];
let lastNotified = {};
let state = {
  configured: !!apiKey,
  lastScan: null,
  error: null,
  pairs: {}
};

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:sweeplab@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

function sendText(res, code, type, body) {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store"
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 200000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function avgBody(candles, endIndex) {
  const start = Math.max(0, endIndex - 20);
  const sample = candles.slice(start, endIndex);
  if (!sample.length) return 0;
  return sample.reduce((sum, c) => sum + Math.abs(c.c - c.o), 0) / sample.length;
}

function isDisplacement(candles, i, dir) {
  if (i < 20) return false;
  const c = candles[i];
  const avg = avgBody(candles, i);
  if (!avg) return false;
  const body = Math.abs(c.c - c.o);
  if (body < 1.5 * avg) return false;
  return dir === "BUY" ? c.c > c.o : c.c < c.o;
}

function findRecentDisplacement(candles, dir, startIndex) {
  for (let i = candles.length - 1; i >= Math.max(20, startIndex); i--) {
    if (isDisplacement(candles, i, dir)) return i;
  }
  return -1;
}

function aggregate(candles, minutes) {
  const map = new Map();
  for (const c of candles) {
    const hh = c.dt.slice(11, 13);
    const mm = Number(c.dt.slice(14, 16));
    const bucket = String(Math.floor(mm / minutes) * minutes).padStart(2, "0");
    const key = c.dt.slice(0, 11) + hh + ":" + bucket;
    let g = map.get(key);
    if (!g) {
      g = { dt: key, o: c.o, h: c.h, l: c.l, c: c.c };
      map.set(key, g);
    } else {
      g.h = Math.max(g.h, c.h);
      g.l = Math.min(g.l, c.l);
      g.c = c.c;
    }
  }
  return Array.from(map.values()).sort((a, b) => a.dt.localeCompare(b.dt));
}

function lastSwing(candles, type, endIndex) {
  const end = Math.min(endIndex == null ? candles.length - 2 : endIndex, candles.length - 2);
  for (let i = end; i >= 2; i--) {
    if (type === "H" && candles[i].h > candles[i - 1].h && candles[i].h > candles[i + 1].h) {
      return candles[i];
    }
    if (type === "L" && candles[i].l < candles[i - 1].l && candles[i].l < candles[i + 1].l) {
      return candles[i];
    }
  }
  return null;
}

function latestFvg(candles, dir) {
  for (let i = candles.length - 1; i >= 2; i--) {
    if (dir === "BUY" && candles[i - 2].h < candles[i].l) {
      return { low: candles[i - 2].h, high: candles[i].l };
    }
    if (dir === "SELL" && candles[i - 2].l > candles[i].h) {
      return { low: candles[i].h, high: candles[i - 2].l };
    }
  }
  return null;
}

function analyze(pair, m1) {
  if (!m1.length) {
    return { pair, decision: "WAIT", progress: 0, reason: "No market data" };
  }

  const day = m1[m1.length - 1].dt.slice(0, 10);
  const asia = m1.filter(c =>
    c.dt.startsWith(day) &&
    c.dt.slice(11, 16) >= ASIA_START &&
    c.dt.slice(11, 16) < ASIA_END
  );
  const after = m1.filter(c =>
    c.dt.startsWith(day) &&
    c.dt.slice(11, 16) >= ASIA_END
  );
  const price = m1[m1.length - 1].c;

  if (!asia.length || !after.length) {
    return {
      pair,
      decision: "WAIT",
      price,
      progress: 0,
      reason: "Waiting for complete Asia-session data"
    };
  }

  const asiaHigh = Math.max(...asia.map(c => c.h));
  const asiaLow = Math.min(...asia.map(c => c.l));
  const highSweep = after.findIndex(c => c.h > asiaHigh);
  const lowSweep = after.findIndex(c => c.l < asiaLow);

  if (highSweep < 0 && lowSweep < 0) {
    return {
      pair,
      decision: "SKIP",
      price,
      asiaHigh,
      asiaLow,
      progress: 10,
      reason: "Asia High/Low has not been swept",
      checks: { sweep: false }
    };
  }

  let bias;
  let sweepCandle;
  if (highSweep >= 0 && lowSweep >= 0) {
    if (highSweep > lowSweep) {
      bias = "SELL";
      sweepCandle = after[highSweep];
    } else {
      bias = "BUY";
      sweepCandle = after[lowSweep];
    }
  } else if (lowSweep >= 0) {
    bias = "BUY";
    sweepCandle = after[lowSweep];
  } else {
    bias = "SELL";
    sweepCandle = after[highSweep];
  }

  const sweepIndex = Math.max(0, m1.findIndex(c => c.dt === sweepCandle.dt));
  const m5 = aggregate(m1, 5);
  const m15 = aggregate(m1, 15);
  const displacement = findRecentDisplacement(m1, bias, sweepIndex) >= 0;

  const swing = lastSwing(m1, bias === "BUY" ? "H" : "L", m1.length - 3);
  const bos = !!swing && (bias === "BUY" ? price > swing.h : price < swing.l);

  const recent = m1.slice(sweepIndex);
  const hi = Math.max(...recent.map(c => c.h));
  const lo = Math.min(...recent.map(c => c.l));
  const fib50 = bias === "BUY" ? hi - (hi - lo) * 0.5 : lo + (hi - lo) * 0.5;
  const fib618 = bias === "BUY" ? hi - (hi - lo) * 0.618 : lo + (hi - lo) * 0.618;
  const zoneLow = Math.min(fib50, fib618);
  const zoneHigh = Math.max(fib50, fib618);
  const retrace = price >= zoneLow && price <= zoneHigh;

  const fvg5 = latestFvg(m5, bias);
  const fvg15 = latestFvg(m15, bias);
  const confluence = !!(fvg5 || fvg15);

  let model = "Model 1 Reversal";
  let enter = displacement && bos && retrace && confluence;

  if (!enter) {
    const disp15 = findRecentDisplacement(m15, bias, 20) >= 0;
    const sw15 = lastSwing(m15, bias === "BUY" ? "H" : "L", m15.length - 3);
    const break15 = !!sw15 && (bias === "BUY" ? m15[m15.length - 1].c > sw15.h : m15[m15.length - 1].c < sw15.l);
    const zone = fvg15 || fvg5;
    const retraceZone = !!zone && price >= zone.low && price <= zone.high;
    if (disp15 && break15 && zone && retraceZone && bos && fvg5) {
      enter = true;
      model = "Model 2 Continuation";
    }
  }

  const checks = {
    sweep: true,
    displacement,
    bos,
    retrace,
    confluence
  };
  const score = Object.values(checks).filter(Boolean).length;

  return {
    pair,
    decision: enter ? "ENTER" : "WAIT",
    bias,
    model,
    price,
    asiaHigh,
    asiaLow,
    progress: enter ? 100 : Math.round(score / 5 * 100),
    checks,
    reason: enter ? "Setup complete" : "Waiting for remaining conditions",
    note: "Rule-based approximation of the strategy"
  };
}

async function fetchPair(pair) {
  const u = new URL("https://api.twelvedata.com/time_series");
  u.searchParams.set("symbol", PAIRS[pair]);
  u.searchParams.set("interval", "1min");
  u.searchParams.set("outputsize", "700");
  u.searchParams.set("timezone", "Asia/Muscat");
  u.searchParams.set("format", "JSON");
  u.searchParams.set("apikey", apiKey);

  const r = await fetch(u);
  const j = await r.json();
  if (!r.ok || j.status === "error" || !Array.isArray(j.values)) {
    throw new Error(j.message || ("Twelve Data HTTP " + r.status));
  }
  return j.values
    .map(v => ({
      dt: v.datetime,
      o: Number(v.open),
      h: Number(v.high),
      l: Number(v.low),
      c: Number(v.close)
    }))
    .sort((a, b) => a.dt.localeCompare(b.dt));
}

async function sendPush(payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !subscriptions.length) return;
  const keep = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        TTL: 900,
        urgency: "high"
      });
      keep.push(sub);
    } catch (e) {
      if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(sub);
    }
  }
  subscriptions = keep;
}

const pairNames = Object.keys(PAIRS);
let pairCursor = 0;
let lastMarketRequestAt = 0;
const MARKET_REQUEST_GAP_MS = 22000;

async function updatePair(pair) {
  try {
    const data = await fetchPair(pair);
    const result = analyze(pair, data);
    state.pairs[pair] = result;

    const signature = [
      result.decision,
      result.bias,
      result.model,
      result.asiaHigh,
      result.asiaLow
    ].join("|");

    if (result.decision === "ENTER" && lastNotified[pair] !== signature) {
      lastNotified[pair] = signature;
      await sendPush({
        title: pair + " · " + result.bias,
        body: result.model + " · " + result.price,
        tag: pair + "-" + signature,
        url: "/"
      });
    }
  } catch (e) {
    state.pairs[pair] = {
      pair,
      decision: "WAIT",
      progress: 0,
      apiError: String(e.message || e),
      reason: "Market-data error"
    };
  }

  state.configured = true;
  state.lastScan = Date.now();
  state.error = null;
  return state;
}

async function scanNext(force = false) {
  state.configured = !!apiKey;

  if (!apiKey) {
    state = {
      configured: false,
      lastScan: Date.now(),
      error: "API not configured",
      pairs: state.pairs || {}
    };
    return state;
  }

  const now = Date.now();
  if (!force && now - lastMarketRequestAt < MARKET_REQUEST_GAP_MS) {
    return {
      ...state,
      throttled: true,
      retryAfterMs: MARKET_REQUEST_GAP_MS - (now - lastMarketRequestAt)
    };
  }

  lastMarketRequestAt = now;
  const pair = pairNames[pairCursor % pairNames.length];
  pairCursor = (pairCursor + 1) % pairNames.length;
  return updatePair(pair);
}

setInterval(() => {
  scanNext().catch(() => {});
}, MARKET_REQUEST_GAP_MS);

function serveStatic(res, fileName, type) {
  const file = path.join(ROOT, fileName);
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, "text/plain; charset=utf-8", "Not found");
    sendText(res, 200, type, data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");

  if (req.method === "GET" && u.pathname === "/health") {
    return sendJson(res, 200, { ok: true, configured: !!apiKey });
  }

  if (req.method === "GET" && u.pathname === "/") {
    return serveStatic(res, "index.html", "text/html; charset=utf-8");
  }

  if (req.method === "GET" && u.pathname === "/sw.js") {
    return serveStatic(res, "sw.js", "application/javascript; charset=utf-8");
  }

  if (req.method === "GET" && u.pathname === "/manifest.webmanifest") {
    return serveStatic(res, "manifest.webmanifest", "application/manifest+json; charset=utf-8");
  }

  if (req.method === "GET" && u.pathname === "/api/config") {
    return sendJson(res, 200, {
      configured: !!apiKey,
      pairs: Object.keys(PAIRS),
      asia: ASIA_START + "-" + ASIA_END,
      timezone: "Asia/Muscat",
      vapidPublicKey: VAPID_PUBLIC_KEY
    });
  }

  if (req.method === "GET" && u.pathname === "/api/status") {
    return sendJson(res, 200, state);
  }

  if (req.method === "POST" && u.pathname === "/api/key") {
    const body = await readJson(req);
    const key = String(body.key || "").trim();
    if (key.length < 8) return sendJson(res, 400, { ok: false, error: "Invalid API key" });
    apiKey = key;
    pairCursor = 0;
    lastMarketRequestAt = 0;
    await scanNext(true);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && u.pathname === "/api/scan") {
    const result = await scanNext();
    return sendJson(res, 200, result);
  }

  if (req.method === "POST" && u.pathname === "/api/push/subscribe") {
    const sub = await readJson(req);
    if (!sub.endpoint) return sendJson(res, 400, { ok: false });
    subscriptions = subscriptions.filter(s => s.endpoint !== sub.endpoint);
    subscriptions.push(sub);
    return sendJson(res, 200, { ok: true, count: subscriptions.length });
  }

  if (req.method === "POST" && u.pathname === "/api/push/test") {
    await sendPush({
      title: "SweepLab",
      body: "Test notification works",
      tag: "test",
      url: "/"
    });
    return sendJson(res, 200, { ok: true, count: subscriptions.length });
  }

  return sendText(res, 404, "text/plain; charset=utf-8", "Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("SweepLab listening on port", PORT);
});