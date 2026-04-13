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
- Mempool-aware execution pressure
  - optional pending tx feed via `data/mempool.json`
  - adds pair-level slippage pressure into path scoring
  - raises gas safety estimate during congestion (`runtimeSignals.gasPressureMultiplier`)
- Streaming listener path (websocket + mempool)
  - file-watch listeners (`fs.watchFile`) keep `ws-quotes` + `mempool` overlays hot in memory
  - scanner consumes cached overlays without per-scan file parse
  - listener health metadata exposed in `runtimeSignals` (`listenerMode`, `wsUpdatedAt`, `mempoolUpdatedAt`)
- Arbitrage scanner:
  - two-pool arbitrage with per-venue spread modeling
  - triangular arbitrage using token graph route simulation
  - best-path builder ranks single-hop vs multi-hop routes with complexity penalty + DEX-diversity bonus (router-ready scoring)
- Profit model:
  - gross profit
  - fees
  - slippage
  - pre-execution gas estimate (with safety multiplier)
  - net profit after gas (must stay above threshold before execution)
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
  - **atomic preference path**: bundle-first execution plan with flash-loan-ready funding mode selection
  - **paper/live adapter parity**: paper mode also runs preflight (mock/live adapters) before fill
  - fail-closed preflight guard (blocks execution if any integration check fails, including atomic unavailability)
  - tx hash + realized pnl record
- Loop mode:
  - adaptive interval loop (`setTimeout` so optimization affects next cycle)
- Opportunity + operations API:
  - `GET /opportunities`
  - `GET /metrics` (PnL ledger aggregates + recent execution window)
  - `GET /dashboard` (lightweight HTML dashboard)
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
  - fail-closed validation
  - two-pool detection
  - triangular detection
  - replay/backtest runner over historical snapshots

## Run
```bash
npm run scan
npm run autopilot
npm run api
npm run backtest
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
- `SECURITY_FORCE_BLOCK=true` (test switch to force security block in mock mode)
- `NATIVE_TOKEN_PRICE_USD=45` (override gas token USD price for pre-execution net-profit check)
- `ATOMIC_FORCE_DISABLE=true` (test switch to force atomic-preflight failure)
- `PORT=8787` (api server)
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
- `preflightInPaper` (default `true`) keeps paper mode fail-closed and gas-aware via preflight estimate/simulation
- `preferAtomicExecution` (default `true`) enforces bundle-first fail-closed execution planning
- `flashLoanMinUsd` (default `250`) marks larger trades as flash-loan-ready in preflight plan

## Data output
Execution log file:
- `data/executions.jsonl` (includes `tradeAmountUsd`, `gasCostUsd`, `netAfterGasUsd`, `mode`, and wallet context)

Session state file:
- `data/runtime-state.json` (autopilot + mode + wallet login persistence)

Backtest files:
- input: `data/historical-snapshots.json` (array of `{ ts, quotes[], pendingTxs[] }`)
- output: `data/backtest-report.json` (aggregate execution/pnl report + per-snapshot runs)
