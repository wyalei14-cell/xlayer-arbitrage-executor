const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  state,
  runOnce,
  runOnceAsync,
  runReplayBacktest,
  runPaperSoak,
  scanOpportunities,
  scanOpportunitiesAsync,
  setAutopilot,
  setMode,
  walletLogin,
  walletLogout,
  getPnlMetrics,
  getAlertStatus
} = require('./engine');

const cmd = process.argv[2] || 'scan';

function renderDashboard(metrics) {
  const last = metrics.lastRecord;
  const alertStatus = getAlertStatus();
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<title>XLayer Arbitrage Dashboard</title>
<style>
body { font-family: sans-serif; margin: 24px; color: #0f172a; }
.card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 14px; margin-bottom: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 12px; }
code { background: #f1f5f9; padding: 2px 4px; border-radius: 4px; }
</style></head>
<body>
<h1>XLayer Arbitrage Executor</h1>
<div class="grid">
  <div class="card"><strong>Total Realized PnL</strong><br/>$${metrics.totalRealizedPnlUsd}</div>
  <div class="card"><strong>Executed Trades</strong><br/>${metrics.executedCount}</div>
  <div class="card"><strong>Execution Rate</strong><br/>${(metrics.executionRate * 100).toFixed(2)}%</div>
  <div class="card"><strong>Avg Realized PnL</strong><br/>$${metrics.avgRealizedPnlUsd}</div>
  <div class="card"><strong>Total Gas Cost</strong><br/>$${metrics.totalGasCostUsd}</div>
  <div class="card"><strong>Execution Fees</strong><br/>$${metrics.totalExecutionCostUsd || 0}</div>
</div>
<div class="card">
  <strong>Paper Mode</strong>: runs=${metrics.byMode.paper.runs}, executed=${metrics.byMode.paper.executed}, pnl=$${metrics.byMode.paper.realizedPnlUsd}<br/>
  <strong>Live Mode</strong>: runs=${metrics.byMode.live.runs}, executed=${metrics.byMode.live.executed}, pnl=$${metrics.byMode.live.realizedPnlUsd}
</div>
<div class="card">
  <strong>Autopilot:</strong> ${state.autopilot} | <strong>Mode:</strong> ${state.session.mode}<br/>
  <strong>Wallet:</strong> ${state.session.wallet.address || 'not logged in'}<br/>
  <strong>Signals:</strong> source=${state.runtimeSignals.quoteSource}, wsQuotes=${state.runtimeSignals.wsQuoteCount}, pendingMempool=${state.runtimeSignals.pendingMempoolTxs}, gasMult=${state.runtimeSignals.gasPressureMultiplier}<br/>
  <strong>Alerts:</strong> ${alertStatus.ok ? 'healthy' : `${alertStatus.alerts.length} active`}<br/>
  <strong>Last Record:</strong> ${last ? `${last.ts} / ${last.reason} / pnl=$${last.realizedProfitUsd}` : 'none'}
</div>
<p>JSON endpoints: <code>/metrics</code>, <code>/alerts</code>, <code>/session</code>, <code>/config</code>, <code>/opportunities</code></p>
</body></html>`;
}

if (cmd === 'scan') {
  runOnceAsync()
    .then((out) => {
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`scan failed: ${err.message}`);
      process.exit(1);
    });
  return;
}

if (cmd === 'autopilot') {
  setAutopilot(String(process.env.AUTOPILOT || 'true') === 'true');
  console.log(`autopilot=${state.autopilot}, mode=${state.session.mode}, interval=${state.config.scanIntervalMs}ms`);

  const loop = async () => {
    try {
      const out = await runOnceAsync();
      console.log(
        `[${new Date().toISOString()}] best=${out.record.routeType} net=${out.record.netProfitUsd} executed=${out.record.success} mode=${out.record.mode} reason=${out.record.reason}`
      );
    } catch (err) {
      console.error(`[${new Date().toISOString()}] scan failed: ${err.message}`);
    } finally {
      setTimeout(loop, state.config.scanIntervalMs);
    }
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
        runtimeSignals: state.runtimeSignals,
        config: state.config
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (cmd === 'backtest') {
  const input = process.argv[3] || path.join(process.cwd(), 'data', 'historical-snapshots.json');
  const output = process.argv[4] || path.join(process.cwd(), 'data', 'backtest-report.json');

  if (!fs.existsSync(input)) {
    console.error(`backtest input not found: ${input}`);
    process.exit(1);
  }

  const snapshots = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (!Array.isArray(snapshots)) {
    console.error('backtest input must be an array of { ts, quotes[], pendingTxs[] }');
    process.exit(1);
  }

  const report = runReplayBacktest(snapshots);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, input, output, report }, null, 2));
  process.exit(0);
}

if (cmd === 'soak') {
  const iterations = Number(process.argv[3] || process.env.SOAK_ITERATIONS || 60);
  const intervalMs = Number(process.argv[4] || process.env.SOAK_INTERVAL_MS || 1000);
  const stopOnCritical = String(process.env.SOAK_STOP_ON_CRITICAL || 'true') === 'true';

  runPaperSoak({ iterations, intervalMs, stopOnCritical })
    .then((report) => {
      console.log(JSON.stringify({ ok: true, report }, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`soak failed: ${err.message}`);
      process.exit(1);
    });
  return;
}

if (cmd === 'api') {
  const port = Number(process.env.PORT || 8787);
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');

    if (req.url === '/opportunities') {
      try {
        const data = await scanOpportunitiesAsync();
        return res.end(JSON.stringify({ data }));
      } catch (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ ok: false, error: err.message }));
      }
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
      return res.end(JSON.stringify({ session: state.session, autopilot: state.autopilot, runtimeSignals: state.runtimeSignals }));
    }
    if (req.url === '/config') {
      return res.end(JSON.stringify({ config: state.config, autopilot: state.autopilot }));
    }
    if (req.url === '/metrics') {
      return res.end(JSON.stringify({ metrics: getPnlMetrics() }));
    }
    if (req.url === '/alerts') {
      return res.end(JSON.stringify({ alerts: getAlertStatus() }));
    }
    if (req.url === '/dashboard') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(renderDashboard(getPnlMetrics()));
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
