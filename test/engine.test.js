const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  state,
  validateMarket,
  scanOpportunities,
  scanOpportunitiesFromData,
  runReplayBacktest,
  detectTwoPool,
  detectTriangular,
  riskCheck,
  executeOpportunity,
  buildOnchainExecutionPlan,
  persistRuntimeState,
  loadRuntimeState,
  setMode,
  walletLogin,
  walletLogout,
  readExecutionLedger,
  getPnlMetrics
} = require('../src/engine');

const runtimeStateFile = path.join(process.cwd(), 'data', 'runtime-state.json');
const executionsFile = path.join(process.cwd(), 'data', 'executions.jsonl');
const wsQuotesFile = path.join(process.cwd(), 'data', 'ws-quotes.json');
const mempoolFile = path.join(process.cwd(), 'data', 'mempool.json');

function resetSession() {
  state.autopilot = false;
  state.session.mode = 'paper';
  state.session.wallet = {
    loggedIn: false,
    provider: null,
    address: null,
    connectedAt: null
  };
}

test.beforeEach(() => {
  resetSession();
  if (fs.existsSync(runtimeStateFile)) fs.unlinkSync(runtimeStateFile);
  if (fs.existsSync(executionsFile)) fs.unlinkSync(executionsFile);
  if (fs.existsSync(wsQuotesFile)) fs.unlinkSync(wsQuotesFile);
  if (fs.existsSync(mempoolFile)) fs.unlinkSync(mempoolFile);
});

test('validateMarket fails closed on missing fields', () => {
  assert.throws(() => validateMarket([{ dex: 'X' }]), /missing quote field/);
});

test('detectTwoPool returns opportunities when pair has >=2 venues', () => {
  const ts = Date.now();
  const quotes = [
    { dex: 'A', base: 'USDC', quote: 'OKB', price: 1.0, feePct: 0.3, slippagePct: 0.2, liqUsd: 1, ts },
    { dex: 'B', base: 'USDC', quote: 'OKB', price: 1.02, feePct: 0.3, slippagePct: 0.2, liqUsd: 1, ts }
  ];
  const out = detectTwoPool(quotes);
  assert.ok(out.length >= 1);
  assert.equal(out[0].type, 'two-pool');
});

test('detectTriangular returns opportunities for USDC triangle', () => {
  const ts = Date.now();
  const quotes = [
    { dex: 'A', base: 'USDC', quote: 'ETH', price: 0.0004, feePct: 0.1, slippagePct: 0.1, liqUsd: 1, ts },
    { dex: 'B', base: 'ETH', quote: 'OKB', price: 2500, feePct: 0.1, slippagePct: 0.1, liqUsd: 1, ts },
    { dex: 'C', base: 'OKB', quote: 'USDC', price: 1.05, feePct: 0.1, slippagePct: 0.1, liqUsd: 1, ts }
  ];
  const out = detectTriangular(quotes);
  assert.ok(out.length >= 1);
  assert.equal(out[0].type, 'triangular');
});

test('detectTwoPool caps trade size by liquidity usage', () => {
  const ts = Date.now();
  const quotes = [
    { dex: 'A', base: 'USDC', quote: 'OKB', price: 1.0, feePct: 0.3, slippagePct: 0.2, liqUsd: 1000, ts },
    { dex: 'B', base: 'USDC', quote: 'OKB', price: 1.02, feePct: 0.3, slippagePct: 0.2, liqUsd: 500, ts }
  ];
  const out = detectTwoPool(quotes);
  assert.ok(out.length >= 1);
  assert.equal(out[0].tradeAmountUsd, 10);
});

test('riskCheck blocks low-liquidity opportunities', () => {
  const opp = {
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 49_000 }, { liqUsd: 100_000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.5,
    netProfitUsd: 10
  };
  const out = riskCheck(opp);
  assert.equal(out.pass, false);
  assert.equal(out.reason, 'liquidity-too-low');
});

test('buildOnchainExecutionPlan fail-closes when live wallet adapter is missing env/session', () => {
  const prev = process.env.WALLET_ADAPTER;
  const prevAddress = process.env.WALLET_ADDRESS;
  process.env.WALLET_ADAPTER = 'live';
  delete process.env.WALLET_ADDRESS;

  const out = buildOnchainExecutionPlan({ path: ['USDC->OKB@A'] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /wallet-check-failed/);

  if (prev === undefined) delete process.env.WALLET_ADAPTER;
  else process.env.WALLET_ADAPTER = prev;
  if (prevAddress === undefined) delete process.env.WALLET_ADDRESS;
  else process.env.WALLET_ADDRESS = prevAddress;
});

test('executeOpportunity blocks when security scan flags transaction in live mode', () => {
  const prev = process.env.SECURITY_FORCE_BLOCK;
  process.env.SECURITY_FORCE_BLOCK = 'true';
  setMode('live');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(out.success, false);
  assert.match(out.reason, /security-blocked/);

  if (prev === undefined) delete process.env.SECURITY_FORCE_BLOCK;
  else process.env.SECURITY_FORCE_BLOCK = prev;
});

test('executeOpportunity blocks when gas-adjusted net profit is below threshold', () => {
  const prevPrice = process.env.NATIVE_TOKEN_PRICE_USD;
  process.env.NATIVE_TOKEN_PRICE_USD = '1000000';
  setMode('live');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(out.success, false);
  assert.equal(out.reason, 'profit-too-low-after-gas');
  assert.ok(out.gasCostUsd > 8);

  if (prevPrice === undefined) delete process.env.NATIVE_TOKEN_PRICE_USD;
  else process.env.NATIVE_TOKEN_PRICE_USD = prevPrice;
});

test('runtime state persists mode and wallet session', () => {
  setMode('live');
  walletLogin({ address: '0x1234567890abcdef1234567890abcdef12345678', provider: 'agentic-wallet' });
  persistRuntimeState();

  resetSession();
  loadRuntimeState();

  assert.equal(state.session.mode, 'live');
  assert.equal(state.session.wallet.loggedIn, true);
  assert.equal(state.session.wallet.address, '0x1234567890abcdef1234567890abcdef12345678');
});

test('wallet logout clears persisted session', () => {
  walletLogin({ address: '0x1234567890abcdef1234567890abcdef12345678', provider: 'agentic-wallet' });
  walletLogout();
  assert.equal(state.session.wallet.loggedIn, false);
  assert.equal(state.session.wallet.address, null);
});

test('readExecutionLedger ignores malformed rows', () => {
  const ledgerFile = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(
    ledgerFile,
    [
      JSON.stringify({ ts: '2026-04-14T00:00:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 3.2, mode: 'paper' }),
      '{bad json',
      JSON.stringify({ ts: '2026-04-14T00:01:00.000Z', routeType: 'none', success: false, realizedProfitUsd: 0, mode: 'live' })
    ].join('\n') + '\n'
  );

  const rows = readExecutionLedger(10);
  assert.equal(rows.length, 2);
});

test('getPnlMetrics returns execution and pnl aggregates', () => {
  const ledgerFile = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(
    ledgerFile,
    [
      JSON.stringify({ ts: '2026-04-14T00:00:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 4.5, gasCostUsd: 0.2, mode: 'paper' }),
      JSON.stringify({ ts: '2026-04-14T00:01:00.000Z', routeType: 'triangular', success: false, realizedProfitUsd: 0, gasCostUsd: 0, mode: 'paper' }),
      JSON.stringify({ ts: '2026-04-14T00:02:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 2.5, gasCostUsd: 0.3, mode: 'live' })
    ].join('\n') + '\n'
  );

  const metrics = getPnlMetrics({ limit: 20 });
  assert.equal(metrics.sampleSize, 3);
  assert.equal(metrics.opportunitiesSeen, 3);
  assert.equal(metrics.executedCount, 2);
  assert.equal(metrics.totalRealizedPnlUsd, 7);
  assert.equal(metrics.totalGasCostUsd, 0.5);
  assert.equal(metrics.byMode.paper.runs, 2);
  assert.equal(metrics.byMode.live.executed, 1);
});

test('scanOpportunities applies mempool pressure to net profit', () => {
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  fs.writeFileSync(
    mempoolFile,
    JSON.stringify([
      { tokenIn: 'USDC', tokenOut: 'OKB' },
      { tokenIn: 'USDC', tokenOut: 'OKB' },
      { tokenIn: 'USDC', tokenOut: 'OKB' }
    ])
  );

  const out = scanOpportunities();
  const impacted = out.find((x) => x.mempoolPressure && x.mempoolPressure.pendingTouches > 0);
  assert.ok(impacted);
  assert.ok(impacted.mempoolPressure.extraSlippageUsd > 0);
  assert.ok(state.runtimeSignals.pendingMempoolTxs >= 3);
});

test('scanOpportunities merges websocket quote overrides', () => {
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const ts = Date.now();
  fs.writeFileSync(
    wsQuotesFile,
    JSON.stringify([
      { dex: 'UniswapV3', base: 'USDC', quote: 'OKB', price: 1.1, feePct: 0.3, slippagePct: 0.16, liqUsd: 200000, ts }
    ])
  );

  const out = scanOpportunities();
  assert.ok(out.length > 0);
  assert.equal(state.runtimeSignals.quoteSource, 'mock+ws');
  assert.equal(state.runtimeSignals.wsQuoteCount, 1);
});

test('scanOpportunitiesFromData applies replay source and mempool gas pressure', () => {
  const ts = Date.now();
  const quotes = [
    { dex: 'A', base: 'USDC', quote: 'OKB', price: 1.0, feePct: 0.2, slippagePct: 0.1, liqUsd: 120000, ts },
    { dex: 'B', base: 'USDC', quote: 'OKB', price: 1.03, feePct: 0.2, slippagePct: 0.1, liqUsd: 140000, ts }
  ];
  const pendingTxs = [{ tokenIn: 'USDC', tokenOut: 'OKB' }, { tokenIn: 'USDC', tokenOut: 'OKB' }];

  const out = scanOpportunitiesFromData({ quotes, pendingTxs, source: 'historical' });
  assert.ok(out.length > 0);
  assert.equal(state.runtimeSignals.quoteSource, 'historical');
  assert.equal(state.runtimeSignals.pendingMempoolTxs, 2);
  assert.ok(state.runtimeSignals.gasPressureMultiplier > 1);
});

test('runReplayBacktest returns aggregate report from snapshots', () => {
  const ts = Date.now();
  const snapshots = [
    {
      ts: new Date(ts).toISOString(),
      quotes: [
        { dex: 'A', base: 'USDC', quote: 'OKB', price: 1.0, feePct: 0.05, slippagePct: 0.05, liqUsd: 200000, ts },
        { dex: 'B', base: 'USDC', quote: 'OKB', price: 1.05, feePct: 0.05, slippagePct: 0.05, liqUsd: 200000, ts }
      ],
      pendingTxs: []
    }
  ];

  const report = runReplayBacktest(snapshots);
  assert.equal(report.sampleSize, 1);
  assert.equal(report.executedCount, 1);
  assert.ok(report.totalRealizedPnlUsd > 0);
});
