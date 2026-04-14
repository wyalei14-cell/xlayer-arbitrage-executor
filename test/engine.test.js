const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  state,
  runOnce,
  validateMarket,
  scanOpportunities,
  scanOpportunitiesAsync,
  scanOpportunitiesFromData,
  runReplayBacktest,
  runPaperSoak,
  detectTwoPool,
  detectTriangular,
  riskCheck,
  scoreOpportunityForRouting,
  buildBestPathPlan,
  executeOpportunity,
  buildAtomicExecutionPlan,
  buildRouterPlan,
  buildOnchainExecutionPlan,
  persistRuntimeState,
  loadRuntimeState,
  setMode,
  walletLogin,
  walletLogout,
  readExecutionLedger,
  getPnlMetrics,
  getDashboardSnapshot,
  evaluateRuntimeAlerts,
  getAlertStatus,
  evaluateExecutionCircuitBreaker,
  staleSignalExecutionGuard,
  startStreamingSignalListeners,
  resetStreamingSignalCache,
  resetAlertSnapshotCache,
  shouldNotifyAlertSnapshot,
  exceedsPreflightLatency
} = require('../src/engine');

const runtimeStateFile = path.join(process.cwd(), 'data', 'runtime-state.json');
const executionsFile = path.join(process.cwd(), 'data', 'executions.jsonl');
const wsQuotesFile = path.join(process.cwd(), 'data', 'ws-quotes.json');
const mempoolFile = path.join(process.cwd(), 'data', 'mempool.json');
const preflightFile = path.join(process.cwd(), 'data', 'preflight.jsonl');
const alertsFile = path.join(process.cwd(), 'data', 'alerts.jsonl');

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
  resetStreamingSignalCache();
  resetAlertSnapshotCache();
  if (fs.existsSync(runtimeStateFile)) fs.unlinkSync(runtimeStateFile);
  if (fs.existsSync(executionsFile)) fs.unlinkSync(executionsFile);
  if (fs.existsSync(wsQuotesFile)) fs.unlinkSync(wsQuotesFile);
  if (fs.existsSync(mempoolFile)) fs.unlinkSync(mempoolFile);
  if (fs.existsSync(preflightFile)) fs.unlinkSync(preflightFile);
  if (fs.existsSync(alertsFile)) fs.unlinkSync(alertsFile);
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

test('scoreOpportunityForRouting applies execution-cost-aware routing penalty and venue bonus', () => {
  const out = scoreOpportunityForRouting({
    netProfitUsd: 5,
    path: ['USDC->ETH@Uni', 'ETH->OKB@Sync', 'OKB->USDC@Uni']
  });

  assert.equal(out.hopCount, 3);
  assert.equal(out.venueCount, 2);
  assert.equal(out.complexityPenaltyUsd, 0.4);
  assert.equal(out.dexDiversityBonusUsd, 0.1);
  assert.ok(out.estimatedExecutionCostUsd > 0);
  assert.ok(out.estimatedNetAfterExecutionUsd < 5);
  assert.equal(out.routingScoreUsd, 4.5484);
});

test('buildBestPathPlan picks highest routing score among risk-passing opportunities', () => {
  const assessed = [
    {
      opp: {
        type: 'triangular',
        netProfitUsd: 4.9,
        path: ['USDC->ETH@A', 'ETH->OKB@B', 'OKB->USDC@C']
      },
      risk: { pass: true, reason: 'ok' }
    },
    {
      opp: {
        type: 'two-pool',
        netProfitUsd: 4.8,
        path: ['USDC->OKB@A', 'OKB->USDC@B']
      },
      risk: { pass: true, reason: 'ok' }
    }
  ];

  const plan = buildBestPathPlan(assessed);
  assert.ok(plan.selected);
  assert.equal(plan.selected.opp.type, 'two-pool');
  assert.equal(plan.ranked.length, 2);
});

test('buildBestPathPlan prefers lower-hop path when execution costs dominate', () => {
  const assessed = [
    {
      opp: {
        type: 'triangular',
        netProfitUsd: 3.4,
        tradeAmountUsd: 400,
        path: ['USDC->ETH@A', 'ETH->OKB@B', 'OKB->USDC@C']
      },
      risk: { pass: true, reason: 'ok' }
    },
    {
      opp: {
        type: 'two-pool',
        netProfitUsd: 3.2,
        tradeAmountUsd: 120,
        path: ['USDC->OKB@A', 'OKB->USDC@B']
      },
      risk: { pass: true, reason: 'ok' }
    }
  ];

  const plan = buildBestPathPlan(assessed);
  assert.ok(plan.selected);
  assert.equal(plan.selected.opp.type, 'two-pool');
  assert.ok(plan.ranked[0].routing.estimatedExecutionCostUsd < plan.ranked[1].routing.estimatedExecutionCostUsd);
});

test('buildRouterPlan constructs multi-hop aggregator route with min return', () => {
  const out = buildRouterPlan({
    path: ['USDC->ETH@Uni', 'ETH->OKB@Sync', 'OKB->USDC@Uni'],
    tradeAmountUsd: 120,
    grossProfitUsd: 6,
    feeUsd: 1,
    slippageUsd: 0.5
  });

  assert.equal(out.ok, true);
  assert.equal(out.routeType, 'multi-hop');
  assert.equal(out.hopCount, 3);
  assert.equal(out.entryToken, 'USDC');
  assert.equal(out.exitToken, 'USDC');
  assert.ok(out.minReturnUsd < out.expectedReturnUsd);
});

test('buildAtomicExecutionPlan flags flash-loan-ready funding for larger trade amounts', () => {
  const out = buildAtomicExecutionPlan(
    { path: ['USDC->OKB@A', 'OKB->USDC@B'], tradeAmountUsd: 500 },
    { address: '0x1111111111111111111111111111111111111111' },
    { tx: { chainId: 196, to: '0x2222222222222222222222222222222222222222' } },
    { estimate: { gasLimit: 320000 } }
  );

  assert.equal(out.required, true);
  assert.equal(out.ready, true);
  assert.equal(out.strategy, 'bundle');
  assert.equal(out.fundingMode, 'flash-loan-ready');
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

test('buildOnchainExecutionPlan fail-closes when router plan cannot be built', () => {
  const out = buildOnchainExecutionPlan({ path: ['BROKEN_PATH_LEG'] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /router-build-failed/);
});

test('buildOnchainExecutionPlan fail-closes when atomic execution is required but unavailable', () => {
  const prev = process.env.ATOMIC_FORCE_DISABLE;
  process.env.ATOMIC_FORCE_DISABLE = 'true';

  const out = buildOnchainExecutionPlan({ path: ['USDC->OKB@A'], tradeAmountUsd: 300 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /atomic-preflight-failed/);

  if (prev === undefined) delete process.env.ATOMIC_FORCE_DISABLE;
  else process.env.ATOMIC_FORCE_DISABLE = prev;
});

test('buildOnchainExecutionPlan includes stage telemetry for observability', () => {
  const out = buildOnchainExecutionPlan({ path: ['USDC->OKB@A', 'OKB->USDC@B'], tradeAmountUsd: 120 });
  assert.equal(out.ok, true);
  assert.ok(out.telemetry);
  assert.ok(out.telemetry.durationMs >= 0);
  assert.ok(Array.isArray(out.telemetry.stages));
  assert.ok(out.telemetry.stages.some((stage) => stage.name === 'wallet' && stage.status === 'ok'));
  assert.ok(out.telemetry.stages.some((stage) => stage.name === 'gateway-preflight' && stage.status === 'ok'));
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

test('executeOpportunity also fail-closes on preflight security block in paper mode', () => {
  const prev = process.env.SECURITY_FORCE_BLOCK;
  process.env.SECURITY_FORCE_BLOCK = 'true';
  setMode('paper');

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

test('executeOpportunity fail-closes when gateway simulation fails', () => {
  const prev = process.env.GATEWAY_FORCE_SIM_FAIL;
  process.env.GATEWAY_FORCE_SIM_FAIL = 'true';
  setMode('paper');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(out.success, false);
  assert.equal(out.reason, 'gateway-preflight-failed');

  if (prev === undefined) delete process.env.GATEWAY_FORCE_SIM_FAIL;
  else process.env.GATEWAY_FORCE_SIM_FAIL = prev;
});

test('executeOpportunity fail-closes when gateway estimate is missing gas limit', () => {
  const prev = process.env.GATEWAY_FORCE_MISSING_GAS;
  process.env.GATEWAY_FORCE_MISSING_GAS = 'true';
  setMode('paper');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(out.success, false);
  assert.equal(out.reason, 'gateway-preflight-failed');

  if (prev === undefined) delete process.env.GATEWAY_FORCE_MISSING_GAS;
  else process.env.GATEWAY_FORCE_MISSING_GAS = prev;
});

test('exceedsPreflightLatency enforces hard preflight timeout threshold', () => {
  const prevMax = state.config.maxPreflightLatencyMs;
  try {
    state.config.maxPreflightLatencyMs = 250;
    assert.equal(exceedsPreflightLatency({ telemetry: { durationMs: 200 } }), false);
    assert.equal(exceedsPreflightLatency({ telemetry: { durationMs: 251 } }), true);
  } finally {
    state.config.maxPreflightLatencyMs = prevMax;
  }
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

test('executeOpportunity blocks when gas share of gross edge exceeds threshold', () => {
  const prevPrice = process.env.NATIVE_TOKEN_PRICE_USD;
  const prevShare = state.config.maxExecutionGasCostShare;

  try {
    process.env.NATIVE_TOKEN_PRICE_USD = '5000';
    state.config.maxExecutionGasCostShare = 0.0001;
    setMode('live');

    const out = executeOpportunity({
      path: ['USDC->OKB@A', 'OKB->USDC@B'],
      legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
      tradeAmountUsd: 100,
      slippageUsd: 0.4,
      netProfitUsd: 50
    });

    assert.equal(out.success, false);
    assert.equal(out.reason, 'gas-share-too-high');
    assert.ok(out.gasCostUsd / 50 > state.config.maxExecutionGasCostShare);
  } finally {
    state.config.maxExecutionGasCostShare = prevShare;
    if (prevPrice === undefined) delete process.env.NATIVE_TOKEN_PRICE_USD;
    else process.env.NATIVE_TOKEN_PRICE_USD = prevPrice;
  }
});

test('executeOpportunity includes router/bundle/flash-loan costs in profitability gate', () => {
  const prevBundleFee = state.config.bundleFeeUsd;
  const prevFlashFee = state.config.flashLoanFeeBps;
  const prevRouterFee = state.config.routerFeeBps;

  state.config.bundleFeeUsd = 2;
  state.config.flashLoanFeeBps = 10;
  state.config.routerFeeBps = 5;
  setMode('live');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 1000,
    slippageUsd: 0.4,
    netProfitUsd: 3
  });

  assert.equal(out.success, false);
  assert.equal(out.reason, 'profit-too-low-after-gas');
  assert.ok(out.executionCostUsd > 2);
  assert.ok(out.netAfterAllCostsUsd < state.config.minNetProfitUsd);

  state.config.bundleFeeUsd = prevBundleFee;
  state.config.flashLoanFeeBps = prevFlashFee;
  state.config.routerFeeBps = prevRouterFee;
});

test('executeOpportunity writes preflight trace log for execution attempts', () => {
  setMode('paper');

  executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(fs.existsSync(preflightFile), true);
  const lines = fs.readFileSync(preflightFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1);
  const row = JSON.parse(lines[lines.length - 1]);
  assert.ok(row.telemetry.durationMs >= 0);
  assert.ok(Array.isArray(row.telemetry.stages));
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
      JSON.stringify({ ts: '2026-04-14T00:00:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 4.5, gasCostUsd: 0.2, executionCostUsd: 0.1, mode: 'paper' }),
      JSON.stringify({ ts: '2026-04-14T00:01:00.000Z', routeType: 'triangular', success: false, realizedProfitUsd: 0, gasCostUsd: 0, executionCostUsd: 0, mode: 'paper' }),
      JSON.stringify({ ts: '2026-04-14T00:02:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 2.5, gasCostUsd: 0.3, executionCostUsd: 0.2, mode: 'live' })
    ].join('\n') + '\n'
  );

  const metrics = getPnlMetrics({ limit: 20 });
  assert.equal(metrics.sampleSize, 3);
  assert.equal(metrics.opportunitiesSeen, 3);
  assert.equal(metrics.executedCount, 2);
  assert.equal(metrics.totalRealizedPnlUsd, 7);
  assert.equal(metrics.totalGasCostUsd, 0.5);
  assert.equal(metrics.totalExecutionCostUsd, 0.3);
  assert.equal(metrics.byMode.paper.runs, 2);
  assert.equal(metrics.byMode.live.executed, 1);
});

test('getDashboardSnapshot exposes recent trade pnl rows for dashboard rendering', () => {
  const ledgerFile = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(
    ledgerFile,
    [
      JSON.stringify({ ts: '2026-04-14T00:00:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 1.2, netAfterAllCostsUsd: 1.3, mode: 'paper', reason: 'paper-filled' }),
      JSON.stringify({ ts: '2026-04-14T00:01:00.000Z', routeType: 'triangular', success: false, realizedProfitUsd: 0, netAfterAllCostsUsd: -0.5, mode: 'paper', reason: 'profit-too-low-after-gas' }),
      JSON.stringify({ ts: '2026-04-14T00:02:00.000Z', routeType: 'two-pool', success: true, realizedProfitUsd: 2.4, netAfterAllCostsUsd: 2.6, mode: 'live', reason: 'executed-attempt-1' })
    ].join('\n') + '\n'
  );

  const snapshot = getDashboardSnapshot({ tradeLimit: 2, ledgerLimit: 20 });
  assert.equal(snapshot.recentTrades.length, 2);
  assert.equal(snapshot.recentTrades[0].ts, '2026-04-14T00:02:00.000Z');
  assert.equal(snapshot.recentTrades[0].realizedProfitUsd, 2.4);
  assert.equal(snapshot.recentTrades[1].ts, '2026-04-14T00:01:00.000Z');
  assert.equal(snapshot.metrics.sampleSize, 3);
});

test('scanOpportunities applies mempool pressure to net profit', () => {
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const ts = Date.now();
  fs.writeFileSync(
    mempoolFile,
    JSON.stringify([
      { tokenIn: 'USDC', tokenOut: 'OKB', ts },
      { tokenIn: 'USDC', tokenOut: 'OKB', ts },
      { tokenIn: 'USDC', tokenOut: 'OKB', ts }
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
  assert.equal(state.runtimeSignals.listenerMode, 'watch');
  assert.ok(state.runtimeSignals.wsUpdatedAt);
});

test('scanOpportunities drops stale websocket and mempool signals', () => {
  fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
  const staleTs = Date.now() - 60_000;

  fs.writeFileSync(
    wsQuotesFile,
    JSON.stringify([
      { dex: 'UniswapV3', base: 'USDC', quote: 'OKB', price: 1.1, feePct: 0.3, slippagePct: 0.16, liqUsd: 200000, ts: staleTs }
    ])
  );
  fs.writeFileSync(
    mempoolFile,
    JSON.stringify([
      { tokenIn: 'USDC', tokenOut: 'OKB', ts: staleTs }
    ])
  );

  scanOpportunities();
  assert.equal(state.runtimeSignals.quoteSource, 'mock');
  assert.equal(state.runtimeSignals.wsQuoteCount, 0);
  assert.equal(state.runtimeSignals.pendingMempoolTxs, 0);
  assert.ok(state.runtimeSignals.wsDroppedStale >= 1);
  assert.ok(state.runtimeSignals.mempoolDroppedStale >= 1);
});

test('scanOpportunitiesAsync supports live quote adapter path', async () => {
  const prevAdapter = process.env.QUOTE_ADAPTER;
  const prevUrl = process.env.QUOTE_ADAPTER_URL;
  const prevFetch = global.fetch;

  try {
    process.env.QUOTE_ADAPTER = 'live';
    process.env.QUOTE_ADAPTER_URL = 'https://quotes.test/live';
    global.fetch = async () => ({
      ok: true,
      json: async () => {
        const ts = Date.now();
        return [
          { dex: 'LiveA', base: 'USDC', quote: 'OKB', price: 1.0, feePct: 0.2, slippagePct: 0.1, liqUsd: 220000, ts },
          { dex: 'LiveB', base: 'USDC', quote: 'OKB', price: 1.03, feePct: 0.2, slippagePct: 0.1, liqUsd: 220000, ts }
        ];
      }
    });

    const out = await scanOpportunitiesAsync();
    assert.ok(out.length > 0);
    assert.equal(state.runtimeSignals.quoteSource, 'live');
  } finally {
    if (prevAdapter === undefined) delete process.env.QUOTE_ADAPTER;
    else process.env.QUOTE_ADAPTER = prevAdapter;
    if (prevUrl === undefined) delete process.env.QUOTE_ADAPTER_URL;
    else process.env.QUOTE_ADAPTER_URL = prevUrl;
    global.fetch = prevFetch;
  }
});

test('startStreamingSignalListeners ingests websocket and mempool socket payloads', async () => {
  const prevWsUrl = process.env.WS_QUOTES_URL;
  const prevMempoolUrl = process.env.MEMPOOL_WS_URL;
  const PrevWebSocket = global.WebSocket;

  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.handlers = {};
      sockets.push(this);
    }

    addEventListener(name, handler) {
      this.handlers[name] = handler;
    }

    emit(name, payload) {
      if (this.handlers[name]) this.handlers[name](payload);
    }

    close() {}
  }

  try {
    process.env.WS_QUOTES_URL = 'wss://quotes.test';
    process.env.MEMPOOL_WS_URL = 'wss://mempool.test';
    state.config.wsQuoteSocketUrl = process.env.WS_QUOTES_URL;
    state.config.mempoolSocketUrl = process.env.MEMPOOL_WS_URL;
    global.WebSocket = FakeSocket;

    startStreamingSignalListeners();
    assert.equal(sockets.length, 2);

    const ts = Date.now();
    sockets[0].emit('message', {
      data: JSON.stringify({ data: [{ dex: 'WS', base: 'USDC', quote: 'OKB', price: 1.01, feePct: 0.2, slippagePct: 0.1, liqUsd: 200000, ts }] })
    });
    sockets[1].emit('message', {
      data: JSON.stringify([{ tokenIn: 'USDC', tokenOut: 'OKB', ts }])
    });

    const out = scanOpportunities();
    assert.ok(out.length > 0);
    assert.equal(state.runtimeSignals.listenerMode, 'socket');
    assert.equal(state.runtimeSignals.wsQuoteCount, 1);
    assert.equal(state.runtimeSignals.pendingMempoolTxs, 1);
  } finally {
    state.config.wsQuoteSocketUrl = '';
    state.config.mempoolSocketUrl = '';
    if (prevWsUrl === undefined) delete process.env.WS_QUOTES_URL;
    else process.env.WS_QUOTES_URL = prevWsUrl;
    if (prevMempoolUrl === undefined) delete process.env.MEMPOOL_WS_URL;
    else process.env.MEMPOOL_WS_URL = prevMempoolUrl;
    global.WebSocket = PrevWebSocket;
    resetStreamingSignalCache();
  }
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

test('evaluateRuntimeAlerts triggers consecutive failure and low execution warnings', () => {
  const rows = [
    { success: true, realizedProfitUsd: 1, gasCostUsd: 0.1, netProfitUsd: 2 },
    { success: false, realizedProfitUsd: -1, gasCostUsd: 0.4, netProfitUsd: 0.2 },
    { success: false, realizedProfitUsd: -1, gasCostUsd: 0.4, netProfitUsd: 0.2 },
    { success: false, realizedProfitUsd: -1, gasCostUsd: 0.4, netProfitUsd: 0.2 },
    { success: false, realizedProfitUsd: -1, gasCostUsd: 0.4, netProfitUsd: 0.2 },
    { success: false, realizedProfitUsd: -1, gasCostUsd: 0.4, netProfitUsd: 0.2 }
  ];
  const metrics = {
    sampleSize: rows.length,
    executionRate: 0.16,
    totalRealizedPnlUsd: -4
  };
  const runtimeState = {
    ...state,
    autopilot: false,
    config: {
      ...state.config,
      alertWindow: 20,
      alertMaxConsecutiveFailures: 5,
      alertMinExecutionRate: 0.2,
      alertMinRecentPnlUsd: -3,
      alertMaxGasCostShare: 0.5
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({ rows, metrics, runtimeState });
  assert.equal(out.ok, false);
  assert.ok(out.alerts.some((a) => a.code === 'consecutive-failures'));
  assert.ok(out.alerts.some((a) => a.code === 'low-execution-rate'));
});

test('getAlertStatus raises wallet-session-missing in live autopilot mode', () => {
  state.autopilot = true;
  setMode('live');
  walletLogout();

  const out = getAlertStatus();
  assert.equal(out.ok, false);
  assert.ok(out.alerts.some((a) => a.code === 'wallet-session-missing'));
});

test('evaluateRuntimeAlerts raises critical high-gas-pressure from runtime signals', () => {
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      alertMaxGasPressureMultiplier: 1.3
    },
    runtimeSignals: {
      ...state.runtimeSignals,
      gasPressureMultiplier: 1.55
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({
    rows: [],
    metrics: { sampleSize: 0, executionRate: 0, totalRealizedPnlUsd: 0 },
    runtimeState
  });

  assert.ok(out.alerts.some((a) => a.code === 'high-gas-pressure' && a.level === 'critical'));
});

test('evaluateRuntimeAlerts raises critical execution-lock-stuck when lock age breaches ttl', () => {
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      executionLockTtlMs: 5_000
    },
    runtimeSignals: {
      ...state.runtimeSignals,
      executionLockActive: true,
      executionLockAgeMs: 12_000
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({
    rows: [],
    metrics: { sampleSize: 0, executionRate: 0, totalRealizedPnlUsd: 0 },
    runtimeState
  });

  assert.ok(out.alerts.some((a) => a.code === 'execution-lock-stuck' && a.level === 'critical'));
});

test('evaluateRuntimeAlerts raises warning/critical alerts when 24h loss limits are breached', () => {
  const nowIso = new Date().toISOString();
  const rows = [
    { ts: nowIso, success: false, realizedProfitUsd: -12, gasCostUsd: 0.1, netProfitUsd: 0 },
    { ts: nowIso, success: false, realizedProfitUsd: -10, gasCostUsd: 0.1, netProfitUsd: 0 }
  ];
  const metrics = {
    sampleSize: rows.length,
    executionRate: 0,
    totalRealizedPnlUsd: -22,
    rolling24hPnlUsd: -22
  };
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      alertWindow: 10,
      alertMaxDailyLossUsd: -15,
      maxDailyLossUsd: -20
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({ rows, metrics, runtimeState });
  assert.ok(out.alerts.some((a) => a.code === 'daily-loss-warning' && a.level === 'warning'));
  assert.ok(out.alerts.some((a) => a.code === 'daily-loss-limit-breached' && a.level === 'critical'));
  assert.equal(out.stats.rolling24hPnlUsd, -22);
});

test('evaluateRuntimeAlerts raises slow preflight latency warning from recent runs', () => {
  const rows = [
    { success: true, realizedProfitUsd: 1.2, gasCostUsd: 0.2, netProfitUsd: 2.1, onchainPreflight: { telemetry: { durationMs: 3200 } } },
    { success: true, realizedProfitUsd: 1.1, gasCostUsd: 0.2, netProfitUsd: 2.0, onchainPreflight: { telemetry: { durationMs: 2800 } } },
    { success: false, realizedProfitUsd: -0.2, gasCostUsd: 0.15, netProfitUsd: 0.4, onchainPreflight: { telemetry: { durationMs: 3000 } } }
  ];
  const metrics = {
    sampleSize: rows.length,
    executionRate: 0.66,
    totalRealizedPnlUsd: 2.1
  };
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      alertWindow: 10,
      alertMaxPreflightLatencyMs: 2500
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({ rows, metrics, runtimeState });
  assert.ok(out.alerts.some((a) => a.code === 'slow-preflight-latency' && a.level === 'warning'));
  assert.ok(out.stats.avgPreflightLatencyMs >= 3000);
});

test('evaluateRuntimeAlerts raises stale streaming signal warnings when listener data is old', () => {
  const staleIso = new Date(Date.now() - 60_000).toISOString();
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      enableStreamingSignals: true,
      maxWsSignalAgeMs: 10_000,
      maxMempoolSignalAgeMs: 10_000
    },
    runtimeSignals: {
      ...state.runtimeSignals,
      listenerMode: 'watch',
      listenersStartedAt: new Date(Date.now() - 120_000).toISOString(),
      wsUpdatedAt: staleIso,
      mempoolUpdatedAt: staleIso
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({ rows: [], metrics: { sampleSize: 0, executionRate: 0, totalRealizedPnlUsd: 0 }, runtimeState });
  assert.ok(out.alerts.some((a) => a.code === 'ws-signal-stale'));
  assert.ok(out.alerts.some((a) => a.code === 'mempool-signal-stale'));
});

test('evaluateRuntimeAlerts raises missing streaming signal warnings after bootstrap grace window', () => {
  const runtimeState = {
    ...state,
    config: {
      ...state.config,
      enableStreamingSignals: true,
      streamingBootstrapGraceMs: 5_000,
      maxWsSignalAgeMs: 10_000,
      maxMempoolSignalAgeMs: 10_000
    },
    runtimeSignals: {
      ...state.runtimeSignals,
      listenerMode: 'watch',
      listenersStartedAt: new Date(Date.now() - 60_000).toISOString(),
      wsUpdatedAt: null,
      mempoolUpdatedAt: null
    },
    session: { ...state.session, wallet: { ...state.session.wallet } }
  };

  const out = evaluateRuntimeAlerts({ rows: [], metrics: { sampleSize: 0, executionRate: 0, totalRealizedPnlUsd: 0 }, runtimeState });
  assert.ok(out.alerts.some((a) => a.code === 'ws-signal-missing'));
  assert.ok(out.alerts.some((a) => a.code === 'mempool-signal-missing'));
});

test('staleSignalExecutionGuard blocks execution when streaming overlays are stale', () => {
  const staleIso = new Date(Date.now() - 60_000).toISOString();
  const prev = {
    enableStreamingSignals: state.config.enableStreamingSignals,
    maxWsSignalAgeMs: state.config.maxWsSignalAgeMs,
    maxMempoolSignalAgeMs: state.config.maxMempoolSignalAgeMs,
    listenerMode: state.runtimeSignals.listenerMode,
    wsUpdatedAt: state.runtimeSignals.wsUpdatedAt,
    mempoolUpdatedAt: state.runtimeSignals.mempoolUpdatedAt
  };

  state.config.enableStreamingSignals = true;
  state.config.maxWsSignalAgeMs = 10_000;
  state.config.maxMempoolSignalAgeMs = 10_000;
  state.runtimeSignals.listenerMode = 'watch';
  state.runtimeSignals.wsUpdatedAt = staleIso;
  state.runtimeSignals.mempoolUpdatedAt = staleIso;

  const out = staleSignalExecutionGuard(state);
  assert.equal(out.pass, false);
  assert.match(out.reason, /stale-streaming-signal/);

  state.config.enableStreamingSignals = prev.enableStreamingSignals;
  state.config.maxWsSignalAgeMs = prev.maxWsSignalAgeMs;
  state.config.maxMempoolSignalAgeMs = prev.maxMempoolSignalAgeMs;
  state.runtimeSignals.listenerMode = prev.listenerMode;
  state.runtimeSignals.wsUpdatedAt = prev.wsUpdatedAt;
  state.runtimeSignals.mempoolUpdatedAt = prev.mempoolUpdatedAt;
});

test('executeOpportunity fail-closes when streaming overlays become stale', () => {
  const staleIso = new Date(Date.now() - 60_000).toISOString();
  const prev = {
    enableStreamingSignals: state.config.enableStreamingSignals,
    maxWsSignalAgeMs: state.config.maxWsSignalAgeMs,
    maxMempoolSignalAgeMs: state.config.maxMempoolSignalAgeMs,
    listenerMode: state.runtimeSignals.listenerMode,
    wsUpdatedAt: state.runtimeSignals.wsUpdatedAt,
    mempoolUpdatedAt: state.runtimeSignals.mempoolUpdatedAt,
    mode: state.session.mode
  };

  state.config.enableStreamingSignals = true;
  state.config.maxWsSignalAgeMs = 10_000;
  state.config.maxMempoolSignalAgeMs = 10_000;
  state.runtimeSignals.listenerMode = 'watch';
  state.runtimeSignals.wsUpdatedAt = staleIso;
  state.runtimeSignals.mempoolUpdatedAt = staleIso;
  setMode('live');

  const out = executeOpportunity({
    path: ['USDC->OKB@A', 'OKB->USDC@B'],
    legs: [{ liqUsd: 100000 }, { liqUsd: 100000 }],
    tradeAmountUsd: 100,
    slippageUsd: 0.4,
    netProfitUsd: 8
  });

  assert.equal(out.success, false);
  assert.match(out.reason, /stale-streaming-signal/);

  state.config.enableStreamingSignals = prev.enableStreamingSignals;
  state.config.maxWsSignalAgeMs = prev.maxWsSignalAgeMs;
  state.config.maxMempoolSignalAgeMs = prev.maxMempoolSignalAgeMs;
  state.runtimeSignals.listenerMode = prev.listenerMode;
  state.runtimeSignals.wsUpdatedAt = prev.wsUpdatedAt;
  state.runtimeSignals.mempoolUpdatedAt = prev.mempoolUpdatedAt;
  setMode(prev.mode);
});

test('runOnce fail-closes with execution circuit breaker on critical alerts', () => {
  const ledgerFile = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  fs.writeFileSync(
    ledgerFile,
    new Array(5)
      .fill(null)
      .map((_, idx) => JSON.stringify({
        ts: new Date(Date.now() - (5 - idx) * 1000).toISOString(),
        routeType: 'two-pool',
        success: false,
        realizedProfitUsd: 0,
        netProfitUsd: 3,
        mode: 'paper'
      }))
      .join('\n') + '\n'
  );

  state.autopilot = true;
  setMode('paper');
  const prevMinProfit = state.config.minNetProfitUsd;
  state.config.minNetProfitUsd = -1;

  const alertSnapshot = getAlertStatus();
  const circuit = evaluateExecutionCircuitBreaker(alertSnapshot);
  assert.equal(circuit.pass, false);

  const out = runOnce();
  assert.equal(out.record.success, false);
  assert.match(out.record.reason, /execution-circuit-breaker/);

  state.config.minNetProfitUsd = prevMinProfit;
});

test('runPaperSoak executes requested iterations and restores prior session state', async () => {
  state.autopilot = false;
  setMode('live');

  const report = await runPaperSoak({ iterations: 3, intervalMs: 0, stopOnCritical: false });
  assert.equal(report.iterationsCompleted, 3);
  assert.equal(report.stoppedEarly, false);
  assert.equal(state.autopilot, false);
  assert.equal(state.session.mode, 'live');
});

test('runPaperSoak stops early on critical alert when enabled', async () => {
  const prevSecurity = process.env.SECURITY_FORCE_BLOCK;
  process.env.SECURITY_FORCE_BLOCK = 'true';

  const prevWindow = state.config.alertWindow;
  const prevFailures = state.config.alertMaxConsecutiveFailures;
  state.config.alertWindow = 5;
  state.config.alertMaxConsecutiveFailures = 1;

  const report = await runPaperSoak({ iterations: 5, intervalMs: 0, stopOnCritical: true });
  assert.equal(report.stoppedEarly, true);
  assert.ok(report.iterationsCompleted < 5);

  state.config.alertWindow = prevWindow;
  state.config.alertMaxConsecutiveFailures = prevFailures;
  if (prevSecurity === undefined) delete process.env.SECURITY_FORCE_BLOCK;
  else process.env.SECURITY_FORCE_BLOCK = prevSecurity;
});

test('appendAlertSnapshot deduplicates repeated alert signatures inside dedup window', () => {
  const prevDedup = state.config.alertDedupWindowMs;
  state.config.alertDedupWindowMs = 60_000;

  state.autopilot = true;
  setMode('live');
  walletLogout();

  runOnce();
  runOnce();

  assert.equal(fs.existsSync(alertsFile), true);
  const lines = fs.readFileSync(alertsFile, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);

  state.config.alertDedupWindowMs = prevDedup;
});

test('critical alerts can notify webhook once per deduplicated snapshot', async () => {
  const prevFetch = global.fetch;
  const prevWebhook = state.config.alertNotifyWebhookUrl;
  const prevMinLevel = state.config.alertNotifyMinLevel;
  const prevDedup = state.config.alertDedupWindowMs;

  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };

  state.config.alertNotifyWebhookUrl = 'https://alerts.test/webhook';
  state.config.alertNotifyMinLevel = 'critical';
  state.config.alertDedupWindowMs = 60_000;

  state.autopilot = true;
  setMode('live');
  walletLogout();

  const alertSnapshot = getAlertStatus();
  assert.equal(shouldNotifyAlertSnapshot(alertSnapshot), true);

  runOnce();
  runOnce();

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://alerts.test/webhook');
  const payload = JSON.parse(calls[0].options.body);
  assert.ok(payload.alerts.some((a) => a.code === 'wallet-session-missing'));

  global.fetch = prevFetch;
  state.config.alertNotifyWebhookUrl = prevWebhook;
  state.config.alertNotifyMinLevel = prevMinLevel;
  state.config.alertDedupWindowMs = prevDedup;
});
