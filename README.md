# X Layer Arbitrage Executor

NIUMA skill/project scaffold for automated arbitrage execution on X Layer.

## Features
- Wallet-first session onboarding + persistence
  - one-time wallet login (`wallet-login`) persisted to `data/runtime-state.json`
  - mode switch: `paper` (default) vs `live` with fail-closed wallet requirement
  - autopilot/mode/session state survives restarts
- Quote adapters
  - `mock` adapter for local development
  - optional websocket quote overlay via `data/ws-quotes.json` (event-driven snapshot merge)
  - `live` adapter contract (via `QUOTE_ADAPTER_URL`) for OnchainOS-compatible quote service integration
  - async scan/autopilot/API opportunity endpoint path now supports `QUOTE_ADAPTER=live` with the same websocket+mempool overlay + net-profit gating flow
- Mempool-aware execution pressure
  - optional pending tx feed via `data/mempool.json`
  - adds pair-level slippage pressure into path scoring
  - raises gas safety estimate during congestion (`runtimeSignals.gasPressureMultiplier`)
- Streaming listener path (websocket + mempool)
  - supports **real websocket sockets** (`WS_QUOTES_URL`, `MEMPOOL_WS_URL`) with auto-reconnect for event-driven quote/mempool ingestion
  - file-watch fallback listeners (`fs.watchFile`) keep `ws-quotes` + `mempool` overlays hot in memory when sockets are not configured
  - scanner consumes cached overlays without per-scan file parse
  - stale signal filter drops old websocket/mempool events before routing/profit math (fail-closed freshness)
  - **execution guard now fail-closes** when websocket/mempool listener timestamps go stale or never bootstrap fresh updates after grace window (no auto-fill on missing/old stream state)
  - listener health metadata exposed in `runtimeSignals` (`listenerMode`: `socket|watch|poll`, `wsUpdatedAt`, `mempoolUpdatedAt`, stale-drop counters)
- Arbitrage scanner:
  - two-pool arbitrage with per-venue spread modeling
  - triangular arbitrage using token graph route simulation
  - best-path builder ranks single-hop vs multi-hop routes using execution-cost-aware scoring (estimated gas + router/bundle/flash-loan fees + complexity penalty + DEX-diversity bonus)
  - router/aggregator plan builder converts selected path into hop-level execution plan (`entryToken`, `exitToken`, `hops`, `expectedReturnUsd`, `minReturnUsd`)
- Profit model:
  - modeled gross profit / fees / slippage from scanner
  - mandatory pre-execution gas estimate (with safety multiplier)
  - gateway simulation net-return ingestion (`estimatedReturnUsd`/`estimatedNetUsd`) for execution-time net-profit math
  - fail-closed simulation/model net-deviation gate before execution
  - net profit after full execution costs (gas + router + bundle + flash-loan fees; threshold enforced)
- Risk engine:
  - fail-closed quote validation (missing fields / stale snapshots)
  - min profit threshold
  - max trade amount
  - liquidity-aware dynamic position sizing (`maxLiquidityUsagePct`)
  - per-leg minimum liquidity guard (`minLegLiquidityUsd`)
  - max slippage
  - deny token list
- Execution:
  - recheck-before-send
  - bounded retries
  - OnchainOS preflight chain: Wallet -> DEX tx build -> Security tx scan -> Gateway estimate/simulate
  - **preflight observability trace**: per-stage status + duration telemetry persisted for every paper/live execution attempt
  - **atomic preference path**: bundle-first execution plan with flash-loan-ready funding mode selection
  - **paper/live adapter parity**: paper mode also runs preflight (mock/live adapters) before fill
  - fail-closed preflight guard (blocks execution if any integration check fails, including atomic unavailability)
  - hard preflight latency guard (`MAX_PREFLIGHT_LATENCY_MS`) fail-closes slow execution plans before send
  - fail-closed gas-risk guard (blocks execution when gas cost share exceeds configured edge threshold)
  - tx hash + realized pnl record
- Loop mode:
  - adaptive interval loop (`setTimeout` so optimization affects next cycle)
  - **single-flight execution lock** prevents overlapping scans/executions (fail-closed when a prior run is still active)
  - **cross-process lock parity** persists single-flight lock to `data/execution-lock.json` so cron/autopilot/manual scans cannot overlap across different Node processes
  - **critical-alert circuit breaker**: autopilot fails closed before execution when critical runtime alerts are active (failure streak, missing live wallet session, high gas pressure, stuck execution lock)
- Opportunity + operations API:
  - `GET /opportunities`
  - `GET /metrics` (PnL ledger aggregates + recent execution window)
  - `GET /metrics/prometheus` (Prometheus/OpenMetrics text export for runtime + PnL + alert scraping, including gas-pressure, dropped-stream-event counters, preflight-latency average, and execution-lock gauges)
  - `GET /alerts` (runtime health alerts: failure streak, low execution rate, gas pressure, missing wallet session, stale websocket/mempool listener data)
  - `GET /dashboard` (lightweight HTML dashboard with recent trade PnL table)
  - `GET /dashboard-data` (dashboard JSON payload: metrics + alerts + recent trades)
- Alert escalation hooks:
  - optional webhook delivery for warning/critical alert snapshots (`ALERT_NOTIFY_WEBHOOK_URL`)
  - dedupe-aware delivery (same signature uses `alertDedupWindowMs` suppression)
  - repeated failure-reason burst detection (e.g. repeated gateway/security/preflight blocks) for faster root-cause triage
  - non-blocking delivery with timeout + error telemetry (`data/alert-notify-errors.jsonl`)
- Drawdown protection:
  - rolling 24h realized PnL warning + hard loss cap (`ALERT_MAX_DAILY_LOSS_USD`, `MAX_DAILY_LOSS_USD`)
  - hard cap emits critical alert and trips fail-closed execution circuit breaker
  - `GET /config`
  - `GET /session`
  - `GET /healthz`
  - `GET /control/autopilot/on`
  - `GET /control/autopilot/off`
  - `GET /control/mode/paper`
  - `GET /control/mode/live`
- Strategy optimization:
  - adaptive scan interval
  - adaptive amount/profit threshold from recent history
- Tests:
  - fail-closed validation (security block, gateway simulation/estimate failure, gas-profit gate)
  - two-pool detection
  - triangular detection
  - replay/backtest runner over historical snapshots
- Paper-trading soak mode:
  - repeated paper-mode execution loop with preflight checks still enabled
  - optional stop-on-critical alert behavior for safe unattended shakeout

## Run
```bash
npm run scan
npm run autopilot
npm run api
npm run backtest
npm run soak -- 120 500
npm test

# wallet/session controls
node src/cli.js status
node src/cli.js wallet-login 0x1234567890abcdef1234567890abcdef12345678
node src/cli.js mode live
node src/cli.js wallet-logout
```

## Environment
- `AUTOPILOT=true|false` (default true in `npm run autopilot` command path)
- `QUOTE_ADAPTER=mock|live` (default `mock`)
- `QUOTE_ADAPTER_URL=https://...` (required for `QUOTE_ADAPTER=live`)
- `WALLET_ADAPTER=mock|live` (default `mock`; `live` requires `WALLET_ADDRESS`)
- `DEX_ADAPTER=mock|live` (default `mock`; `live` currently enforces interface requirements and fail-closes)
- `SECURITY_ADAPTER=mock|live` (default `mock`; `live` currently enforces interface requirements and fail-closes)
- `GATEWAY_ADAPTER=mock|live` (default `mock`; `live` currently enforces interface requirements and fail-closes)
- `ROUTER_PROVIDER=onchainos-router` (optional router/aggregator provider label in preflight route plan)
- `SECURITY_FORCE_BLOCK=true` (test switch to force security block in mock mode)
- `GATEWAY_FORCE_SIM_FAIL=true` (test switch to force gateway simulation failure in mock mode)
- `GATEWAY_FORCE_MISSING_GAS=true` (test switch to force missing gas estimate in mock mode)
- `NATIVE_TOKEN_PRICE_USD=45` (override gas token USD price for pre-execution net-profit check)
- `MAX_EXECUTION_GAS_COST_SHARE=0.7` (fail-closed cap: block execution when gas cost / gross edge exceeds this ratio)
- `REQUIRE_SIMULATION_NET_PROFIT=true|false` (default `true`; fail-close execution when gateway simulation does not return net estimate)
- `MAX_SIMULATION_NET_DEVIATION_PCT=35` (fail-closed cap for deviation between modeled net and gateway simulated net)
- `ASSUMED_BASE_GAS=105000` (best-path scoring estimate baseline gas units)
- `ASSUMED_GAS_PER_SWAP_HOP=135000` (best-path scoring estimate gas units per swap hop)
- `ASSUMED_GAS_PRICE_GWEI=0.06` (best-path scoring estimate gas price)
- `ATOMIC_FORCE_DISABLE=true` (test switch to force atomic-preflight failure)
- `SOAK_ITERATIONS=120` (default iterations for `npm run soak`)
- `SOAK_INTERVAL_MS=1000` (delay between soak runs)
- `SOAK_STOP_ON_CRITICAL=true|false` (stop soak early on critical alerts)
- `PORT=8787` (api server)
- `WS_QUOTES_URL=wss://...` (optional real-time websocket feed for quote overlays; message payload supports `[rows]` or `{data:[rows]}`)
- `MEMPOOL_WS_URL=wss://...` (optional real-time websocket feed for pending tx overlays; payload supports `[rows]` or `{data:[rows]}`)
- `MAX_WS_SIGNAL_AGE_MS=12000` (optional freshness guard for websocket quote overlay; stale rows are dropped)
- `MAX_MEMPOOL_SIGNAL_AGE_MS=15000` (optional freshness guard for mempool feed; stale rows are dropped)
- `STREAMING_BOOTSTRAP_GRACE_MS=30000` (fail-closed bootstrap grace window; block execution if websocket/mempool listeners produce no fresh updates after this window)
- `ALERT_MAX_GAS_PRESSURE_MULTIPLIER=1.6` (critical alert threshold for mempool-driven gas multiplier)
- `ALERT_MAX_PREFLIGHT_LATENCY_MS=2500` (warning threshold for rolling average Wallet→DEX→Security→Gateway preflight latency)
- `MAX_PREFLIGHT_LATENCY_MS=5000` (hard fail-closed cap: block execution when single preflight latency exceeds threshold)
- `ALERT_MAX_DAILY_LOSS_USD=-20` (warning threshold for rolling 24h realized PnL drawdown)
- `MAX_DAILY_LOSS_USD=-30` (critical fail-closed cap for rolling 24h realized PnL; breaches pause execution)
- `ALERT_FAILURE_REASON_BURST_COUNT=4` (warning threshold: repeated identical failure reason count in alert window)
- `ALERT_DEDUP_WINDOW_MS=60000` (suppresses duplicate alert snapshots with the same signature inside the window)
- `ALERT_NOTIFY_WEBHOOK_URL=https://...` (optional monitoring webhook receiver for alert escalations)
- `ALERT_NOTIFY_MIN_LEVEL=critical|warning|info` (minimum level sent to webhook; default `critical`)
- `ALERT_NOTIFY_TIMEOUT_MS=3000` (webhook delivery timeout, non-blocking)
- `FAIL_CLOSED_ON_CRITICAL_ALERTS=true|false` (autopilot execution circuit breaker)
- `EXECUTION_LOCK_TTL_MS=120000` (single-flight lock TTL; overlapping runs fail-closed and stale lock is alerted as critical)
- `data/ws-quotes.json` (optional websocket quote snapshot overlay array)
- `data/mempool.json` (optional pending tx array for mempool pressure model)

## Config highlights
Default runtime risk config in `src/engine.js`:
- `minLegLiquidityUsd` (default `50000`)
- `maxLiquidityUsagePct` (default `2`)
- `failClosedOnMissingOnchainOS` (default `true`)
- `nativeTokenPriceUsd` (default `45`)
- `gasSafetyMultiplier` (default `1.15`)
- `routeComplexityPenaltyUsdPerHop` (default `0.2`) penalizes multi-hop route complexity in best-path ranking
- `routeDexDiversityBonusUsd` (default `0.05`) small bonus for route venue diversity in best-path ranking
- `assumedBaseGas` (default `105000`) execution-cost-aware routing score baseline gas estimate
- `assumedGasPerSwapHop` (default `135000`) extra gas estimate per hop for routing score
- `assumedGasPriceGwei` (default `0.06`) gas-price estimate used in routing score
- `routerFeeBps` (default `1`) aggregator/router execution fee included in net-profit gate
- `bundleFeeUsd` (default `0.15`) bundle execution overhead for atomic path
- `flashLoanFeeBps` (default `5`) flash-loan funding fee for larger trades
- `preflightInPaper` (default `true`) keeps paper mode fail-closed and gas-aware via preflight estimate/simulation
- `preferAtomicExecution` (default `true`) enforces bundle-first fail-closed execution planning
- `flashLoanMinUsd` (default `250`) marks larger trades as flash-loan-ready in preflight plan
- `maxWsSignalAgeMs` (default `12000`) freshness window for websocket overlay quotes
- `maxMempoolSignalAgeMs` (default `15000`) freshness window for mempool pending tx overlays
- `streamingBootstrapGraceMs` (default `30000`) max listener bootstrap time before missing-stream warnings fail-close execution
- `alertWindow` (default `20`) rolling sample size for runtime alert checks
- `alertMaxConsecutiveFailures` (default `5`) critical alert threshold
- `alertFailureReasonBurstCount` (default `4`) warning threshold for dominant repeated failure reason in recent window
- `alertMinExecutionRate` (default `0.2`) warning threshold when sample size >=5
- `alertMinRecentPnlUsd` (default `-5`) warning when rolling realized PnL drops below threshold
- `alertMaxGasCostShare` (default `0.6`) warning when gas/gross-net ratio is too high
- `maxExecutionGasCostShare` (default `0.7`) hard fail-closed cap for per-trade gas share gating before send
- `requireSimulationNetProfit` (default `true`) requires gateway simulation to provide `estimatedNetUsd` before execution
- `maxSimulationNetDeviationPct` (default `35`) hard fail-closed tolerance for simulation net vs modeled net divergence
- `alertMaxGasPressureMultiplier` (default `1.6`) critical alert when mempool-driven gas multiplier spikes
- `alertMaxPreflightLatencyMs` (default `2500`) warning alert when recent average preflight latency is degraded
- `maxPreflightLatencyMs` (default `5000`) hard fail-closed per-trade preflight timeout gate
- `alertMaxDailyLossUsd` (default `-20`) warning threshold for rolling 24h realized PnL drawdown
- `maxDailyLossUsd` (default `-30`) critical rolling 24h realized PnL loss cap; triggers execution fail-close
- `alertDedupWindowMs` (default `60000`) deduplicates repeated alert signatures in the alert log window
- `alertNotifyWebhookUrl` (default empty) optional webhook endpoint for alert escalation delivery
- `alertNotifyMinLevel` (default `critical`) escalation threshold for webhook notifications
- `alertNotifyTimeoutMs` (default `3000`) webhook timeout; delivery is non-blocking
- `failClosedOnCriticalAlerts` (default `true`) blocks autopilot execution when critical runtime alerts are active
- `executionLockTtlMs` (default `120000`) marks overlapping or hung run protection window for single-flight execution

## Data output
Execution log file:
- `data/executions.jsonl` (includes `runId`, `tradeAmountUsd`, `gasCostUsd`, `executionCostUsd`, `netAfterGasUsd`, `netAfterAllCostsUsd`, `mode`, and wallet context)

Preflight trace log file:
- `data/preflight.jsonl` (one row per execution attempt with `runId` + `phase`, stage-by-stage telemetry: wallet/router/dex/security/gateway/atomic, per-stage `status`, per-stage `durationMs`, and total preflight latency)

Route decision observability log file:
- `data/route-decisions.jsonl` (one row per scan loop with `runId`, selected best path + top ranked routing candidates, routing score, estimated execution cost, and risk pass/fail reasons)

Alert log file:
- `data/alerts.jsonl` (appends active alert snapshots with optional `runId`/`phase`; duplicate signatures are deduplicated within `alertDedupWindowMs`)

Alert webhook error log file:
- `data/alert-notify-errors.jsonl` (delivery failures/timeouts/non-2xx responses for external alert webhooks)

Session state file:
- `data/runtime-state.json` (autopilot + mode + wallet login persistence)

Execution lock file:
- `data/execution-lock.json` (cross-process single-flight lock metadata: owner/pid/mode/sinceMs; stale lock auto-expires via `EXECUTION_LOCK_TTL_MS`)

Backtest files:
- input: `data/historical-snapshots.json` (array of `{ ts, quotes[], pendingTxs[] }`)
- output: `data/backtest-report.json` (aggregate execution/pnl report + per-snapshot runs)
