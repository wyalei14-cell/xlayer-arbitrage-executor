# X Layer Arbitrage Executor

NIUMA skill/project scaffold for automated arbitrage execution on X Layer.

## Features
- Quote adapters
  - `mock` adapter for local development
  - `live` adapter contract (via `QUOTE_ADAPTER_URL`) for OnchainOS-compatible quote service integration
- Arbitrage scanner:
  - two-pool arbitrage with per-venue spread modeling
  - triangular arbitrage using token graph route simulation
- Profit model:
  - gross profit
  - fees
  - slippage
  - net profit
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
  - tx hash + realized pnl record
- Loop mode:
  - adaptive interval loop (`setTimeout` so optimization affects next cycle)
- Opportunity API:
  - `GET /opportunities`
  - `GET /config`
  - `GET /healthz`
  - `GET /control/autopilot/on`
  - `GET /control/autopilot/off`
- Strategy optimization:
  - adaptive scan interval
  - adaptive amount/profit threshold from recent history
- Tests:
  - fail-closed validation
  - two-pool detection
  - triangular detection

## Run
```bash
npm run scan
npm run autopilot
npm run api
npm test
```

## Environment
- `AUTOPILOT=true|false` (default true in `npm run autopilot` command path)
- `QUOTE_ADAPTER=mock|live` (default `mock`)
- `QUOTE_ADAPTER_URL=https://...` (required for `QUOTE_ADAPTER=live`)
- `PORT=8787` (api server)

## Config highlights
Default runtime risk config in `src/engine.js`:
- `minLegLiquidityUsd` (default `50000`)
- `maxLiquidityUsagePct` (default `2`)

## Data output
Execution log file:
- `data/executions.jsonl` (includes `tradeAmountUsd` per attempt)
