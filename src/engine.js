const fs = require('fs');
const path = require('path');

const RUNTIME_STATE_FILE = path.join(process.cwd(), 'data', 'runtime-state.json');

const streamingCache = {
  initialized: false,
  listenersStarted: false,
  wsQuotes: [],
  pendingTxs: [],
  wsUpdatedAt: null,
  mempoolUpdatedAt: null,
  wsSocket: null,
  mempoolSocket: null,
  wsReconnectTimer: null,
  mempoolReconnectTimer: null
};

const alertCache = {
  lastSignature: null,
  lastTs: 0
};

const executionLock = {
  active: false,
  sinceMs: 0
};

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
    gasSafetyMultiplier: 1.15,
    preflightInPaper: true,
    preferAtomicExecution: true,
    flashLoanMinUsd: 250,
    enableStreamingSignals: true,
    wsQuoteFile: path.join(process.cwd(), 'data', 'ws-quotes.json'),
    mempoolFile: path.join(process.cwd(), 'data', 'mempool.json'),
    wsQuoteSocketUrl: process.env.WS_QUOTES_URL || '',
    mempoolSocketUrl: process.env.MEMPOOL_WS_URL || '',
    maxWsSignalAgeMs: Number(process.env.MAX_WS_SIGNAL_AGE_MS || 12_000),
    maxMempoolSignalAgeMs: Number(process.env.MAX_MEMPOOL_SIGNAL_AGE_MS || 15_000),
    streamingBootstrapGraceMs: Number(process.env.STREAMING_BOOTSTRAP_GRACE_MS || 30_000),
    mempoolSlippageBpsPerPendingTx: 2,
    mempoolGasMultiplierPerPendingTx: 0.015,
    maxMempoolGasMultiplier: 2,
    routeComplexityPenaltyUsdPerHop: 0.2,
    routeDexDiversityBonusUsd: 0.05,
    assumedGasPerSwapHop: Number(process.env.ASSUMED_GAS_PER_SWAP_HOP || 135000),
    assumedBaseGas: Number(process.env.ASSUMED_BASE_GAS || 105000),
    assumedGasPriceGwei: Number(process.env.ASSUMED_GAS_PRICE_GWEI || 0.06),
    routerFeeBps: 1,
    bundleFeeUsd: 0.15,
    flashLoanFeeBps: 5,
    alertWindow: 20,
    alertMaxConsecutiveFailures: 5,
    alertFailureReasonBurstCount: Number(process.env.ALERT_FAILURE_REASON_BURST_COUNT || 4),
    alertMinExecutionRate: 0.2,
    alertMinRecentPnlUsd: -5,
    alertMaxGasCostShare: 0.6,
    maxExecutionGasCostShare: Number(process.env.MAX_EXECUTION_GAS_COST_SHARE || 0.7),
    alertMaxGasPressureMultiplier: Number(process.env.ALERT_MAX_GAS_PRESSURE_MULTIPLIER || 1.6),
    alertMaxPreflightLatencyMs: Number(process.env.ALERT_MAX_PREFLIGHT_LATENCY_MS || 2_500),
    maxPreflightLatencyMs: Number(process.env.MAX_PREFLIGHT_LATENCY_MS || 5_000),
    alertMaxDailyLossUsd: Number(process.env.ALERT_MAX_DAILY_LOSS_USD || -20),
    maxDailyLossUsd: Number(process.env.MAX_DAILY_LOSS_USD || -30),
    alertDedupWindowMs: Number(process.env.ALERT_DEDUP_WINDOW_MS || 60_000),
    failClosedOnCriticalAlerts: String(process.env.FAIL_CLOSED_ON_CRITICAL_ALERTS || 'true') === 'true',
    alertNotifyWebhookUrl: process.env.ALERT_NOTIFY_WEBHOOK_URL || '',
    alertNotifyMinLevel: String(process.env.ALERT_NOTIFY_MIN_LEVEL || 'critical').toLowerCase(),
    alertNotifyTimeoutMs: Number(process.env.ALERT_NOTIFY_TIMEOUT_MS || 3000),
    executionLockTtlMs: Number(process.env.EXECUTION_LOCK_TTL_MS || 120_000)
  },
  session: {
    mode: 'paper',
    wallet: {
      loggedIn: false,
      provider: null,
      address: null,
      connectedAt: null
    }
  },
  runtimeSignals: {
    quoteSource: 'mock',
    wsQuoteCount: 0,
    pendingMempoolTxs: 0,
    wsDroppedStale: 0,
    mempoolDroppedStale: 0,
    gasPressureMultiplier: 1,
    listenerMode: 'poll',
    listenersStartedAt: null,
    wsUpdatedAt: null,
    mempoolUpdatedAt: null,
    executionLockActive: false,
    executionLockSince: null,
    executionLockAgeMs: 0
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

function dexAdapter(opp, wallet, routerPlan) {
  const mode = getAdapterMode('DEX_ADAPTER');
  const routeId = (opp.path || []).join(' | ');
  if (mode === 'mock') {
    return {
      provider: 'dex-mock',
      routeId,
      routerPlan,
      tx: {
        chainId: state.config.chainId,
        from: wallet.address,
        to: '0x2222222222222222222222222222222222222222',
        data: `0xfeedbeef${String(routerPlan?.hopCount || 0).padStart(2, '0')}`,
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
    const forceSimFail = String(process.env.GATEWAY_FORCE_SIM_FAIL || 'false') === 'true';
    const forceMissingGas = String(process.env.GATEWAY_FORCE_MISSING_GAS || 'false') === 'true';

    return {
      provider: 'gateway-mock',
      estimate: {
        gasLimit: forceMissingGas ? 0 : 320000,
        maxFeePerGasGwei: 0.06
      },
      simulation: forceSimFail
        ? { ok: false, status: 'revert', reason: 'forced-simulation-failure' }
        : { ok: true, status: 'success' }
    };
  }
  if (mode === 'live') {
    requireEnv('ONCHAIN_GATEWAY_URL', 'gateway-check-failed');
    throw new Error('gateway-check-failed: live adapter interface not wired (set GATEWAY_ADAPTER=mock unless integration client is provided)');
  }
  throw new Error(`gateway-check-failed: unsupported GATEWAY_ADAPTER=${mode}`);
}

function buildAtomicExecutionPlan(opp, wallet, dex, gateway) {
  const forceDisable = String(process.env.ATOMIC_FORCE_DISABLE || 'false') === 'true';
  const routeLegs = Array.isArray(opp?.path) ? opp.path : [];
  const fundingMode = (opp?.tradeAmountUsd || 0) >= state.config.flashLoanMinUsd ? 'flash-loan-ready' : 'wallet-balance';

  return {
    required: Boolean(state.config.preferAtomicExecution),
    ready: !forceDisable,
    strategy: state.config.preferAtomicExecution ? 'bundle' : 'direct',
    fundingMode,
    routeLegs,
    tx: {
      chainId: dex?.tx?.chainId,
      from: wallet?.address,
      to: dex?.tx?.to,
      gasLimit: gateway?.estimate?.gasLimit || null
    },
    reason: forceDisable ? 'atomic-disabled-by-env' : 'ok'
  };
}

function buildOnchainExecutionPlan(opp) {
  const startedAtMs = now();
  const telemetry = {
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    stage: 'init',
    stages: []
  };

  const markStage = (name, status, startedMs, detail = null) => {
    telemetry.stages.push({
      name,
      status,
      durationMs: Math.max(0, now() - startedMs),
      detail
    });
    telemetry.stage = name;
  };

  const finalize = (result) => {
    telemetry.durationMs = Math.max(0, now() - startedAtMs);
    return { ...result, telemetry };
  };

  try {
    const walletStartedMs = now();
    const wallet = walletAdapter();
    markStage('wallet', 'ok', walletStartedMs, { provider: wallet.provider, address: wallet.address });

    const routerStartedMs = now();
    const routerPlan = buildRouterPlan(opp);
    if (!routerPlan.ok) {
      markStage('router', 'error', routerStartedMs, { reason: routerPlan.reason });
      return finalize({ ok: false, reason: `router-build-failed:${routerPlan.reason}`, wallet, routerPlan });
    }
    markStage('router', 'ok', routerStartedMs, { provider: routerPlan.provider, hopCount: routerPlan.hopCount });

    const dexStartedMs = now();
    const dex = dexAdapter(opp, wallet, routerPlan);
    markStage('dex-build', 'ok', dexStartedMs, { provider: dex.provider, routeId: dex.routeId });

    const securityStartedMs = now();
    const security = securityAdapter(opp, dex.tx);
    if (!security.safe) {
      markStage('security-scan', 'blocked', securityStartedMs, { reason: security.reason, riskLevel: security.riskLevel });
      return finalize({ ok: false, reason: `security-blocked:${security.reason}`, wallet, dex, security });
    }
    markStage('security-scan', 'ok', securityStartedMs, { provider: security.provider, riskLevel: security.riskLevel });

    const gatewayStartedMs = now();
    const gateway = onchainGatewayAdapter(dex.tx);
    if (!gateway.estimate?.gasLimit || !gateway.simulation?.ok) {
      markStage('gateway-preflight', 'error', gatewayStartedMs, {
        gasLimit: gateway.estimate?.gasLimit || null,
        simulationOk: Boolean(gateway.simulation?.ok)
      });
      return finalize({ ok: false, reason: 'gateway-preflight-failed', wallet, dex, security, gateway });
    }
    markStage('gateway-preflight', 'ok', gatewayStartedMs, {
      provider: gateway.provider,
      gasLimit: gateway.estimate.gasLimit
    });

    const atomicStartedMs = now();
    const atomic = buildAtomicExecutionPlan(opp, wallet, dex, gateway);
    if (atomic.required && !atomic.ready) {
      markStage('atomic-plan', 'error', atomicStartedMs, { reason: atomic.reason, strategy: atomic.strategy });
      return finalize({ ok: false, reason: `atomic-preflight-failed:${atomic.reason}`, wallet, dex, security, gateway, atomic });
    }
    markStage('atomic-plan', 'ok', atomicStartedMs, { strategy: atomic.strategy, fundingMode: atomic.fundingMode });

    return finalize({
      ok: true,
      reason: 'ok',
      wallet,
      dex,
      security,
      gateway,
      atomic
    });
  } catch (err) {
    telemetry.stages.push({
      name: telemetry.stage === 'init' ? 'wallet' : telemetry.stage,
      status: 'error',
      durationMs: 0,
      detail: { reason: err.message }
    });
    telemetry.stage = 'error';
    return finalize({ ok: false, reason: `onchain-preflight-error:${err.message}` });
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

function readArrayFileSafe(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function filterStaleSignals(rows, maxAgeMs) {
  const out = [];
  let dropped = 0;
  const cutoff = now() - Math.max(0, Number(maxAgeMs) || 0);

  for (const row of rows || []) {
    const ts = Number(row?.ts || 0);
    if (!(ts > 0) || ts < cutoff) {
      dropped += 1;
      continue;
    }
    out.push(row);
  }

  return { rows: out, dropped };
}

function parseRealtimePayload(raw) {
  let parsed = null;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) {
    return [];
  }

  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  if (parsed.data && typeof parsed.data === 'object') return [parsed.data];
  return [parsed];
}

function normalizeQuoteRows(rows) {
  return rows
    .map((row) => ({
      dex: row.dex,
      base: row.base,
      quote: row.quote,
      price: Number(row.price),
      feePct: Number(row.feePct),
      slippagePct: Number(row.slippagePct),
      liqUsd: Number(row.liqUsd),
      ts: Number(row.ts || now())
    }))
    .filter((row) => row.dex && row.base && row.quote && row.price > 0 && row.liqUsd > 0);
}

function normalizeMempoolRows(rows) {
  return rows
    .map((row) => ({
      tokenIn: row.tokenIn || row.base,
      tokenOut: row.tokenOut || row.quote,
      ts: Number(row.ts || now())
    }))
    .filter((row) => row.tokenIn && row.tokenOut);
}

function refreshStreamingOverlay() {
  const wsRaw = readArrayFileSafe(state.config.wsQuoteFile);
  const mempoolRaw = readArrayFileSafe(state.config.mempoolFile);

  const ws = filterStaleSignals(wsRaw, state.config.maxWsSignalAgeMs);
  const mempool = filterStaleSignals(mempoolRaw, state.config.maxMempoolSignalAgeMs);

  if (ws.rows.length || !streamingCache.wsQuotes.length) {
    streamingCache.wsQuotes = ws.rows;
    streamingCache.wsUpdatedAt = new Date().toISOString();
  }

  if (mempool.rows.length || !streamingCache.pendingTxs.length) {
    streamingCache.pendingTxs = mempool.rows;
    streamingCache.mempoolUpdatedAt = new Date().toISOString();
  }

  state.runtimeSignals.wsDroppedStale = ws.dropped;
  state.runtimeSignals.mempoolDroppedStale = mempool.dropped;
}

function reloadStreamingCacheFromFiles() {
  refreshStreamingOverlay();
  streamingCache.initialized = true;
}

function closeSocket(socket) {
  if (!socket) return;
  try {
    socket.close();
  } catch (_) {
    // ignore close failures
  }
}

function resetStreamingSignalCache() {
  fs.unwatchFile(state.config.wsQuoteFile);
  fs.unwatchFile(state.config.mempoolFile);
  if (streamingCache.wsReconnectTimer) clearTimeout(streamingCache.wsReconnectTimer);
  if (streamingCache.mempoolReconnectTimer) clearTimeout(streamingCache.mempoolReconnectTimer);
  closeSocket(streamingCache.wsSocket);
  closeSocket(streamingCache.mempoolSocket);

  streamingCache.initialized = false;
  streamingCache.listenersStarted = false;
  streamingCache.wsQuotes = [];
  streamingCache.pendingTxs = [];
  streamingCache.wsUpdatedAt = null;
  streamingCache.mempoolUpdatedAt = null;
  streamingCache.wsSocket = null;
  streamingCache.mempoolSocket = null;
  streamingCache.wsReconnectTimer = null;
  streamingCache.mempoolReconnectTimer = null;
  state.runtimeSignals.wsDroppedStale = 0;
  state.runtimeSignals.mempoolDroppedStale = 0;
  state.runtimeSignals.listenersStartedAt = null;
}

function resetAlertSnapshotCache() {
  alertCache.lastSignature = null;
  alertCache.lastTs = 0;
}

function scheduleSocketReconnect(kind, connectFn) {
  const key = kind === 'ws' ? 'wsReconnectTimer' : 'mempoolReconnectTimer';
  if (streamingCache[key]) clearTimeout(streamingCache[key]);
  streamingCache[key] = setTimeout(() => {
    streamingCache[key] = null;
    connectFn();
  }, 2000);
}

function startSocketListener({ kind, url, onRows }) {
  if (!url || typeof WebSocket === 'undefined') return false;

  const socketKey = kind === 'ws' ? 'wsSocket' : 'mempoolSocket';
  const connect = () => {
    const socket = new WebSocket(url);
    streamingCache[socketKey] = socket;

    socket.addEventListener('message', (event) => {
      const rows = onRows(parseRealtimePayload(event.data));
      if (rows.length === 0) return;
      const filtered = filterStaleSignals(
        rows,
        kind === 'ws' ? state.config.maxWsSignalAgeMs : state.config.maxMempoolSignalAgeMs
      );

      if (kind === 'ws') {
        streamingCache.wsQuotes = filtered.rows;
        streamingCache.wsUpdatedAt = new Date().toISOString();
        state.runtimeSignals.wsDroppedStale = (state.runtimeSignals.wsDroppedStale || 0) + filtered.dropped;
      } else {
        streamingCache.pendingTxs = filtered.rows;
        streamingCache.mempoolUpdatedAt = new Date().toISOString();
        state.runtimeSignals.mempoolDroppedStale = (state.runtimeSignals.mempoolDroppedStale || 0) + filtered.dropped;
      }
    });

    socket.addEventListener('close', () => {
      if (streamingCache.listenersStarted) scheduleSocketReconnect(kind, connect);
    });

    socket.addEventListener('error', () => {
      closeSocket(socket);
    });
  };

  connect();
  return true;
}

function startStreamingSignalListeners() {
  if (!state.config.enableStreamingSignals || streamingCache.listenersStarted) return;

  fs.mkdirSync(path.dirname(state.config.wsQuoteFile), { recursive: true });
  reloadStreamingCacheFromFiles();

  const wsSocketActive = startSocketListener({
    kind: 'ws',
    url: state.config.wsQuoteSocketUrl,
    onRows: normalizeQuoteRows
  });

  const mempoolSocketActive = startSocketListener({
    kind: 'mempool',
    url: state.config.mempoolSocketUrl,
    onRows: normalizeMempoolRows
  });

  if (!wsSocketActive) {
    fs.watchFile(state.config.wsQuoteFile, { interval: 1000, persistent: false }, () => {
      refreshStreamingOverlay();
    });
  }

  if (!mempoolSocketActive) {
    fs.watchFile(state.config.mempoolFile, { interval: 1000, persistent: false }, () => {
      refreshStreamingOverlay();
    });
  }

  streamingCache.listenersStarted = true;
  state.runtimeSignals.listenersStartedAt = new Date().toISOString();
}

function quoteKey(q) {
  return [q.dex, q.base, q.quote].join('|');
}

function mergeQuotes(baseQuotes, wsQuotes) {
  if (!wsQuotes.length) return baseQuotes;
  const out = new Map(baseQuotes.map((q) => [quoteKey(q), q]));
  for (const q of wsQuotes) out.set(quoteKey(q), q);
  return Array.from(out.values());
}

function pairFromPathLeg(pathLeg) {
  const route = String(pathLeg || '').split('@')[0];
  const [a, b] = route.split('->');
  return [a, b].sort().join('/');
}

function parsePathLeg(pathLeg) {
  const [route, dex = 'unknown'] = String(pathLeg || '').split('@');
  const [tokenIn, tokenOut] = String(route || '').split('->');
  return {
    tokenIn: tokenIn || null,
    tokenOut: tokenOut || null,
    dex: dex || 'unknown'
  };
}

function buildRouterPlan(opp) {
  const hops = (opp?.path || []).map((leg, idx) => ({
    index: idx,
    ...parsePathLeg(leg)
  }));

  if (!hops.length || hops.some((h) => !h.tokenIn || !h.tokenOut)) {
    return { ok: false, reason: 'invalid-route-legs', hops: [] };
  }

  const entryToken = hops[0].tokenIn;
  const exitToken = hops[hops.length - 1].tokenOut;
  const expectedReturnUsd = +((opp?.tradeAmountUsd || 0) + (opp?.grossProfitUsd || 0) - (opp?.feeUsd || 0) - (opp?.slippageUsd || 0)).toFixed(6);
  const minReturnUsd = +(expectedReturnUsd * (1 - state.config.maxSlippagePct / 100)).toFixed(6);

  return {
    ok: true,
    reason: 'ok',
    provider: process.env.ROUTER_PROVIDER || 'onchainos-router',
    routeType: hops.length === 1 ? 'single-hop' : 'multi-hop',
    entryToken,
    exitToken,
    hopCount: hops.length,
    hops,
    expectedReturnUsd,
    minReturnUsd
  };
}

function applyMempoolPressure(opportunities, pendingTxs) {
  if (!pendingTxs.length) return opportunities;
  const pairPressure = new Map();

  for (const tx of pendingTxs) {
    const base = tx.base || tx.tokenIn;
    const quote = tx.quote || tx.tokenOut;
    if (!base || !quote) continue;
    const key = [base, quote].sort().join('/');
    pairPressure.set(key, (pairPressure.get(key) || 0) + 1);
  }

  return opportunities.map((opp) => {
    const touched = (opp.path || []).reduce((sum, leg) => sum + (pairPressure.get(pairFromPathLeg(leg)) || 0), 0);
    if (!touched) return opp;

    const extraSlippageUsd = +((opp.tradeAmountUsd || 0) * ((state.config.mempoolSlippageBpsPerPendingTx * touched) / 10_000)).toFixed(4);
    const netProfitUsd = +((opp.netProfitUsd || 0) - extraSlippageUsd).toFixed(4);

    return {
      ...opp,
      slippageUsd: +((opp.slippageUsd || 0) + extraSlippageUsd).toFixed(4),
      netProfitUsd,
      mempoolPressure: {
        pendingTouches: touched,
        extraSlippageUsd
      }
    };
  });
}

function loadMarketSync() {
  const mode = String(process.env.QUOTE_ADAPTER || 'mock').toLowerCase();
  if (mode !== 'mock') {
    throw new Error('sync scan supports only QUOTE_ADAPTER=mock; use async path for live');
  }

  let quotes = mockMarket();
  let wsQuotes = [];
  let pendingTxs = [];

  if (state.config.enableStreamingSignals) {
    startStreamingSignalListeners();
    if (!streamingCache.initialized) reloadStreamingCacheFromFiles();
    wsQuotes = streamingCache.wsQuotes;
    pendingTxs = streamingCache.pendingTxs;
    quotes = mergeQuotes(quotes, wsQuotes);
  }

  const gasPressureMultiplier = Math.min(
    state.config.maxMempoolGasMultiplier,
    1 + pendingTxs.length * state.config.mempoolGasMultiplierPerPendingTx
  );

  state.runtimeSignals = {
    quoteSource: wsQuotes.length ? 'mock+ws' : 'mock',
    wsQuoteCount: wsQuotes.length,
    pendingMempoolTxs: pendingTxs.length,
    wsDroppedStale: state.runtimeSignals.wsDroppedStale || 0,
    mempoolDroppedStale: state.runtimeSignals.mempoolDroppedStale || 0,
    gasPressureMultiplier: +gasPressureMultiplier.toFixed(4),
    listenerMode: (streamingCache.wsSocket || streamingCache.mempoolSocket)
      ? 'socket'
      : (streamingCache.listenersStarted ? 'watch' : 'poll'),
    listenersStartedAt: state.runtimeSignals.listenersStartedAt,
    wsUpdatedAt: streamingCache.wsUpdatedAt,
    mempoolUpdatedAt: streamingCache.mempoolUpdatedAt
  };

  return { quotes, pendingTxs };
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
  const mempoolMultiplier = Number(state.runtimeSignals?.gasPressureMultiplier || 1);
  return +(baseGasUsd * state.config.gasSafetyMultiplier * mempoolMultiplier).toFixed(6);
}

function exceedsPreflightLatency(preflight) {
  const latencyMs = Number(preflight?.telemetry?.durationMs || 0);
  const thresholdMs = Number(state.config.maxPreflightLatencyMs || 0);
  if (!(thresholdMs >= 0)) return false;
  return latencyMs > thresholdMs;
}

function evaluateExecutionEconomics(opp, preflight) {
  const grossNetUsd = Number(opp?.netProfitUsd || 0);
  const tradeAmountUsd = Number(opp?.tradeAmountUsd || 0);
  const gasCostUsd = estimateGasCostUsd(preflight?.gateway?.estimate);
  const routerFeeUsd = +(tradeAmountUsd * (state.config.routerFeeBps / 10_000)).toFixed(6);

  const atomic = preflight?.atomic || {};
  const bundleFeeUsd = atomic.strategy === 'bundle' ? Number(state.config.bundleFeeUsd || 0) : 0;
  const flashLoanFeeUsd = atomic.fundingMode === 'flash-loan-ready'
    ? +(tradeAmountUsd * (state.config.flashLoanFeeBps / 10_000)).toFixed(6)
    : 0;

  const executionCostUsd = +(routerFeeUsd + bundleFeeUsd + flashLoanFeeUsd).toFixed(6);
  const netAfterGasUsd = +(grossNetUsd - gasCostUsd).toFixed(4);
  const netAfterAllCostsUsd = +(netAfterGasUsd - executionCostUsd).toFixed(4);

  return {
    grossNetUsd,
    gasCostUsd,
    routerFeeUsd,
    bundleFeeUsd,
    flashLoanFeeUsd,
    executionCostUsd,
    netAfterGasUsd,
    netAfterAllCostsUsd
  };
}

function exceedsExecutionGasShare(economics) {
  const grossNetUsd = Number(economics?.grossNetUsd || 0);
  if (!(grossNetUsd > 0)) return false;
  const gasCostUsd = Number(economics?.gasCostUsd || 0);
  const gasShare = gasCostUsd / grossNetUsd;
  return gasShare > Number(state.config.maxExecutionGasCostShare || Infinity);
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

function scanOpportunitiesFromData({ quotes, pendingTxs = [], source = 'replay', wsQuoteCount = 0 }) {
  const validated = validateMarket(quotes);
  state.runtimeSignals = {
    quoteSource: source,
    wsQuoteCount,
    pendingMempoolTxs: pendingTxs.length,
    wsDroppedStale: state.runtimeSignals.wsDroppedStale || 0,
    mempoolDroppedStale: state.runtimeSignals.mempoolDroppedStale || 0,
    gasPressureMultiplier: +Math.min(
      state.config.maxMempoolGasMultiplier,
      1 + pendingTxs.length * state.config.mempoolGasMultiplierPerPendingTx
    ).toFixed(4),
    listenerMode: source === 'replay' || source === 'historical' ? 'offline' : state.runtimeSignals.listenerMode,
    listenersStartedAt: state.runtimeSignals.listenersStartedAt,
    wsUpdatedAt: state.runtimeSignals.wsUpdatedAt,
    mempoolUpdatedAt: state.runtimeSignals.mempoolUpdatedAt
  };
  const opportunities = [...detectTwoPool(validated), ...detectTriangular(validated)];
  const pressured = applyMempoolPressure(opportunities, pendingTxs);
  return pressured.sort((a, b) => b.netProfitUsd - a.netProfitUsd);
}

function scanOpportunities() {
  const { quotes, pendingTxs } = loadMarketSync();
  return scanOpportunitiesFromData({
    quotes,
    pendingTxs,
    source: state.runtimeSignals.quoteSource,
    wsQuoteCount: state.runtimeSignals.wsQuoteCount
  });
}

async function loadMarketAsync() {
  const mode = String(process.env.QUOTE_ADAPTER || 'mock').toLowerCase();

  if (mode === 'mock') {
    return loadMarketSync();
  }

  if (mode !== 'live') {
    throw new Error(`unsupported QUOTE_ADAPTER=${mode}`);
  }

  let quotes = await liveMarket();
  let wsQuotes = [];
  let pendingTxs = [];

  if (state.config.enableStreamingSignals) {
    startStreamingSignalListeners();
    if (!streamingCache.initialized) reloadStreamingCacheFromFiles();
    wsQuotes = streamingCache.wsQuotes;
    pendingTxs = streamingCache.pendingTxs;
    quotes = mergeQuotes(quotes, wsQuotes);
  }

  const gasPressureMultiplier = Math.min(
    state.config.maxMempoolGasMultiplier,
    1 + pendingTxs.length * state.config.mempoolGasMultiplierPerPendingTx
  );

  state.runtimeSignals = {
    quoteSource: wsQuotes.length ? 'live+ws' : 'live',
    wsQuoteCount: wsQuotes.length,
    pendingMempoolTxs: pendingTxs.length,
    wsDroppedStale: state.runtimeSignals.wsDroppedStale || 0,
    mempoolDroppedStale: state.runtimeSignals.mempoolDroppedStale || 0,
    gasPressureMultiplier: +gasPressureMultiplier.toFixed(4),
    listenerMode: (streamingCache.wsSocket || streamingCache.mempoolSocket)
      ? 'socket'
      : (streamingCache.listenersStarted ? 'watch' : 'poll'),
    listenersStartedAt: state.runtimeSignals.listenersStartedAt,
    wsUpdatedAt: streamingCache.wsUpdatedAt,
    mempoolUpdatedAt: streamingCache.mempoolUpdatedAt
  };

  return { quotes, pendingTxs };
}

async function scanOpportunitiesAsync() {
  const { quotes, pendingTxs } = await loadMarketAsync();
  return scanOpportunitiesFromData({
    quotes,
    pendingTxs,
    source: state.runtimeSignals.quoteSource,
    wsQuoteCount: state.runtimeSignals.wsQuoteCount
  });
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

function estimateExecutionCostForRouting(opp, hopCount) {
  const tradeAmountUsd = Number(opp?.tradeAmountUsd || 0);
  const routerFeeUsd = +(tradeAmountUsd * (state.config.routerFeeBps / 10_000)).toFixed(6);
  const bundleFeeUsd = state.config.preferAtomicExecution ? Number(state.config.bundleFeeUsd || 0) : 0;
  const flashLoanFeeUsd = tradeAmountUsd >= state.config.flashLoanMinUsd
    ? +(tradeAmountUsd * (state.config.flashLoanFeeBps / 10_000)).toFixed(6)
    : 0;

  const baseGas = Number(state.config.assumedBaseGas || 0);
  const gasPerHop = Number(state.config.assumedGasPerSwapHop || 0);
  const gasUnits = baseGas + Math.max(1, hopCount) * gasPerHop;
  const gasPriceGwei = Number(state.config.assumedGasPriceGwei || 0);
  const nativeTokenPriceUsd = Number(process.env.NATIVE_TOKEN_PRICE_USD || state.config.nativeTokenPriceUsd || 0);
  const gasNative = gasUnits * gasPriceGwei * 1e-9;
  const mempoolMultiplier = Number(state.runtimeSignals?.gasPressureMultiplier || 1);
  const gasCostUsd = +(gasNative * nativeTokenPriceUsd * state.config.gasSafetyMultiplier * mempoolMultiplier).toFixed(6);

  const totalExecutionCostUsd = +(routerFeeUsd + bundleFeeUsd + flashLoanFeeUsd + gasCostUsd).toFixed(6);
  return {
    routerFeeUsd,
    bundleFeeUsd,
    flashLoanFeeUsd,
    gasCostUsd,
    totalExecutionCostUsd
  };
}

function scoreOpportunityForRouting(opp) {
  const path = Array.isArray(opp?.path) ? opp.path : [];
  const hopCount = path.length;
  const complexityPenaltyUsd = Math.max(0, hopCount - 1) * state.config.routeComplexityPenaltyUsdPerHop;
  const venueCount = new Set(path.map((leg) => String(leg).split('@')[1]).filter(Boolean)).size;
  const dexDiversityBonusUsd = venueCount * state.config.routeDexDiversityBonusUsd;
  const executionCost = estimateExecutionCostForRouting(opp, hopCount);
  const estimatedNetAfterExecutionUsd = +((opp?.netProfitUsd || 0) - executionCost.totalExecutionCostUsd).toFixed(4);
  const routingScoreUsd = +(estimatedNetAfterExecutionUsd - complexityPenaltyUsd + dexDiversityBonusUsd).toFixed(4);

  return {
    hopCount,
    venueCount,
    complexityPenaltyUsd: +complexityPenaltyUsd.toFixed(4),
    dexDiversityBonusUsd: +dexDiversityBonusUsd.toFixed(4),
    estimatedExecutionCostUsd: executionCost.totalExecutionCostUsd,
    estimatedGasCostUsd: executionCost.gasCostUsd,
    estimatedNetAfterExecutionUsd,
    routingScoreUsd
  };
}

function buildBestPathPlan(assessedOpportunities = []) {
  const viable = assessedOpportunities.filter((x) => x && x.risk && x.risk.pass && x.opp);
  const ranked = viable
    .map((x) => {
      const routing = scoreOpportunityForRouting(x.opp);
      return {
        ...x,
        routing
      };
    })
    .sort((a, b) => b.routing.routingScoreUsd - a.routing.routingScoreUsd || b.opp.netProfitUsd - a.opp.netProfitUsd);

  return {
    selected: ranked[0] || null,
    ranked
  };
}

function staleSignalExecutionGuard(runtimeState = state) {
  const staleAlerts = collectStreamingStaleAlerts(runtimeState);
  if (!staleAlerts.length) return { pass: true, reason: 'ok' };

  return {
    pass: false,
    reason: `stale-streaming-signal:${staleAlerts.map((x) => x.code).join(',')}`,
    alerts: staleAlerts
  };
}

function executeOpportunity(opp) {
  const rechecked = { ...opp, recheckTs: now() };
  const signalGuard = staleSignalExecutionGuard(state);

  if (!signalGuard.pass) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: signalGuard.reason,
      gasCostUsd: 0,
      executionCostUsd: 0,
      netAfterGasUsd: 0,
      netAfterAllCostsUsd: 0,
      signalGuard
    };
  }

  if (state.session.mode === 'paper') {
    const preflight = state.config.preflightInPaper
      ? buildOnchainExecutionPlan(rechecked)
      : { ok: true, reason: 'paper-preflight-disabled', provider: 'paper-executor' };

    appendPreflightRecord(preflight, rechecked);
    const economics = evaluateExecutionEconomics(rechecked, preflight);
    if (!preflight.ok && state.config.failClosedOnMissingOnchainOS) {
      return {
        success: false,
        txHash: null,
        realizedProfitUsd: 0,
        reason: preflight.reason,
        gasCostUsd: economics.gasCostUsd,
        netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
        preflight
      };
    }

    if (exceedsPreflightLatency(preflight)) {
      return {
        success: false,
        txHash: null,
        realizedProfitUsd: 0,
        reason: 'preflight-latency-too-high',
        gasCostUsd: economics.gasCostUsd,
        netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
        preflight
      };
    }

    if (economics.netAfterAllCostsUsd < state.config.minNetProfitUsd) {
      return {
        success: false,
        txHash: null,
        realizedProfitUsd: 0,
        reason: 'profit-too-low-after-gas',
        gasCostUsd: economics.gasCostUsd,
        netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
        preflight
      };
    }

    if (exceedsExecutionGasShare(economics)) {
      return {
        success: false,
        txHash: null,
        realizedProfitUsd: 0,
        reason: 'gas-share-too-high',
        gasCostUsd: economics.gasCostUsd,
        netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
        preflight
      };
    }

    const paperHash = 'paper-' + Buffer.from(`${Date.now()}-${Math.random()}`).toString('hex').slice(0, 16);
    return {
      success: true,
      txHash: paperHash,
      realizedProfitUsd: +(economics.netAfterAllCostsUsd * 0.92).toFixed(4),
      reason: 'paper-filled',
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }

  const preflight = buildOnchainExecutionPlan(rechecked);
  appendPreflightRecord(preflight, rechecked);
  const economics = evaluateExecutionEconomics(rechecked, preflight);
  if (!preflight.ok && state.config.failClosedOnMissingOnchainOS) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: preflight.reason,
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }

  if (exceedsPreflightLatency(preflight)) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: 'preflight-latency-too-high',
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
      executionCostUsd: economics.executionCostUsd,
      netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }

  if (economics.netAfterAllCostsUsd < state.config.minNetProfitUsd) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: 'profit-too-low-after-gas',
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }

  if (exceedsExecutionGasShare(economics)) {
    return {
      success: false,
      txHash: null,
      realizedProfitUsd: 0,
      reason: 'gas-share-too-high',
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
      executionCostUsd: economics.executionCostUsd,
      netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }

  for (let attempt = 0; attempt <= state.config.maxExecutionRetries; attempt++) {
    if (rechecked.netProfitUsd <= 0) {
      return { success: false, txHash: null, realizedProfitUsd: 0, reason: 'recheck-failed', gasCostUsd: economics.gasCostUsd, netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd, preflight };
    }
    const txHash = '0x' + Buffer.from(`${Date.now()}-${attempt}`).toString('hex').slice(0, 64).padEnd(64, '0');
    return {
      success: true,
      txHash,
      realizedProfitUsd: +(economics.netAfterAllCostsUsd * 0.92).toFixed(4),
      reason: `executed-attempt-${attempt + 1}`,
      gasCostUsd: economics.gasCostUsd,
      netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd,
      preflight
    };
  }
  return { success: false, txHash: null, realizedProfitUsd: 0, reason: 'execution-retries-exhausted', gasCostUsd: economics.gasCostUsd, netAfterGasUsd: economics.netAfterGasUsd,
        executionCostUsd: economics.executionCostUsd,
        netAfterAllCostsUsd: economics.netAfterAllCostsUsd, preflight };
}

function appendRecord(obj) {
  const file = path.join(process.cwd(), 'data', 'executions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function appendPreflightRecord(preflight, opp = null) {
  if (!preflight || !preflight.telemetry) return;
  const file = path.join(process.cwd(), 'data', 'preflight.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.appendFileSync(
    file,
    JSON.stringify({
      ts: new Date().toISOString(),
      mode: state.session.mode,
      ok: Boolean(preflight.ok),
      reason: preflight.reason,
      routeType: opp?.type || 'unknown',
      path: opp?.path || [],
      telemetry: preflight.telemetry
    }) + '\n'
  );
}

function appendRouteDecisionRecord({
  selected,
  ranked = [],
  opportunities = [],
  autopilot = false,
  mode = 'paper',
  phase = 'scan'
} = {}) {
  const file = path.join(process.cwd(), 'data', 'route-decisions.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const topCandidates = ranked
    .slice(0, 5)
    .map((candidate) => ({
      routeType: candidate?.opp?.type || 'none',
      path: candidate?.opp?.path || [],
      netProfitUsd: +(candidate?.opp?.netProfitUsd || 0).toFixed(4),
      tradeAmountUsd: +(candidate?.opp?.tradeAmountUsd || 0).toFixed(4),
      riskPass: Boolean(candidate?.risk?.pass),
      riskReason: candidate?.risk?.reason || 'unknown',
      routingScoreUsd: +(candidate?.routing?.routingScoreUsd || 0).toFixed(4),
      estimatedNetAfterExecutionUsd: +(candidate?.routing?.estimatedNetAfterExecutionUsd || 0).toFixed(4),
      estimatedExecutionCostUsd: +(candidate?.routing?.estimatedExecutionCostUsd || 0).toFixed(6)
    }));

  fs.appendFileSync(
    file,
    JSON.stringify({
      ts: new Date().toISOString(),
      mode,
      autopilot,
      phase,
      consideredCount: opportunities.length,
      selected: {
        routeType: selected?.opp?.type || 'none',
        path: selected?.opp?.path || [],
        riskPass: Boolean(selected?.risk?.pass),
        riskReason: selected?.risk?.reason || 'none',
        routingScoreUsd: +(selected?.routing?.routingScoreUsd || 0).toFixed(4),
        netProfitUsd: +(selected?.opp?.netProfitUsd || 0).toFixed(4)
      },
      topCandidates
    }) + '\n'
  );
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
  const totalExecutionCostUsd = +rows.reduce((s, r) => s + (r.executionCostUsd || 0), 0).toFixed(4);
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
  const rolling24hPnlUsd = getRollingPnlUsd(rows);

  return {
    sampleSize: rows.length,
    opportunitiesSeen: trades.length,
    executedCount: executed.length,
    executionRate: +(executed.length / Math.max(trades.length, 1)).toFixed(4),
    totalRealizedPnlUsd,
    rolling24hPnlUsd,
    totalGasCostUsd,
    totalExecutionCostUsd,
    avgRealizedPnlUsd,
    byMode,
    recent: rows.slice(-20),
    lastRecord
  };
}

function collectStreamingStaleAlerts(runtimeState, nowTs = now()) {
  const runtimeSignals = runtimeState.runtimeSignals || {};
  const alerts = [];

  if (!(runtimeState.config.enableStreamingSignals && ['watch', 'socket'].includes(runtimeSignals.listenerMode))) {
    return alerts;
  }

  const wsUpdatedAt = runtimeSignals.wsUpdatedAt ? Date.parse(runtimeSignals.wsUpdatedAt) : NaN;
  const mempoolUpdatedAt = runtimeSignals.mempoolUpdatedAt ? Date.parse(runtimeSignals.mempoolUpdatedAt) : NaN;
  const listenersStartedAt = runtimeSignals.listenersStartedAt ? Date.parse(runtimeSignals.listenersStartedAt) : NaN;
  const bootstrapAgeMs = Number.isFinite(listenersStartedAt) ? nowTs - listenersStartedAt : 0;
  const bootstrapGraceMs = Number(runtimeState.config.streamingBootstrapGraceMs || 0);

  const wsStaleAgeMs = Number(runtimeState.config.maxWsSignalAgeMs || 0) * 2;
  if (Number.isFinite(wsUpdatedAt) && wsStaleAgeMs > 0 && nowTs - wsUpdatedAt > wsStaleAgeMs) {
    alerts.push({
      level: 'warning',
      code: 'ws-signal-stale',
      message: `Websocket quote overlay stale for ${nowTs - wsUpdatedAt}ms`,
      value: nowTs - wsUpdatedAt,
      threshold: wsStaleAgeMs
    });
  } else if (!Number.isFinite(wsUpdatedAt) && bootstrapGraceMs > 0 && bootstrapAgeMs > bootstrapGraceMs) {
    alerts.push({
      level: 'warning',
      code: 'ws-signal-missing',
      message: `Websocket quote overlay has no fresh update after ${bootstrapAgeMs}ms`,
      value: bootstrapAgeMs,
      threshold: bootstrapGraceMs
    });
  }

  const mempoolStaleAgeMs = Number(runtimeState.config.maxMempoolSignalAgeMs || 0) * 2;
  if (Number.isFinite(mempoolUpdatedAt) && mempoolStaleAgeMs > 0 && nowTs - mempoolUpdatedAt > mempoolStaleAgeMs) {
    alerts.push({
      level: 'warning',
      code: 'mempool-signal-stale',
      message: `Mempool overlay stale for ${nowTs - mempoolUpdatedAt}ms`,
      value: nowTs - mempoolUpdatedAt,
      threshold: mempoolStaleAgeMs
    });
  } else if (!Number.isFinite(mempoolUpdatedAt) && bootstrapGraceMs > 0 && bootstrapAgeMs > bootstrapGraceMs) {
    alerts.push({
      level: 'warning',
      code: 'mempool-signal-missing',
      message: `Mempool overlay has no fresh update after ${bootstrapAgeMs}ms`,
      value: bootstrapAgeMs,
      threshold: bootstrapGraceMs
    });
  }

  return alerts;
}

function getRollingPnlUsd(rows = [], windowMs = 24 * 60 * 60 * 1000, nowTs = now()) {
  return +rows
    .filter((row) => {
      const ts = Date.parse(row?.ts || '');
      return Number.isFinite(ts) && nowTs - ts <= windowMs;
    })
    .reduce((sum, row) => sum + (row.realizedProfitUsd || 0), 0)
    .toFixed(4);
}

function getTopFailureReason(rows = []) {
  const reasonCounts = new Map();

  for (const row of rows) {
    if (row?.success) continue;
    const reason = String(row?.reason || 'unknown-failure');
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }

  let topReason = null;
  let topCount = 0;
  for (const [reason, count] of reasonCounts.entries()) {
    if (count > topCount) {
      topReason = reason;
      topCount = count;
    }
  }

  return { reason: topReason, count: topCount, totalFailures: [...reasonCounts.values()].reduce((sum, c) => sum + c, 0) };
}

function evaluateRuntimeAlerts({ rows, metrics, runtimeState = state }) {
  const alerts = [];
  const recentRows = rows.slice(-Math.max(1, runtimeState.config.alertWindow));
  const runtimeSignals = runtimeState.runtimeSignals || {};

  let consecutiveFailures = 0;
  for (let i = recentRows.length - 1; i >= 0; i--) {
    if (recentRows[i].success) break;
    consecutiveFailures += 1;
  }

  if (consecutiveFailures >= runtimeState.config.alertMaxConsecutiveFailures) {
    alerts.push({
      level: 'critical',
      code: 'consecutive-failures',
      message: `Consecutive failed runs reached ${consecutiveFailures}`,
      value: consecutiveFailures,
      threshold: runtimeState.config.alertMaxConsecutiveFailures
    });
  }

  const topFailureReason = getTopFailureReason(recentRows);
  const failureBurstThreshold = Number(runtimeState.config.alertFailureReasonBurstCount || 0);
  if (failureBurstThreshold > 0 && topFailureReason.count >= failureBurstThreshold) {
    alerts.push({
      level: 'warning',
      code: 'failure-reason-burst',
      message: `Failure reason '${topFailureReason.reason}' repeated ${topFailureReason.count} times in recent window`,
      value: topFailureReason.count,
      threshold: failureBurstThreshold,
      reason: topFailureReason.reason
    });
  }

  if (metrics.executionRate < runtimeState.config.alertMinExecutionRate && metrics.sampleSize >= 5) {
    alerts.push({
      level: 'warning',
      code: 'low-execution-rate',
      message: `Execution rate dropped to ${metrics.executionRate}`,
      value: metrics.executionRate,
      threshold: runtimeState.config.alertMinExecutionRate
    });
  }

  const recentPnlUsd = +recentRows.reduce((sum, r) => sum + (r.realizedProfitUsd || 0), 0).toFixed(4);
  if (recentPnlUsd <= runtimeState.config.alertMinRecentPnlUsd && recentRows.length >= 5) {
    alerts.push({
      level: 'warning',
      code: 'negative-recent-pnl',
      message: `Recent PnL fell to ${recentPnlUsd}`,
      value: recentPnlUsd,
      threshold: runtimeState.config.alertMinRecentPnlUsd
    });
  }

  const rolling24hPnlUsd = getRollingPnlUsd(rows);
  if (rolling24hPnlUsd <= Number(runtimeState.config.alertMaxDailyLossUsd || -Infinity)) {
    alerts.push({
      level: 'warning',
      code: 'daily-loss-warning',
      message: `24h realized PnL fell to ${rolling24hPnlUsd}`,
      value: rolling24hPnlUsd,
      threshold: runtimeState.config.alertMaxDailyLossUsd
    });
  }

  if (rolling24hPnlUsd <= Number(runtimeState.config.maxDailyLossUsd || -Infinity)) {
    alerts.push({
      level: 'critical',
      code: 'daily-loss-limit-breached',
      message: `24h realized PnL ${rolling24hPnlUsd} breached max daily loss limit`,
      value: rolling24hPnlUsd,
      threshold: runtimeState.config.maxDailyLossUsd
    });
  }

  const gasCost = recentRows.reduce((sum, r) => sum + (r.gasCostUsd || 0), 0);
  const grossNet = recentRows.reduce((sum, r) => sum + Math.max(0, r.netProfitUsd || 0), 0);
  const gasShare = grossNet > 0 ? +(gasCost / grossNet).toFixed(4) : 0;
  if (gasShare >= runtimeState.config.alertMaxGasCostShare && recentRows.length >= 5) {
    alerts.push({
      level: 'warning',
      code: 'gas-cost-pressure',
      message: `Gas cost share reached ${gasShare}`,
      value: gasShare,
      threshold: runtimeState.config.alertMaxGasCostShare
    });
  }

  const gasPressureMultiplier = Number(runtimeSignals.gasPressureMultiplier || 1);
  if (gasPressureMultiplier >= Number(runtimeState.config.alertMaxGasPressureMultiplier || Infinity)) {
    alerts.push({
      level: 'critical',
      code: 'high-gas-pressure',
      message: `Mempool-driven gas pressure reached ${gasPressureMultiplier}`,
      value: gasPressureMultiplier,
      threshold: runtimeState.config.alertMaxGasPressureMultiplier
    });
  }

  const preflightLatencies = recentRows
    .map((r) => Number(r?.onchainPreflight?.telemetry?.durationMs))
    .filter((v) => Number.isFinite(v) && v >= 0);
  const avgPreflightLatencyMs = preflightLatencies.length
    ? +(preflightLatencies.reduce((sum, v) => sum + v, 0) / preflightLatencies.length).toFixed(2)
    : 0;
  if (preflightLatencies.length >= 3 && avgPreflightLatencyMs >= Number(runtimeState.config.alertMaxPreflightLatencyMs || Infinity)) {
    alerts.push({
      level: 'warning',
      code: 'slow-preflight-latency',
      message: `Average preflight latency reached ${avgPreflightLatencyMs}ms`,
      value: avgPreflightLatencyMs,
      threshold: runtimeState.config.alertMaxPreflightLatencyMs
    });
  }

  if (runtimeState.autopilot && runtimeState.session.mode === 'live' && !runtimeState.session.wallet.loggedIn) {
    alerts.push({
      level: 'critical',
      code: 'wallet-session-missing',
      message: 'Live autopilot enabled but wallet is not logged in'
    });
  }

  const lockActive = Boolean(runtimeSignals.executionLockActive);
  const lockAgeMs = Number(runtimeSignals.executionLockAgeMs || 0);
  const lockTtlMs = Number(runtimeState.config.executionLockTtlMs || 0);
  if (lockActive && lockTtlMs > 0 && lockAgeMs > lockTtlMs) {
    alerts.push({
      level: 'critical',
      code: 'execution-lock-stuck',
      message: `Execution lock active for ${lockAgeMs}ms (ttl ${lockTtlMs}ms)`,
      value: lockAgeMs,
      threshold: lockTtlMs
    });
  }

  alerts.push(...collectStreamingStaleAlerts(runtimeState));

  return {
    ts: new Date().toISOString(),
    ok: alerts.length === 0,
    alerts,
    stats: {
      sampleSize: metrics.sampleSize,
      executionRate: metrics.executionRate,
      totalRealizedPnlUsd: metrics.totalRealizedPnlUsd,
      recentPnlUsd,
      rolling24hPnlUsd,
      consecutiveFailures,
      gasShare,
      avgPreflightLatencyMs,
      topFailureReason: topFailureReason.reason,
      topFailureCount: topFailureReason.count,
      totalFailuresInWindow: topFailureReason.totalFailures
    }
  };
}

function alertSnapshotSignature(snapshot) {
  const alerts = (snapshot?.alerts || [])
    .map((a) => `${a.level || 'unknown'}:${a.code || 'unknown'}`)
    .sort();
  return alerts.join('|');
}

function alertLevelRank(level) {
  const order = { info: 1, warning: 2, critical: 3 };
  return order[String(level || '').toLowerCase()] || 0;
}

function shouldNotifyAlertSnapshot(snapshot, runtimeState = state) {
  const webhookUrl = String(runtimeState.config.alertNotifyWebhookUrl || '').trim();
  if (!webhookUrl) return false;

  const minRank = alertLevelRank(runtimeState.config.alertNotifyMinLevel || 'critical');
  return (snapshot?.alerts || []).some((alert) => alertLevelRank(alert.level) >= minRank);
}

function appendAlertNotifyError(payload) {
  const file = path.join(process.cwd(), 'data', 'alert-notify-errors.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(payload) + '\n');
}

function notifyAlertWebhook(snapshot, runtimeState = state) {
  if (!shouldNotifyAlertSnapshot(snapshot, runtimeState)) return;
  if (typeof fetch !== 'function') return;

  const webhookUrl = String(runtimeState.config.alertNotifyWebhookUrl || '').trim();
  const timeoutMs = Math.max(250, Number(runtimeState.config.alertNotifyTimeoutMs || 3000));
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  const payload = {
    ts: snapshot.ts,
    source: 'xlayer-arbitrage-executor',
    mode: runtimeState.session.mode,
    autopilot: runtimeState.autopilot,
    walletAddress: runtimeState.session.wallet.address,
    alerts: snapshot.alerts,
    stats: snapshot.stats,
    runtimeSignals: runtimeState.runtimeSignals
  };

  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller ? controller.signal : undefined
  })
    .then((res) => {
      if (!res.ok) {
        appendAlertNotifyError({
          ts: new Date().toISOString(),
          type: 'webhook-http-error',
          status: res.status,
          webhookUrl,
          alertSignature: alertSnapshotSignature(snapshot)
        });
      }
    })
    .catch((err) => {
      appendAlertNotifyError({
        ts: new Date().toISOString(),
        type: 'webhook-delivery-error',
        message: err.message,
        webhookUrl,
        alertSignature: alertSnapshotSignature(snapshot)
      });
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

function appendAlertSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.alerts) || snapshot.alerts.length === 0) return;

  const signature = alertSnapshotSignature(snapshot);
  const ts = now();
  const dedupWindowMs = Math.max(0, Number(state.config.alertDedupWindowMs || 0));
  const withinDedupWindow = dedupWindowMs > 0
    && signature === alertCache.lastSignature
    && ts - alertCache.lastTs < dedupWindowMs;

  if (withinDedupWindow) return;

  const file = path.join(process.cwd(), 'data', 'alerts.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(snapshot) + '\n');

  alertCache.lastSignature = signature;
  alertCache.lastTs = ts;

  notifyAlertWebhook(snapshot);
}

function syncExecutionLockSignal() {
  if (!executionLock.active) {
    state.runtimeSignals.executionLockActive = false;
    state.runtimeSignals.executionLockSince = null;
    state.runtimeSignals.executionLockAgeMs = 0;
    return;
  }

  state.runtimeSignals.executionLockActive = true;
  state.runtimeSignals.executionLockSince = new Date(executionLock.sinceMs).toISOString();
  state.runtimeSignals.executionLockAgeMs = Math.max(0, now() - executionLock.sinceMs);
}

function getAlertStatus() {
  syncExecutionLockSignal();
  const rows = readExecutionLedger(state.config.alertWindow);
  const metrics = getPnlMetrics({ limit: state.config.alertWindow });
  return evaluateRuntimeAlerts({ rows, metrics, runtimeState: state });
}

function getDashboardSnapshot({ tradeLimit = 10, ledgerLimit = 200 } = {}) {
  const metrics = getPnlMetrics({ limit: ledgerLimit });
  const alerts = evaluateRuntimeAlerts({
    rows: readExecutionLedger(state.config.alertWindow),
    metrics: getPnlMetrics({ limit: state.config.alertWindow }),
    runtimeState: state
  });

  const recentTrades = (metrics.recent || [])
    .slice(-Math.max(1, Number(tradeLimit) || 1))
    .reverse()
    .map((row) => ({
      ts: row.ts,
      mode: row.mode,
      routeType: row.routeType,
      success: Boolean(row.success),
      reason: row.reason,
      realizedProfitUsd: +(row.realizedProfitUsd || 0).toFixed(4),
      netAfterAllCostsUsd: +(row.netAfterAllCostsUsd || 0).toFixed(4),
      txHash: row.txHash || null
    }));

  return {
    ts: new Date().toISOString(),
    metrics,
    alerts,
    session: {
      autopilot: state.autopilot,
      mode: state.session.mode,
      wallet: state.session.wallet
    },
    runtimeSignals: state.runtimeSignals,
    recentTrades
  };
}

function evaluateExecutionCircuitBreaker(alertSnapshot) {
  if (!state.config.failClosedOnCriticalAlerts) {
    return { pass: true, reason: 'disabled', criticalCodes: [] };
  }

  const criticalCodes = (alertSnapshot?.alerts || [])
    .filter((a) => a.level === 'critical')
    .map((a) => a.code);

  if (criticalCodes.length === 0) {
    return { pass: true, reason: 'ok', criticalCodes: [] };
  }

  return {
    pass: false,
    reason: `execution-circuit-breaker:${criticalCodes.join(',')}`,
    criticalCodes
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

function runReplayBacktest(snapshots = []) {
  const prevMode = state.session.mode;
  state.session.mode = 'paper';

  const runs = [];
  for (const snap of snapshots) {
    try {
      const opportunities = scanOpportunitiesFromData({
        quotes: snap.quotes || [],
        pendingTxs: snap.pendingTxs || [],
        source: 'replay'
      });
      const assessed = opportunities.map((opp) => ({ opp, risk: riskCheck(opp) }));
      const routePlan = buildBestPathPlan(assessed);
      const selected = routePlan.selected || assessed[0] || { opp: null, risk: { pass: false, reason: 'no-opportunity' }, routing: null };

      let result = { success: false, txHash: null, realizedProfitUsd: 0, reason: selected.risk.reason, gasCostUsd: 0, executionCostUsd: 0, netAfterGasUsd: 0, netAfterAllCostsUsd: 0 };
      if (selected.risk.pass) result = executeOpportunity(selected.opp);

      runs.push({
        ts: snap.ts || new Date().toISOString(),
        success: result.success,
        reason: result.reason,
        routeType: selected.opp?.type || 'none',
        netProfitUsd: selected.opp?.netProfitUsd || 0,
        routingScoreUsd: selected.routing?.routingScoreUsd || 0,
        gasCostUsd: result.gasCostUsd || 0,
        realizedProfitUsd: result.realizedProfitUsd || 0
      });
    } catch (err) {
      runs.push({
        ts: snap.ts || new Date().toISOString(),
        success: false,
        reason: `replay-error:${err.message}`,
        routeType: 'none',
        netProfitUsd: 0,
        gasCostUsd: 0,
        realizedProfitUsd: 0
      });
    }
  }

  state.session.mode = prevMode;

  const executed = runs.filter((r) => r.success);
  const totalRealizedPnlUsd = +runs.reduce((s, r) => s + (r.realizedProfitUsd || 0), 0).toFixed(4);
  return {
    sampleSize: runs.length,
    executedCount: executed.length,
    executionRate: +(executed.length / Math.max(runs.length, 1)).toFixed(4),
    totalRealizedPnlUsd,
    avgRealizedPnlUsd: +(totalRealizedPnlUsd / Math.max(executed.length, 1)).toFixed(4),
    runs
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function acquireExecutionLock() {
  const ts = now();
  const ttlMs = Math.max(1_000, Number(state.config.executionLockTtlMs || 120_000));

  if (executionLock.active) {
    const ageMs = ts - executionLock.sinceMs;
    if (ageMs <= ttlMs) {
      state.runtimeSignals.executionLockActive = true;
      state.runtimeSignals.executionLockSince = new Date(executionLock.sinceMs).toISOString();
      state.runtimeSignals.executionLockAgeMs = ageMs;
      return { ok: false, reason: 'execution-lock-active', ageMs, ttlMs };
    }
  }

  executionLock.active = true;
  executionLock.sinceMs = ts;
  state.runtimeSignals.executionLockActive = true;
  state.runtimeSignals.executionLockSince = new Date(ts).toISOString();
  state.runtimeSignals.executionLockAgeMs = 0;
  return { ok: true, reason: 'ok' };
}

function releaseExecutionLock() {
  executionLock.active = false;
  executionLock.sinceMs = 0;
  state.runtimeSignals.executionLockActive = false;
  state.runtimeSignals.executionLockSince = null;
  state.runtimeSignals.executionLockAgeMs = 0;
}

async function runPaperSoak({ iterations = 20, intervalMs = 1000, stopOnCritical = true } = {}) {
  const targetIterations = Math.max(1, Number(iterations) || 1);
  const pauseMs = Math.max(0, Number(intervalMs) || 0);
  const previous = {
    autopilot: state.autopilot,
    mode: state.session.mode
  };

  setAutopilot(true);
  setMode('paper');

  const runs = [];
  for (let i = 0; i < targetIterations; i++) {
    const out = await runOnceAsync();
    runs.push({
      index: i + 1,
      ts: out.record.ts,
      success: out.record.success,
      reason: out.record.reason,
      routeType: out.record.routeType,
      netProfitUsd: out.record.netProfitUsd,
      realizedProfitUsd: out.record.realizedProfitUsd,
      gasCostUsd: out.record.gasCostUsd,
      alerts: out.alerts
    });

    const hasCritical = Array.isArray(out.alerts?.alerts) && out.alerts.alerts.some((a) => a.level === 'critical');
    if (stopOnCritical && hasCritical) break;
    if (i < targetIterations - 1 && pauseMs > 0) await sleep(pauseMs);
  }

  setAutopilot(previous.autopilot);
  setMode(previous.mode);

  const executedCount = runs.filter((r) => r.success).length;
  const totalRealizedPnlUsd = +runs.reduce((sum, r) => sum + (r.realizedProfitUsd || 0), 0).toFixed(4);
  const totalGasCostUsd = +runs.reduce((sum, r) => sum + (r.gasCostUsd || 0), 0).toFixed(4);

  return {
    iterationsRequested: targetIterations,
    iterationsCompleted: runs.length,
    stoppedEarly: runs.length < targetIterations,
    executionRate: +(executedCount / Math.max(runs.length, 1)).toFixed(4),
    executedCount,
    totalRealizedPnlUsd,
    totalGasCostUsd,
    runs
  };
}

function runOnce() {
  const lock = acquireExecutionLock();
  if (!lock.ok) {
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
      reason: `${lock.reason}:${lock.ageMs}ms>${lock.ttlMs}ms`
    };
    appendRecord(failRecord);
    const alerts = getAlertStatus();
    appendAlertSnapshot(alerts);
    return { config: state.config, opportunities: [], record: failRecord, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
  }

  try {
    let opportunities = [];
    let selected = null;

    try {
      opportunities = scanOpportunities();
      const assessed = opportunities.map((opp) => ({ opp, risk: riskCheck(opp) }));
      const routePlan = buildBestPathPlan(assessed);
      selected = routePlan.selected || assessed[0] || { opp: null, risk: { pass: false, reason: 'no-opportunity' }, routing: null };
      appendRouteDecisionRecord({
        selected,
        ranked: routePlan.ranked,
        opportunities,
        autopilot: state.autopilot,
        mode: state.session.mode,
        phase: 'sync'
      });
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
      const alerts = getAlertStatus();
      appendAlertSnapshot(alerts);
      return { config: state.config, opportunities: [], record: failRecord, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
    }

    let result = { success: false, txHash: null, realizedProfitUsd: 0, reason: selected.risk.reason };
    if (selected.risk.pass && state.autopilot) {
      const preExecutionAlerts = getAlertStatus();
      const circuit = evaluateExecutionCircuitBreaker(preExecutionAlerts);

      if (!circuit.pass) {
        result = {
          success: false,
          txHash: null,
          realizedProfitUsd: 0,
          reason: circuit.reason,
          circuitBreaker: circuit,
          preExecutionAlerts
        };
      } else if (state.session.mode === 'live' && !state.session.wallet.loggedIn) {
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
      routingScoreUsd: selected.routing?.routingScoreUsd || 0,
      routingComplexityPenaltyUsd: selected.routing?.complexityPenaltyUsd || 0,
      routingDexDiversityBonusUsd: selected.routing?.dexDiversityBonusUsd || 0,
      gasCostUsd: result.gasCostUsd || 0,
      executionCostUsd: result.executionCostUsd || 0,
      netAfterGasUsd: result.netAfterGasUsd || 0,
      netAfterAllCostsUsd: result.netAfterAllCostsUsd || 0,
      tradeAmountUsd: selected.opp?.tradeAmountUsd || 0,
      consideredCount: opportunities.length,
      mode: state.session.mode,
      walletAddress: state.session.wallet.address,
      onchainPreflight: result.preflight || null,
      runtimeSignals: state.runtimeSignals,
      ...result
    };
    appendRecord(record);
    optimizeFromHistory();
    const alerts = getAlertStatus();
    appendAlertSnapshot(alerts);

    return { config: state.config, opportunities, selected: selected.opp, record, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
  } finally {
    releaseExecutionLock();
  }
}

async function runOnceAsync() {
  const lock = acquireExecutionLock();
  if (!lock.ok) {
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
      reason: `${lock.reason}:${lock.ageMs}ms>${lock.ttlMs}ms`
    };
    appendRecord(failRecord);
    const alerts = getAlertStatus();
    appendAlertSnapshot(alerts);
    return { config: state.config, opportunities: [], record: failRecord, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
  }

  try {
    let opportunities = [];
    let selected = null;

    try {
      opportunities = await scanOpportunitiesAsync();
      const assessed = opportunities.map((opp) => ({ opp, risk: riskCheck(opp) }));
      const routePlan = buildBestPathPlan(assessed);
      selected = routePlan.selected || assessed[0] || { opp: null, risk: { pass: false, reason: 'no-opportunity' }, routing: null };
      appendRouteDecisionRecord({
        selected,
        ranked: routePlan.ranked,
        opportunities,
        autopilot: state.autopilot,
        mode: state.session.mode,
        phase: 'async'
      });
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
      const alerts = getAlertStatus();
      appendAlertSnapshot(alerts);
      return { config: state.config, opportunities: [], record: failRecord, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
    }

    let result = { success: false, txHash: null, realizedProfitUsd: 0, reason: selected.risk.reason };
    if (selected.risk.pass && state.autopilot) {
      const preExecutionAlerts = getAlertStatus();
      const circuit = evaluateExecutionCircuitBreaker(preExecutionAlerts);

      if (!circuit.pass) {
        result = {
          success: false,
          txHash: null,
          realizedProfitUsd: 0,
          reason: circuit.reason,
          circuitBreaker: circuit,
          preExecutionAlerts
        };
      } else if (state.session.mode === 'live' && !state.session.wallet.loggedIn) {
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
      routingScoreUsd: selected.routing?.routingScoreUsd || 0,
      routingComplexityPenaltyUsd: selected.routing?.complexityPenaltyUsd || 0,
      routingDexDiversityBonusUsd: selected.routing?.dexDiversityBonusUsd || 0,
      gasCostUsd: result.gasCostUsd || 0,
      executionCostUsd: result.executionCostUsd || 0,
      netAfterGasUsd: result.netAfterGasUsd || 0,
      netAfterAllCostsUsd: result.netAfterAllCostsUsd || 0,
      tradeAmountUsd: selected.opp?.tradeAmountUsd || 0,
      consideredCount: opportunities.length,
      mode: state.session.mode,
      walletAddress: state.session.wallet.address,
      onchainPreflight: result.preflight || null,
      runtimeSignals: state.runtimeSignals,
      ...result
    };
    appendRecord(record);
    optimizeFromHistory();
    const alerts = getAlertStatus();
    appendAlertSnapshot(alerts);

    return { config: state.config, opportunities, selected: selected.opp, record, autopilot: state.autopilot, session: state.session, runtimeSignals: state.runtimeSignals, alerts };
  } finally {
    releaseExecutionLock();
  }
}

loadRuntimeState();

module.exports = {
  state,
  runOnce,
  runOnceAsync,
  runReplayBacktest,
  runPaperSoak,
  scanOpportunities,
  scanOpportunitiesAsync,
  scanOpportunitiesFromData,
  optimizeFromHistory,
  validateMarket,
  detectTwoPool,
  detectTriangular,
  riskCheck,
  scoreOpportunityForRouting,
  buildBestPathPlan,
  executeOpportunity,
  buildAtomicExecutionPlan,
  buildRouterPlan,
  buildOnchainExecutionPlan,
  liveMarket,
  loadRuntimeState,
  persistRuntimeState,
  setAutopilot,
  setMode,
  walletLogin,
  walletLogout,
  readExecutionLedger,
  getPnlMetrics,
  evaluateRuntimeAlerts,
  getAlertStatus,
  getDashboardSnapshot,
  evaluateExecutionCircuitBreaker,
  collectStreamingStaleAlerts,
  staleSignalExecutionGuard,
  startStreamingSignalListeners,
  resetStreamingSignalCache,
  resetAlertSnapshotCache,
  shouldNotifyAlertSnapshot,
  exceedsPreflightLatency
};

