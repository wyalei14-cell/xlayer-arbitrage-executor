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

  const loop = () => {
    const out = runOnce();
    console.log(`[${new Date().toISOString()}] best=${out.record.routeType} net=${out.record.netProfitUsd} executed=${out.record.success}`);
    setTimeout(loop, state.config.scanIntervalMs);
  };

  loop();
  return;
}

if (cmd === 'api') {
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.url === '/opportunities') {
      return res.end(JSON.stringify({ data: scanOpportunities() }));
    }
    if (req.url === '/control/autopilot/on') {
      state.autopilot = true;
      return res.end(JSON.stringify({ ok: true, autopilot: true }));
    }
    if (req.url === '/control/autopilot/off') {
      state.autopilot = false;
      return res.end(JSON.stringify({ ok: true, autopilot: false }));
    }
    if (req.url === '/config') {
      return res.end(JSON.stringify({ config: state.config, autopilot: state.autopilot }));
    }
    if (req.url === '/healthz') {
      return res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  server.listen(port, () => console.log(`api listening on :${port}`));
  return;
}

console.error('unknown command');
process.exit(1);
