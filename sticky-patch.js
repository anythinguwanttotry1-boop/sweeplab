const fs = require('fs');

function replaceOnce(source, find, replacement, label) {
  if (!source.includes(find)) {
    console.error('SweepLab sticky patch skipped marker: ' + label);
    return source;
  }
  return source.replace(find, replacement);
}

let server = fs.readFileSync('server.js', 'utf8');
if (!server.includes('SWEEPLAB_STICKY_LEVELS')) {
  server = replaceOnce(
    server,
    "    state.pairs[pair] = enrichPairMeta(pair, result);",
    `    const previous = state.pairs?.[pair] || {};
    const signalSignature = [result.decision, result.bias, result.model, result.asiaHigh, result.asiaLow].join('|');
    const validCurrentLevels = [result.entry, result.sl, result.tp].every(Number.isFinite);
    const holdMs = 20 * 60 * 1000;

    if (result.decision === 'ENTER' && validCurrentLevels) {
      const tracked = (typeof trades !== 'undefined' ? trades : []).slice().reverse().find(t => t.pair === pair && t.signature === signalSignature);
      if (tracked) {
        result.entry = tracked.entry;
        result.sl = tracked.sl;
        result.tp = tracked.tp;
        result.rr = tracked.rr || result.rr || '1:3';
        result.signalExpiresAt = Number(tracked.openedAt || Date.now()) + holdMs;
      } else if (previous.signalSignature === signalSignature && Number(previous.signalExpiresAt) > Date.now()) {
        result.entry = previous.entry;
        result.sl = previous.sl;
        result.tp = previous.tp;
        result.rr = previous.rr || result.rr || '1:3';
        result.signalExpiresAt = previous.signalExpiresAt;
      } else {
        result.signalExpiresAt = Date.now() + holdMs;
      }
      result.signalSignature = signalSignature;
      result.heldSignal = false;
    } else {
      const prevSig = previous.signalSignature;
      const tracked = prevSig && (typeof trades !== 'undefined' ? trades : []).slice().reverse().find(t => t.pair === pair && t.signature === prevSig);
      const stillOpen = !tracked || tracked.status === 'OPEN';
      const validPreviousLevels = [previous.entry, previous.sl, previous.tp].every(v => Number.isFinite(Number(v)));
      if (stillOpen && validPreviousLevels && Number(previous.signalExpiresAt) > Date.now()) {
        result.entry = tracked ? tracked.entry : previous.entry;
        result.sl = tracked ? tracked.sl : previous.sl;
        result.tp = tracked ? tracked.tp : previous.tp;
        result.rr = (tracked && tracked.rr) || previous.rr || '1:3';
        result.bias = (tracked && tracked.direction) || previous.bias || result.bias;
        result.model = (tracked && tracked.model) || previous.model || result.model;
        result.signalExpiresAt = previous.signalExpiresAt;
        result.signalSignature = prevSig;
        result.heldSignal = true;
      }
    }

    state.pairs[pair] = enrichPairMeta(pair, result); // SWEEPLAB_STICKY_LEVELS`,
    'sticky server levels'
  );
  fs.writeFileSync('server.js', server);
}

let html = fs.readFileSync('public/index.html', 'utf8');
if (!html.includes('SWEEPLAB_STICKY_UI')) {
  html = replaceOnce(
    html,
    "  if(p&&p.decision==='ENTER'&&Number(p.entry)>0&&Number(p.sl)>0){",
    "  if(p&&(p.decision==='ENTER'||p.heldSignal)&&Number(p.entry)>0&&Number(p.sl)>0){",
    'sticky lot calculator'
  );

  html = replaceOnce(
    html,
    "    (p.decision==='ENTER'&&Number.isFinite(Number(p.entry))&&Number.isFinite(Number(p.sl))&&Number.isFinite(Number(p.tp))?",
    "    ((p.decision==='ENTER'||p.heldSignal)&&Number.isFinite(Number(p.entry))&&Number.isFinite(Number(p.sl))&&Number.isFinite(Number(p.tp))?",
    'sticky card condition'
  );

  html = replaceOnce(
    html,
    "        '<div><div class=\"lab\">الدخول</div><div class=\"val\">'+fmt(p.entry,p.pair)+'</div></div>'+",
    "        '<div><div class=\"lab\">'+(p.heldSignal?'دخول آخر إشارة':'الدخول')+'</div><div class=\"val\">'+fmt(p.entry,p.pair)+'</div></div>'+",
    'sticky entry label'
  );

  html = replaceOnce(
    html,
    "        '<div class=\"rr-note\">نسبة العائد إلى المخاطرة 1:3 · الوقف خلف أقصى ذيل بعد السويب بهامش 2 pip. مستويات تقديرية وليست ضماناً.</div>'+",
    "        '<div class=\"rr-note\">'+(p.heldSignal?'آخر إشارة محفوظة للمراجعة. تبقى ظاهرة حتى 20 دقيقة من وقت إرسالها، أو تختفي فور وصول TP/SL. المتبقي تقريباً '+Math.max(0,Math.ceil((Number(p.signalExpiresAt)-Date.now())/60000))+' دقيقة.<br>':'')+'نسبة العائد إلى المخاطرة 1:3 · لا تدخل متأخراً إذا ابتعد السعر عن مستوى الدخول.</div>'+ // SWEEPLAB_STICKY_UI",
    'sticky note'
  );

  fs.writeFileSync('public/index.html', html);
}

require('./stats-patch.js');
