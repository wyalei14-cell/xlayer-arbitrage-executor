---
name: xlayer-arbitrage-executor
description: Build and operate an X Layer arbitrage execution skill that scans multi-DEX prices, detects two-pool and triangular arbitrage, estimates net profit after fees/slippage, enforces risk controls, executes via OnchainOS + Agentic Wallet, records tx outcomes, exposes opportunity APIs, supports autopilot/manual modes, and adapts strategy parameters from historical performance.
---

# X Layer Arbitrage Executor

Implement an arbitrage engine with these mandatory stages:

1. Fetch market quotes/liquidity from X Layer DEX routes.
2. Detect two-pool and triangular opportunities.
3. Compute gross/net profit (fees + slippage included).
4. Enforce risk gates before execution.
5. Re-check quote before sending transaction.
6. Execute route via OnchainOS swap path when `autopilot=true`.
7. Persist execution results (path, tx hash, pnl, reason).
8. Continuously loop and optimize thresholds from historical outcomes.

## Runtime commands

- `npm run scan` : single arbitrage scan
- `npm run autopilot` : loop scan->judge->execute
- `npm run api` : expose REST endpoints for opportunities and control

## Safety requirements

- Fail closed when quote fields are missing.
- Block tokens in denylist.
- Reject trades over max amount or max slippage.
- Require minimum net profit threshold.
- Dry-run by default unless `AUTOPILOT=true`.

## Required records

Write JSONL records to `data/executions.jsonl` with:

- timestamp
- route type and path
- quote snapshot
- expected gross/net profit
- tx hash (if executed)
- success/failure + reason

## Optimization loop

After each cycle, update:

- `scanIntervalMs`
- `tradeAmount`
- `minNetProfitUsd`

using recent success rate and realized pnl.
