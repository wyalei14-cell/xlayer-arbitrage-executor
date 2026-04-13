const fs = require('fs');
const path = require('path');

const RUNTIME_STATE_FILE = path.join(process.cwd(), 'data', 'runtime-state.json');

const state = {
  autopilot: false,
  config: {
    minNetProfitUsd: 2,
    maxTradeAmountUsd: 300,
    maxSlippagePct: 0.8,
    denyTokens: ['SCAM', 'RUG'],
    scanIntervalMs: 15000,
    tradeAmountUsd: 120,
    maxQuoteAgeMs: 45_000,
    maxExecutionRetries: 2,
    minLegLiquidityUsd: 50_000,
    maxLiquidityUsagePct: 2,
    chainId: 196,
    failClosedOnMissingOnchainOS: true,
    nativeTokenPriceUsd: 45,
    gasSafetyMultiplier: 1.15
  },
  session: {
    mode: 'paper',
    wallet: {
      loggedIn: false,
      provider: null,
      address: null,
      connectedAt: null
    }
  }
};

function now() {
  return Date.now();
}

function isHexAddress(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
}

function loadRuntimeState() {
  if (!fs.existsSync(RUNTIME_STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(RUNTIME_STATE_FILE, 'utf8'));
    if (typeof data.autopilot === 'boolean') state.autopilot = data.autopilot;
    if (data.session && typeof data.session === 'object') {
      state.session.mode = data.session.mode === 'live' ? 'live' : 'paper';
      const wallet = data.session.wallet || {};
      state.session.wallet = {
        loggedIn: Boolean(wallet.loggedIn),
        provider: wallet.provider || null,
        address: wallet.address || null,
        connectedAt: wallet.connectedAt || null
      };
    }
  } catch (_) {
    // fail-closed by ignoring unreadable persisted state
  }
}

function persistRuntimeState() {
  fs.mkdirSync(path.dirname(RUNTIME_STATE_FILE), { recursive: true });
  fs.writeFileSync(
    RUNTIME_STATE_FILE,
    JSON.stringify(
      {
        autopilot: state.autopilot,
        session: state.session
      },
      null,
      2
    )
  );
}

function setAutopilot(enabled) {
  state.autopilot = Boolean(enabled);
  persistRuntimeState();
  return state.autopilot;
}

function setMode(mode) {
  const normalized = String(mode || '').toLowerCase();
  if (!['paper', 'live'].includes(normalized)) throw new Error('invalid mode (expected paper|live)');
  state.session.mode = normalized;
  persistRuntimeState();
  return state.session.mode;
}

function walletLogin({ address, provider = 'agentic-wallet' }) {
  if (!isHexAddress(address)) throw new Error('wallet login failed: invalid address');
  state.session.wallet = {
    loggedIn: true,
    provider,
    address,
    connectedAt: new Date().toISOString()
  };
  persistRuntimeState();
  return state.session.wallet;
}

function walletLogout() {
  state.session.wallet = {
    loggedIn: false,
    provider: null,
    address: null,
    connectedAt: null
  };
  persistRuntimeState();
  return state.session.wallet;
}

function getAdapterMode(name) {
  return String(process.env[name] || 'mock').toLowerCase();
}

function requireEnv(name, reason) {
  const value = process.env[name];
  if (!value) throw new Error(`${reason}: missing ${name}`);
  return value;
}

function walletAdapter() {
  const mode = getAdapterMode('WALLET_ADAPTER');
  if (mode === 'mock') {
    return { provider: 'wallet-mock', address: '0x1111111111111111111111111111111111111111' };
  }
  if (mode === 'live') {
    const sessionAddress = state.session.wallet.loggedIn ? state.session.wallet.address : null;
    const address = sessionAddress || process.env.WALLET_ADDRESS;
    if (!isHexAddress(address)) throw new Error('wallet-check-failed: invalid WALLET_ADDRESS');
    return {
      provider: state.session.wallet.provider || 'wallet-live',
      address
    };
  }
  throw new Error(`wallet-check-failed: unsupported WALLET_ADAPTER=${mode}`);
}

function dexAdapter(opp, wallet) {
  const mode = getAdapterMode('DEX_ADAPTER');
  const routeId = (opp.path || []).join(' | ');
  if (mode === 'mock') {
    return {
      provider: 'dex-mock',
      routeId,
      tx: {
        chainId: state.config.chainId,
        from: wallet.address,
        to: '0x2222222222222222222222222222222222222222',
        data: '0xfeedbeef',
        value: '0x0'
      }
    };
  }
  if (mode === 'live') {
    requireEnv('DEX_QUOTE_URL', 'dex-build-failed');
    requireEnv('DEX_ROUTER_ADDRESS', 'dex-build-failed');
    throw new Error('dex-build-failed: live adapter interface not wired (set DEX_ADAPTER=mock unless integration client is provided)');
  }
  throw new Error(`dex-build-failed: unsupported DEX_ADAPTER=${mode}`);
}

function securityAdapter(opp, txPlan) {
  const mode = getAdapterMode('SECURITY_ADAPTER');
  if (mode === 'mock') {
    if (String(process.env.SECURITY_FORCE_BLOCK || 'false') === 'true') {
      return { provider: 'security-mock', safe: false, riskLevel: 'high', reason: 'forced-block' };
    }
    const denied = state.config.denyTokens.some((t) => (opp.path || []).join('|').includes(t));
    if (denied) return { provider: 'security-mock', safe: false, riskLevel: 'high', reason: 'deny-token' };
    return { provider: 'security-mock', safe: true, riskLevel: 'low', reason: 'ok' };
  }
  if (mode === 'live') {
    requireEnv('SECURITY_SCAN_URL', 'security-scan-failed');
    throw new Error('security-scan-failed: live adapter interface not wired (set SECURITY_ADAPTER=mock unless integration client is provided)');
  }
  throw new Error(`security-scan-failed: unsupported SECURITY_ADAPTER=${mode}`);
}

function onchainGatewayAdapter(txPlan) {
  const mode = getAdapterMode('GATEWAY_ADAPTER');
  if (mode === 'mock') {
    return {
      provider: 'gateway-mock',
      estimate: { gasLimit: 320000, maxFeePerGasGwei: 0.06 },
      simulation: { ok: true, status: 'success' }
    };
  }
  if (mode === 'live') {
    requireEnv('ONCHAIN_GATEWAY_URL', 'gateway-check-failed');
    throw new Error('gateway-check-failed: live adapter interface not wired (set GATEWAY_ADAPTER=mock unless integration client is provided)');
  }
  throw new Error(`gateway-check-failed: unsupported GATEWAY_ADAPTER=${mode}`);
}

function buildOnchainExecutionPlan(opp) {
  try {
    const wallet = walletAdapter();
    const dex = dexAdapter(opp, wallet);
    const security = securityAdapter(opp, dex.tx);
    if (!security.safe) {
      return { ok: false, reason: `security-blocked:${security.reason}`, wallet, dex, security };
    }
    const gateway = onchainGatewayAdapter(dex.tx);
    if (!gateway.estimate?.gasLimit || !gateway.simulation?.ok) {
      return { ok: false, reason: 'gateway-preflight-failed', wallet, dex, security, gateway };
    }
    return {
      ok: true,
      reason: 'ok',
      wallet,
      dex,
      security,
      gateway
    };
  } catch (err) {
    return { ok: false, reason: `onchain-preflight-error:${err.message}` };
  }
}

function mockMarket() {
  const ts = now();
  return [
    { dex: 'UniswapV3', base: 'USDC', quote: 'OKB', price: 1.002, feePct: 0.3, slippagePct: 0.16, liqUsd: 200000, ts },
    { dex: 'SyncSwap', base: 'USDC', quote: 'OKB', price: 0.993, feePct: 0.3, slippagePct: 0.18, liqUsd: 140000, ts },
    { dex: 'Pangea', base: 'USDC', quote: 'ETH', price: 0.00039, feePct: 0.3, slippagePct: 0.2, liqUsd: 180000, ts },
    { dex: 'UniswapV3', base: 'ETH', quote: 'OKB', price: 2580, feePct: 0.3, slippagePct: 0.18, liqUsd: 220000, ts },
    { dex: 'SyncSwap', base: 'OKB', quote: 'USDC', price: 0.996, feePct: 0.3, slippagePct: 0.2, liqUsd: 150000, ts }
  ];
}

async function liveMarket() {
  const url = process.env.QUOTE_ADAPTER_URL;
  if (!url) throw new Error('QUOTE_ADAPTER_URL is required when QUOTE_ADAPTER=live');
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`quote adapter error: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('quote adapter must return array');
  return data;
}

function loadMarketSync() {
  const mode = String(process.env.QUOTE_ADAPTER || 'mock').toLowerCase();
  if (mode !== 'mock') {
    throw new Error('sync scan supports only QUOTE_ADAPTER=mock; use async path for live');
  }
  return mockMarket();
}

function validateQuoteRow(q) {
  const required = ['dex', 'base', 'quote', 'price', 'feePct', 'slippagePct', 'liqUsd', 'ts'];
  for (const k of required) {
    if (q[k] === undefined || q[k] === null) throw new Error(`missing quote field: ${k}`);
  }
  if (typeof q.dex !== 'string' || typeof q.base !== 'string' || typeof q.quote !== 'string') throw new Error('invalid quote tokens');
  if (!(q.price > 0) || !(q.liqUsd > 0)) throw new Error('invalid price/liquidity');
  if (q.ts < now() - state.config.maxQuoteAgeMs) throw new Error('stale quote');
}

function validateMarket(quotes) {
  if (!Array.isArray(quotes) || quotes.length === 0) throw new Error('empty market snapshot');
  quotes.forEach(validateQuoteRow);
  return quotes;
}

function estimateLegCost(amountUsd, feePct, slippagePct) {
  return amountUsd * ((feePct + slippagePct) / 100);
}

function estimateGasCostUsd(gatewayEstimate) {
  if (!gatewayEstimate) return 0;
  const gasLimit = Number(gatewayEstimate.gasLimit || 0);
  const maxFeePerGasGwei = Number(gatewayEstimate.maxFeePerGasGwei || 0);
  const nativeTokenPriceUsd = Number(process.env.NATIVE_TOKEN_PRICE_USD || state.config.nativeTokenPriceUsd || 0);
  if (!(gasLimit > 0) || !(maxFeePerGasGwei > 0) || !(nativeTokenPriceUsd > 0)) return 0;

  const gasNative = gasLimit * maxFeePerGasGwei * 1e-9;
  const baseGasUsd = gasNative * nativeTokenPriceUsd;
  return +(baseGasUsd * state.config.gasSafetyMultiplier).toFixed(6);
}

function evaluateExecutionEconomics(opp, preflight) {
  const grossNetUsd = Number(opp?.netProfitUsd || 0);
  const gasCostUsd = estimateGasCostUsd(preflight?.gateway?.estimate);
  const netAfterGasUsd = +(grossNetUsd - gasCostUsd).toFixed(4);
  return { grossNetUsd, gasCostUsd, netAfterGasUsd };
}

function liquidityBoundedAmount(legs) {
  const minLiqUsd = Math.min(...legs.map((x) => x.liqUsd));
  const maxByLiquidity = minLiqUsd * (state.config.maxLiquidityUsagePct / 100);
  return Math.min(state.config.tradeAmountUsd, maxByLiquidity, state.config.maxTradeAmountUsd);
}

function detectTwoPool(quotes) {
  const buckets = new Map();
  for (const q of quotes) {
    const pair = [q.base, q.quote].sort().join('/');
    if (!buckets.has(pair)) buckets.set(pair, []);
    buckets.get(pair).push(q);
  }

  const out = [];
  for (const [, rows] of buckets.entries()) {
    if (rows.length < 2) continue;
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        const tradeAmountUsd = liquidityBoundedAmount([a, b]);
        if (tradeAmountUsd <= 0) continue;
        const spread = Math.abs(a.price - b.price) / Math.min(a.price, b.price);
        const gross = tradeAmountUsd * spread;
        const fee = estimateLegCost(tradeAmountUsd, a.feePct + b.feePct, 0);
        const slip = estimateLegCost(tradeAmountUsd, 0, a.slippagePct + b.slippagePct);
        const net = +(gross - fee - slip).toFixed(4);

        out.push({
          type: 'two-pool',
          path: [`${a.base}->${a.quote}@${a.dex}`, `${b.quote}->${b.base}@${b.dex}`],
          legs: [a, b],
          tradeAmountUsd: +tradeAmountUsd.toFixed(4),
          grossProfitUsd: +gross.toFixed(4),
          feeUsd: +fee.toFixed(4),
          slippageUsd: +slip.toFixed(4),
          netProfitUsd: net
        });
      }
    }
  }
  return out;
}

function edgeOut(q, tokenIn, amountIn) {
  if (q.base === tokenIn) {
    const gross = amountIn * q.price;
    return gross * (1 - (q.feePct + q.slippagePct) / 100);
  }
  if (q.quote === tokenIn) {
    const gross = amountIn / q.price;
    return gross * (1 - (q.feePct + q.slippagePct) / 100);
  }
  return null;
}

function detectTriangular(quotes) {
  const tokens = Array.from(new Set(quotes.flatMap((q) => [q.base, q.quote])));
  const out = [];
  const startToken = 'USDC';

  for (const t1 of tokens) {
    if (t1 === startToken) continue;
    for (const t2 of tokens) {
      if (t2 === startToken || t2 === t1) continue;
      const leg1 = quotes.filter((q) => [q.base, q.quote].includes(startToken) && [q.base, q.quote].includes(t1));
      const leg2 = quotes.filter((q) => [q.base, q.quote].includes(t1) && [q.base, q.quote].includes(t2));
      const leg3 = quotes.filter((q) => [q.base, q.quote].includes(t2) && [q.base, q.quote].includes(startToken));
      for (const a of leg1) for (const b of leg2) for (const c of leg3) {
        const tradeAmountUsd = liquidityBoundedAmount([a, b, c]);
        if (tradeAmountUsd <= 0) continue;
        const out1 = edgeOut(a, startToken, tradeAmountUsd);
        const out2 = out1 ? edgeOut(b, t1, out1) : null;
        const out3 = out2 ? edgeOut(c, t2, out2) : null;
        if (!out3) continue;

        const gross = Math.max(0, out3 - tradeAmountUsd);
        const fee = estimateLegCost(tradeAmountUsd, a.feePct + b.feePct + c.feePct, 0);
        const slip = estimateLegCost(tradeAmountUsd, 0, a.slippagePct + b.slippagePct + c.slippagePct);
        const net = +(gross - fee - slip).toFixed(4);
        out.push({
          type: 'triangular',
          path: [`${startToken}->${t1}@${a.dex}`, `${t1}->${t2}@${b.dex}`, `${t2}->${startToken}@${c.dex}`],
          legs: [a, b, c],
          tradeAmountUsd: +tradeAmountUsd.toFixed(4),
          grossProfitUsd: +gross.toFixed(4),
          feeUsd: +fee.toFixed(4),
          slippageUsd: +slip.toFixed(4),
          netProfitUsd: net
        });
      }
    }
  }

  const seen = new Set();
  return out.filter((x) => {
    const k = x.path.join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function scanOpportunities() {
  const quotes = validateMarket(loadMarketSync());
  const opportunities = [...detectTwoPool(quotes), ...detectTriangular(quotes)];
  return opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}

function riskCheck(opp) {
  if (!opp) return { pass: false, reason: 'no-opportunity' };
  if (state.config.denyTokens.some((t) => opp.path.join('|').includes(t))) return { pass: false, reason: 'deny-token' };
  if ((opp.tradeAmountUsd || 0) > state.config.maxTradeAmountUsd) return { pass: false, reason: 'trade-amount-too-high' };
  if ((opp.tradeAmountUsd || 0) <= 0) return { pass: false, reason: 'trade-amount-invalid' };
  if ((opp.legs || []).some((leg) => leg.liqUsd < state.config.minLegLiquidityUsd)) return { pass: false, reason: 'liquidity-too-low' };
  const impliedSlippagePct = 100 * (opp.slippageUsd / opp.tradeAmountUsd);
  if (impliedSlippagePct > state.config.maxSlippagePct) return { pass: false, reason: 'slippage-too-high' };
  if (opp.netProfitUsd < state.config.minNetProfitUsd) return { pass: false, reason: 'profit-too-low' };
  return { pass: true, reason: 'ok' };
}

function executeOpportunity(opp) {
  const rechecked = { ...opp, recheckTs: now() };

  if (state.session.mode === 'paper') {
    const paperGasCostUsd = +(Math.max(0.01, rechecked.tradeAmountUsd * 0.0005)).toFixed(4);
    const paperNetAfterGasUsd = +((rechecked.netProfitUsd || 0) - paperGasCostUsd).toFixed(4);
    if (paperNetAfterGasUsd < state.config.minNetProfitUsd) {
      return {
        success: false,
        txHash: null,
        realizedProfitUsd: 0,
        reason: 'profit-too-low-after-gas',
        gasCostUsd: paperGasCostUsd,
        netAfterGasUsd: paperNetAfterGasUsd,
        preflight: { ok: true, reason: 'paper-mode', provider: 'paper-executor' }
      };
    }

    const paperHash = 'paper-' + Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 16);
    return {
      success: true,
      txHash: paperHash,
      realizedProfitUsd: +(paperNetAfterGasUsd * 0.92).toFixed(4),
      reason: 'paper-filled',
      gasCostUsd: paperGasCostUsd,
      netAfterGasUsd: paperNetAfterGasUsd,
      preflight: { ok: true, reason: 'paper-mode', provider: 'paper-executor' }
    };
  }

  const preflight = buildOnchainExecutionPlan(rechecked);
  const economics = evaluateExecutionEconomics(rechecked, preflight);
  if (!preflight.ok && state.config.failClosedOnMissingOnchainOS) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: preflight.reason,
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
      preflight
    };
  }

  if (economics.netAfterGasUsd < state.config.minNetProfitUsd) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: 'profit-too-low-after-gas',
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
      preflight
    };
  }

  for (let attempt = 0; attempt <= state.config.maxExecutionRetries; attempt++) {
    if (rechecked.netProfitUsd <= 0) {
      return { success: false, txHash: null, realizedProfitUsd: 0, reason: 'recheck-failed', gasCostUsd: economics.gasCostUsd, netAfterGasUsd: economics.netAfterGasUsd, preflight };
    }
    const txHash = '0x' + Buffer.from(`${Date.now()}-${attempt}`).toString('hex').slice(0, 64).padEnd(64, '0');
    return {
      success: true,
      txHash,
      realizedProfitUsd: +(economics.netAfterGasUsd * 0.92).toFixed(4),
      reason: `executed-attempt-${attempt + 1}`,
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
      preflight
    };
  }
  return { success: false, txHash: null, realizedProfitUsd: 0, reason: 'execution-retries-exhausted', gasCostUsd: economics.gasCostUsd, netAfterGasUsd: economics.netAfterGasUsd, preflight };
}

function appendRecord(obj) {
  const file = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readExecutionLedger(limit = 200) {
  const file = path.join(process.cwd(), 'data', 'executions.jsonl');
  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, 'utf8').trim();
  if (!raw) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .slice(-Math.max(1, limit))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function getPnlMetrics({ limit = 200 } = {}) {
  const rows = readExecutionLedger(limit);
  const trades = rows.filter((r) => r.routeType !== 'none');
  const executed = trades.filter((r) => r.success);
  const totalRealizedPnlUsd = +rows.reduce((s, r) => s + (r.realizedProfitUsd || 0), 0).toFixed(4);
  const totalGasCostUsd = +rows.reduce((s, r) => s + (r.gasCostUsd || 0), 0).toFixed(4);
  const avgRealizedPnlUsd = +(totalRealizedPnlUsd / Math.max(executed.length, 1)).toFixed(4);

  const byMode = rows.reduce(
    (acc, r) => {
      const mode = r.mode === 'live' ? 'live' : 'paper';
      acc[mode].runs += 1;
      acc[mode].realizedPnlUsd = +(acc[mode].realizedPnlUsd + (r.realizedProfitUsd || 0)).toFixed(4);
      if (r.success) acc[mode].executed += 1;
      return acc;
    },
    {
      paper: { runs: 0, executed: 0, realizedPnlUsd: 0 },
      live: { runs: 0, executed: 0, realizedPnlUsd: 0 }
    }
  );

  const lastRecord = rows.at(-1) || null;

  return {
    sampleSize: rows.length,
    opportunitiesSeen: trades.length,
    executedCount: executed.length,
    executionRate: +(executed.length / Math.max(trades.length, 1)).toFixed(4),
    totalRealizedPnlUsd,
    totalGasCostUsd,
    avgRealizedPnlUsd,
    byMode,
    recent: rows.slice(-20),
    lastRecord
  };
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
  let opportunities = [];
  let selected = null;

  try {
    opportunities = scanOpportunities();
    const assessed = opportunities.map((opp) => ({ opp, risk: riskCheck(opp) }));
    selected = assessed.find((x) => x.risk.pass) || assessed[0] || { opp: null, risk: { pass: false, reason: 'no-opportunity' } };
  } catch (err) {
    const failRecord = {
      ts: new Date().toISOString(),
      routeType: 'none',
      path: [],
      quoteSnapshot: null,
      grossProfitUsd: 0,
      feeUsd: 0,
      slippageUsd: 0,
      netProfitUsd: 0,
      txHash: null,
      success: false,
      realizedProfitUsd: 0,
      mode: state.session.mode,
      reason: `scan-error:${err.message}`
    };
    appendRecord(failRecord);
    return { config: state.config, opportunities: [], record: failRecord, autopilot: state.autopilot, session: state.session };
  }

  let result = { success: false, txHash: null, realizedProfitUsd: 0, reason: selected.risk.reason };
  if (selected.risk.pass && state.autopilot) {
    if (state.session.mode === 'live' && !state.session.wallet.loggedIn) {
      result = { success: false, txHash: null, realizedProfitUsd: 0, reason: 'wallet-not-logged-in' };
    } else {
      result = executeOpportunity(selected.opp);
    }
  }

  const record = {
    ts: new Date().toISOString(),
    routeType: selected.opp?.type || 'none',
    path: selected.opp?.path || [],
    quoteSnapshot: selected.opp?.legs || null,
    grossProfitUsd: selected.opp?.grossProfitUsd || 0,
    feeUsd: selected.opp?.feeUsd || 0,
    slippageUsd: selected.opp?.slippageUsd || 0,
    netProfitUsd: selected.opp?.netProfitUsd || 0,
    gasCostUsd: result.gasCostUsd || 0,
    netAfterGasUsd: result.netAfterGasUsd || 0,
    tradeAmountUsd: selected.opp?.tradeAmountUsd || 0,
    consideredCount: opportunities.length,
    mode: state.session.mode,
    walletAddress: state.session.wallet.address,
    onchainPreflight: result.preflight || null,
    ...result
  };
  appendRecord(record);
  optimizeFromHistory();

  return { config: state.config, opportunities, selected: selected.opp, record, autopilot: state.autopilot, session: state.session };
}

loadRuntimeState();

module.exports = {
  state,
  runOnce,
  scanOpportunities,
  optimizeFromHistory,
  validateMarket,
  detectTwoPool,
  detectTriangular,
  riskCheck,
  executeOpportunity,
  buildOnchainExecutionPlan,
  liveMarket,
  loadRuntimeState,
  persistRuntimeState,
  setAutopilot,
  setMode,
  walletLogin,
  walletLogout,
  readExecutionLedger,
  getPnlMetrics
};