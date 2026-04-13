const http = require('http');
const {
  state,
  runOnce,
  scanOpportunities,
  setAutopilot,
  setMode,
  walletLogin,
  walletLogout
} = require('./engine');

const cmd = process.argv[2] || 'scan';

if (cmd === 'scan') {
  console.log(JSON.stringify(runOnce(), null, 2));
  process.exit(0);
}

if (cmd === 'autopilot') {
  setAutopilot(String(process.env.AUTOPILOT || 'true') === 'true');
  console.log(`autopilot=${state.autopilot}, mode=${state.session.mode}, interval=${state.config.scanIntervalMs}ms`);

  const loop = () => {
    const out = runOnce();
    console.log(
      `[${new Date().toISOString()}] best=${out.record.routeType} net=${out.record.netProfitUsd} executed=${out.record.success} mode=${out.record.mode} reason=${out.record.reason}`
    );
    setTimeout(loop, state.config.scanIntervalMs);
  };

  loop();
  return;
}

if (cmd === 'wallet-login') {
  const address = process.argv[3];
  if (!address) {
    console.error('usage: node src/cli.js wallet-login <0x...address> [provider]');
    process.exit(1);
  }
  const provider = process.argv[4] || 'agentic-wallet';
  const wallet = walletLogin({ address, provider });
  console.log(JSON.stringify({ ok: true, wallet, mode: state.session.mode }, null, 2));
  process.exit(0);
}

if (cmd === 'wallet-logout') {
  const wallet = walletLogout();
  console.log(JSON.stringify({ ok: true, wallet }, null, 2));
  process.exit(0);
}

if (cmd === 'mode') {
  const mode = process.argv[3];
  if (!mode) {
    console.error('usage: node src/cli.js mode <paper|live>');
    process.exit(1);
  }
  const newMode = setMode(mode);
  console.log(JSON.stringify({ ok: true, mode: newMode }, null, 2));
  process.exit(0);
}

if (cmd === 'status') {
  console.log(
    JSON.stringify(
      {
        autopilot: state.autopilot,
        mode: state.session.mode,
        wallet: state.session.wallet,
        config: state.config
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (cmd === 'api') {
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.url === '/opportunities') {
      return res.end(JSON.stringify({ data: scanOpportunities() }));
    }
    if (req.url === '/control/autopilot/on') {
      setAutopilot(true);
      return res.end(JSON.stringify({ ok: true, autopilot: true }));
    }
    if (req.url === '/control/autopilot/off') {
      setAutopilot(false);
      return res.end(JSON.stringify({ ok: true, autopilot: false }));
    }
    if (req.url === '/control/mode/paper') {
      setMode('paper');
      return res.end(JSON.stringify({ ok: true, mode: 'paper' }));
    }
    if (req.url === '/control/mode/live') {
      setMode('live');
      return res.end(JSON.stringify({ ok: true, mode: 'live' }));
    }
    if (req.url === '/session') {
      return res.end(JSON.stringify({ session: state.session, autopilot: state.autopilot }));
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
