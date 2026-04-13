const test = require('node:test');
const assert = require('node:assert/strict');
const { state, validateMarket, detectTwoPool, detectTriangular, riskCheck } = require('../src/engine');

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
