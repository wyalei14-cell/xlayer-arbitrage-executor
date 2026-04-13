const http = require('http');
const { state, runOnce, scanOpportunities } = require('./engine');

const cmd = process.argv[2] || 'scan';

if (cmd === 'scan') {
  console.log(JSON.stringify(runOnce(), null, 2));
  process.exit(0);
}

if (cmd === 'autopilot') {
  state.autopilot = String(process.env.AUTOPILOT || 'true') === 'true';
  console.log(`autopilot=${state.autopilot}, interval=${state.config.scanIntervalMs}ms`);
  setInterval(() => {
    const out = runOnce();
    console.log(`[${new Date().toISOString()}] best=${out.record.routeType} net=${out.record.netProfitUsd} executed=${out.record.success}`);
  }, state.config.scanIntervalMs);
  return;
}

if (cmd === 'api') {
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer((req, res) => {
    if (req.url === '/opportunities') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ data: scanOpportunities() }));
    }
    if (req.url === '/control/autopilot/on') {
      state.autopilot = true;
      return res.end('autopilot on');
    }
    if (req.url === '/control/autopilot/off') {
      state.autopilot = false;
      return res.end('autopilot off');
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(port, () => console.log(`api listening on :${port}`));
  return;
}

console.error('unknown command');
process.exit(1);
