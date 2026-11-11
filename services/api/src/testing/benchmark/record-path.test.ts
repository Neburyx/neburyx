import { describe, expect, it } from 'vitest';
import { recordDirectory } from './record-path.js';

describe('recordDirectory', () => {
  it('is the committed benchmarks folder when the variable is not set or is empty', () => {
    expect(recordDirectory({})).toMatch(/docs\/benchmarks$/);
    expect(recordDirectory({ NBX_BENCH_RECORD_DIR: '' })).toBe(recordDirectory({}));
  });

  it('is the folder the variable names', () => {
    expect(recordDirectory({ NBX_BENCH_RECORD_DIR: '/tmp/bench-out' })).toBe('/tmp/bench-out');
  });
});
