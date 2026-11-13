import { describe, expect, it } from 'vitest';
import { estimateOf } from './template-probes.js';

const SCOPE = 'template:shared-attribute:estimate';

describe('the estimate of a probe read', () => {
  it('is exact at most the threshold when no bound of the read was reached, whatever the count, exactly the threshold included', () => {
    for (const matches of [0, 2, 3]) expect(estimateOf({ matches, bounded: false }, 3, SCOPE)).toEqual({ estimate: { value: matches, quality: 'exact', scope: SCOPE }, heavy: false });
  });

  it('is a lower bound with the value counted, and no warning, when a bound of the read was reached below the threshold', () => {
    expect(estimateOf({ matches: 2, bounded: true }, 3, SCOPE)).toEqual({ estimate: { value: 2, quality: 'lowerBound', scope: SCOPE }, heavy: false });
  });

  it('is a lower bound at the threshold, and heavy, when the probe read one match more than the threshold, whether or not a bound was reached', () => {
    for (const bounded of [false, true]) expect(estimateOf({ matches: 4, bounded }, 3, SCOPE)).toEqual({ estimate: { value: 3, quality: 'lowerBound', scope: SCOPE }, heavy: true });
  });
});
