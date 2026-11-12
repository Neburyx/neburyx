import { describe, expect, it } from 'vitest';
import { MAX_CONNECT_TIMEOUT_MS, MIN_CONNECT_TIMEOUT_MS, parseConnectTimeout } from './connect-timeout.js';

describe('parseConnectTimeout', () => {
  it.each([undefined, ''])('is the default of 10 000 ms when the value is %j', (value) => {
    expect(parseConnectTimeout(value)).toBe(10_000);
  });

  it.each([String(MIN_CONNECT_TIMEOUT_MS), '25000', String(MAX_CONNECT_TIMEOUT_MS)])('accepts %s', (value) => {
    expect(parseConnectTimeout(value)).toBe(Number(value));
  });

  it.each(['999', '120001', '0', '-5', '1.5', '1e4', 'ten', ' 5000', '5000 '])('refuses %j', (value) => {
    expect(parseConnectTimeout(value)).toBeUndefined();
  });
});
