const fs = require('fs');

function mustReplace(source, find, replacement, label) {
  if (!source.includes(find)) throw new Error('SweepLab stability patch marker missing: ' + label);
  return source.replace(find, replacement);
}

let html = fs.readFileSync('public/index.html', 'utf8');
if (!html.includes('SWEEPLAB_STABILITY_PATCH')) {
  html = mustReplace(
    html,
    "const el=id=>document.getElementById(id);",
    `const el=id=>document.getElementById(id);

async function fetchWithTimeout(url,opts={},timeoutMs=10000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{...opts,cache:'no-store',signal:controller.signal});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return r;
  }finally{clearTimeout(timer)}
} // SWEEPLAB_STABILITY_PATCH`,
    'fetch helper'
  );

  html = mustReplace(
    html,
    "cfg=await fetch('/api/config',{cache:'no-store'}).then(r=>r.json());",
    "cfg=await fetchWithTimeout('/api/config').then(r=>r.json());",
    'config fetch timeout'
  );

  html = mustReplace(
    html,
    "const s=await fetch('/api/status',{cache:'no-store'}).then(r=>r.json());",
    "const s=await fetchWithTimeout('/api/status',{},8000).then(r=>r.json());",
    'status fetch timeout'
  );

  html = mustReplace(
    html,
    "el('online').textContent='ONLINE';",
    "el('online').textContent='ONLINE · '+new Date().toLocaleTimeString('ar-OM',{hour:'2-digit',minute:'2-digit',second:'2-digit'});",
    'online heartbeat'
  );

  html = mustReplace(
    html,
    "  setInterval(load,60000);",
    "  setInterval(load,30000);\n  document.addEventListener('visibilitychange',()=>{if(!document.hidden)load()});\n  window.addEventListener('online',load);",
    'faster status refresh'
  );

  fs.writeFileSync('public/index.html', html);
}

let sw = fs.readFileSync('public/sw.js', 'utf8');
if (sw.includes("const CACHE='sweeplab-shell-v7';")) {
  sw = sw.replace("const CACHE='sweeplab-shell-v7';", "const CACHE='sweeplab-shell-v8';");
  fs.writeFileSync('public/sw.js', sw);
}

require('./sticky-patch.js');
