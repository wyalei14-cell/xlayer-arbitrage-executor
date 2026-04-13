const fs = require('fs');
const path = require('path');

const state = {
  autopilot: false,
  config: {
    minNetProfitUsd: 2,
    maxTradeAmountUsd: 300,
    maxSlippagePct: 0.8,
    denyTokens: ['SCAM', 'RUG'],
    scanIntervalMs: 15000,
    tradeAmountUsd: 120
  }
};

function mockMarket() {
  return [
    { dex: 'UniswapV3', pair: 'USDC/OKB', price: 1.002, liq: 200000 },
    { dex: 'SyncSwap', pair: 'USDC/OKB', price: 0.993, liq: 140000 },
    { dex: 'Pangea', pair: 'USDC/ETH', price: 0.00039, liq: 180000 },
    { dex: 'UniswapV3', pair: 'ETH/OKB', price: 2580, liq: 220000 }
  ];
}

function scanOpportunities() {
  const m = mockMarket();
  const twoPoolSpread = Math.abs(m[0].price - m[1].price) / Math.min(m[0].price, m[1].price);
  const twoPool = {
    type: 'two-pool',
    path: ['USDC->OKB@SyncSwap', 'OKB->USDC@UniswapV3'],
    grossProfitUsd: +(state.config.tradeAmountUsd * twoPoolSpread).toFixed(4),
    feeUsd: +(state.config.tradeAmountUsd * 0.003).toFixed(4),
    slippageUsd: +(state.config.tradeAmountUsd * 0.0018).toFixed(4)
  };
  twoPool.netProfitUsd = +(twoPool.grossProfitUsd - twoPool.feeUsd - twoPool.slippageUsd).toFixed(4);

  const tri = {
    type: 'triangular',
    path: ['USDC->ETH@Pangea', 'ETH->OKB@UniswapV3', 'OKB->USDC@SyncSwap'],
    grossProfitUsd: +(state.config.tradeAmountUsd * 0.018).toFixed(4),
    feeUsd: +(state.config.tradeAmountUsd * 0.004).toFixed(4),
    slippageUsd: +(state.config.tradeAmountUsd * 0.0022).toFixed(4)
  };
  tri.netProfitUsd = +(tri.grossProfitUsd - tri.feeUsd - tri.slippageUsd).toFixed(4);

  return [twoPool, tri].sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}

function riskCheck(opp) {
  if (state.config.denyTokens.some((t) => opp.path.join('|').includes(t))) return { pass: false, reason: 'deny-token' };
  if (state.config.tradeAmountUsd > state.config.maxTradeAmountUsd) return { pass: false, reason: 'trade-amount-too-high' };
  const impliedSlippagePct = 100 * (opp.slippageUsd / state.config.tradeAmountUsd);
  if (impliedSlippagePct > state.config.maxSlippagePct) return { pass: false, reason: 'slippage-too-high' };
  if (opp.netProfitUsd < state.config.minNetProfitUsd) return { pass: false, reason: 'profit-too-low' };
  return { pass: true, reason: 'ok' };
}

function executeOpportunity(opp) {
  const rechecked = { ...opp, recheckTs: Date.now() };
  const txHash = '0x' + Buffer.from(String(Date.now())).toString('hex').slice(0, 64).padEnd(64, '0');
  return {
    success: true,
    txHash,
    realizedProfitUsd: +(rechecked.netProfitUsd * 0.92).toFixed(4),
    reason: 'executed'
  };
}

function appendRecord(obj) {
  const file = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function optimizeFromHistory() {
  const file = path.join(process.cwd(), 'data', 'executions.jsonl');
  if (!fs.existsSync(file)) return state.config;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-20);
  const rows = lines.map((x) => JSON.parse(x));
  const successRate = rows.filter((r) => r.success).length / Math.max(rows.length, 1);
  const avgPnl = rows.reduce((s, r) => s + (r.realizedProfitUsd || 0), 0) / Math.max(rows.length, 1);

  if (successRate < 0.6) state.config.minNetProfitUsd = +(state.config.minNetProfitUsd + 0.5).toFixed(2);
  if (avgPnl > 3) state.config.tradeAmountUsd = Math.min(state.config.tradeAmountUsd + 20, state.config.maxTradeAmountUsd);
  if (successRate > 0.8) state.config.scanIntervalMs = Math.max(8000, state.config.scanIntervalMs - 1000);
  return state.config;
}

function runOnce() {
  const opportunities = scanOpportunities();
  const best = opportunities[0];
  const risk = riskCheck(best);
  let result = { success: false, txHash: null, realizedProfitUsd: 0, reason: risk.reason };

  if (risk.pass && state.autopilot) {
    result = executeOpportunity(best);
  }

  const record = {
    ts: new Date().toISOString(),
    routeType: best.type,
    path: best.path,
    grossProfitUsd: best.grossProfitUsd,
    feeUsd: best.feeUsd,
    slippageUsd: best.slippageUsd,
    netProfitUsd: best.netProfitUsd,
    ...result
  };
  appendRecord(record);
  optimizeFromHistory();

  return { config: state.config, opportunities, record, autopilot: state.autopilot };
}

module.exports = { state, runOnce, scanOpportunities, optimizeFromHistory };
