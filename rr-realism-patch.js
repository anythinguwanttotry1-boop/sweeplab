const fs = require('fs');

function replaceOnce(source, find, replacement, label) {
  if (!source.includes(find)) throw new Error('SweepLab 3R realism marker missing: ' + label);
  return source.replace(find, replacement);
}

let server = fs.readFileSync('server.js', 'utf8');

if (!server.includes('SWEEPLAB_REALISTIC_3R')) {
  server = replaceOnce(
    server,
    "  const pip = pair.includes('JPY') ? 0.01 : 0.0001;\n  const buffer = pip * 2;\n  const entry = enter ? price : null;\n  const sl = enter ? (bias === 'BUY' ? lo - buffer : hi + buffer) : null;\n  const risk = enter ? Math.abs(entry - sl) : 0;\n  if (enter && (!Number.isFinite(risk) || risk <= 0 || (bias === 'BUY' ? sl >= entry : sl <= entry))) enter = false;\n  const tp = enter ? (bias === 'BUY' ? entry + risk * 3 : entry - risk * 3) : null;",
    `  const pip = pair.includes('JPY') ? 0.01 : 0.0001;
  const buffer = pip * 2;
  const entry = enter ? price : null;
  const sl = enter ? (bias === 'BUY' ? lo - buffer : hi + buffer) : null;
  const risk = enter ? Math.abs(entry - sl) : 0;
  if (enter && (!Number.isFinite(risk) || risk <= 0 || (bias === 'BUY' ? sl >= entry : sl <= entry))) enter = false;

  // Keep RR exactly 1:3, but do not publish targets that are unrealistic for the
  // current market range/volatility. If structural risk is too wide, wait for a
  // better retrace instead of shrinking the stop artificially.
  const tpCandidate = enter ? (bias === 'BUY' ? entry + risk * 3 : entry - risk * 3) : null;
  const atrSample = m15.slice(-15);
  const trueRanges = [];
  for (let i = 1; i < atrSample.length; i++) {
    const c = atrSample[i], prev = atrSample[i - 1];
    trueRanges.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  const atr15 = trueRanges.length ? trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length : 0;
  const recentContext = m1.slice(-Math.min(m1.length, 1440));
  const recentHigh = recentContext.length ? Math.max(...recentContext.map(c => c.h)) : hi;
  const recentLow = recentContext.length ? Math.min(...recentContext.map(c => c.l)) : lo;
  const maxTargetDistance = atr15 > 0 ? atr15 * 2.5 : Infinity;
  const rangeAllowance = atr15 > 0 ? atr15 * 0.75 : risk;
  const targetDistance = enter ? Math.abs(tpCandidate - entry) : 0;
  const withinVolatility = !enter || targetDistance <= maxTargetDistance;
  const withinRecentRange = !enter || (bias === 'BUY'
    ? tpCandidate <= recentHigh + rangeAllowance
    : tpCandidate >= recentLow - rangeAllowance);
  let targetTooFar = false;
  if (enter && (!withinVolatility || !withinRecentRange)) {
    enter = false;
    targetTooFar = true;
  }
  const tp = enter ? tpCandidate : null; // SWEEPLAB_REALISTIC_3R`,
    'realistic 3R gate'
  );

  server = replaceOnce(
    server,
    "    reason: enter ? 'Setup complete' : 'Waiting for remaining conditions',",
    "    reason: enter ? 'Setup complete' : (targetTooFar ? '1:3 target too far for current volatility/range — waiting for a better entry' : 'Waiting for remaining conditions'),",
    '3R rejection reason'
  );

  fs.writeFileSync('server.js', server);
}

require('./mt5-bridge-patch.js');
