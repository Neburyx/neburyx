import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid.js';

describe('uuidv7', () => {
  it('has version 7 and the RFC variant', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('starts with the millisecond time, so later ids sort after earlier ones', () => {
    const early = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_700_000_000_001);
    expect(early.replace('-', '').slice(0, 12)).toBe((1_700_000_000_000).toString(16).padStart(12, '0'));
    expect(early < later).toBe(true);
  });

  it('does not repeat within one millisecond', () => {
    expect(new Set(Array.from({ length: 1000 }, () => uuidv7(1_700_000_000_000))).size).toBe(1000);
  });
});
