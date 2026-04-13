# X Layer Arbitrage Executor

NIUMA skill/project scaffold for automated arbitrage execution on X Layer.

## Features
- Multi-DEX market snapshot (mock scaffold, ready for live OnchainOS quote adapters)
- Arbitrage scanner:
  - two-pool arbitrage
  - triangular arbitrage
- Profit model:
  - gross profit
  - fees
  - slippage
  - net profit
- Risk engine:
  - min profit threshold
  - max trade amount
  - max slippage
  - deny token list
- Execution:
  - recheck-before-send
  - tx hash + realized pnl record
- Loop mode:
  - scan -> judge -> execute repeatedly
- Opportunity API:
  - `GET /opportunities`
  - `GET /control/autopilot/on`
  - `GET /control/autopilot/off`
- Strategy optimization:
  - adaptive scan interval
  - adaptive amount/profit threshold from recent history

## Run
```bash
npm run scan
npm run autopilot
npm run api
```

## Data output
Execution log file:
- `data/executions.jsonl`
