const fs = require('fs');

const statsFile = 'stats-patch.js';
let stats = fs.readFileSync(statsFile, 'utf8');
if (!stats.includes("require('./open-trade-monitor-patch.js');")) {
  stats = stats.replace("require('./server.js');", "require('./open-trade-monitor-patch.js');");
  fs.writeFileSync(statsFile, stats);
}

require('./stability-patch.js');
