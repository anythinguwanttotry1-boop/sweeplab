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

  // Balance stop distance with position size: use the nearest valid recent
  // structure instead of the entire post-sweep range whenever possible.
  // The UI position-size calculator then increases/decreases lot size so the
  // maximum stop loss remains $140 and margin stays within its cap.
  const atrSample = m15.slice(-15);
  const trueRanges = [];
  for (let i = 1; i < atrSample.length; i++) {
    const c = atrSample[i], prev = atrSample[i - 1];
    trueRanges.push(Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c)));
  }
  const atr15 = trueRanges.length ? trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length : 0;
  const swing1 = lastSwing(m1, bias === 'BUY' ? 'L' : 'H', m1.length - 3);
  const swing5 = lastSwing(m5, bias === 'BUY' ? 'L' : 'H', m5.length - 3);
  const structuralLevels = [];
  if (bias === 'BUY') {
    if (swing1 && Number(swing1.l) < entry) structuralLevels.push(Number(swing1.l));
    if (swing5 && Number(swing5.l) < entry) structuralLevels.push(Number(swing5.l));
  } else {
    if (swing1 && Number(swing1.h) > entry) structuralLevels.push(Number(swing1.h));
    if (swing5 && Number(swing5.h) > entry) structuralLevels.push(Number(swing5.h));
  }

  let sl = null;
  let risk = 0;
  let targetTooFar = false;
  if (enter) {
    let structureLevel;
    if (structuralLevels.length) {
      structureLevel = bias === 'BUY' ? Math.max(...structuralLevels) : Math.min(...structuralLevels);
    } else {
      structureLevel = bias === 'BUY' ? lo : hi;
    }

    let rawSl = bias === 'BUY' ? structureLevel - buffer : structureLevel + buffer;
    let rawRisk = Math.abs(entry - rawSl);
    const minRiskDistance = atr15 > 0 ? Math.max(atr15 * 0.18, pip * 4) : pip * 6;
    const maxRiskDistance = atr15 > 0 ? atr15 * 0.80 : Infinity;

    // Do not make the stop so tight that normal noise can knock it out.
    if (rawRisk < minRiskDistance) {
      rawRisk = minRiskDistance;
      rawSl = bias === 'BUY' ? entry - rawRisk : entry + rawRisk;
    }

    // If even the nearest valid structure needs an excessively wide stop,
    // skip the setup instead of forcing either an unrealistic TP or a fragile SL.
    if (!Number.isFinite(rawRisk) || rawRisk <= 0 || rawRisk > maxRiskDistance) {
      enter = false;
      targetTooFar = true;
    } else {
      sl = rawSl;
      risk = rawRisk;
    }
  }

  if (enter && (bias === 'BUY' ? sl >= entry : sl <= entry)) {
    enter = false;
    targetTooFar = true;
  }

  const tpCandidate = enter ? (bias === 'BUY' ? entry + risk * 3 : entry - risk * 3) : null;
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

  if (enter && (!withinVolatility || !withinRecentRange)) {
    enter = false;
    targetTooFar = true;
  }

  if (!enter) {
    sl = null;
    risk = 0;
  }
  const tp = enter ? tpCandidate : null; // SWEEPLAB_REALISTIC_3R`,
    'balanced structural 3R gate'
  );

  server = replaceOnce(
    server,
    "    reason: enter ? 'Setup complete' : 'Waiting for remaining conditions',",
    "    reason: enter ? 'Setup complete — balanced structural SL, lot sized to max $140 risk, RR 1:3' : (targetTooFar ? 'Stop/target not balanced for current volatility — waiting for a better entry' : 'Waiting for remaining conditions'),",
    'balanced 3R reason'
  );

  fs.writeFileSync('server.js', server);
}

require('./mt5-bridge-patch.js');
