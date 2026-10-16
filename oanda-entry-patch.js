const fs = require('fs');

// Run the existing MT5 compatibility patch first, but hand off to OANDA
// instead of starting the server immediately. This keeps the old MT5 route
// available without allowing it to drive chart analysis.
const mt5File = 'mt5-bridge-patch.js';
let mt5 = fs.readFileSync(mt5File, 'utf8');
if (!mt5.includes("require('./oanda-patch.js');")) {
  mt5 = mt5.replace("require('./server.js');", "require('./oanda-patch.js');");
  fs.writeFileSync(mt5File, mt5);
}

require('./mt5-bridge-patch.js');
