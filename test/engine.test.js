const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMarket, detectTwoPool, detectTriangular } = require('../src/engine');

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
