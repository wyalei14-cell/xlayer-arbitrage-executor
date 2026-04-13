const test = require('node:test');
const assert = require('node:assert/strict');
const { state, validateMarket, detectTwoPool, detectTriangular, riskCheck, executeOpportunity, buildOnchainExecutionPlan } = require('../src/engine');

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
    legs: [
      { liqUsd: 49_000 },
      { liqUsd: 100_000 }
    ],
    tradeAmountUsd: 100,
    slippageUsd: 0.5,
    netProfitUsd: 10
  };
  const out = riskCheck(opp);
  assert.equal(out.pass, false);
  assert.equal(out.reason, 'liquidity-too-low');
});

test('buildOnchainExecutionPlan fail-closes when live wallet adapter is missing env', () => {
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

test('executeOpportunity blocks when security scan flags transaction', () => {
  const prev = process.env.SECURITY_FORCE_BLOCK;
  process.env.SECURITY_FORCE_BLOCK = 'true';

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
