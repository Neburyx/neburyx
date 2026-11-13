import { describe, expect, it } from 'vitest';
import { normalizePatternCount } from '../gate/normalize/pattern-count.js';
import { parsedPatternParams, patternAllowlist, step } from '../testing/pattern-fixtures.js';
import { defaultTemplateProbes, estimateOf } from './template-probes.js';

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

describe('the probe of the pattern template', () => {
  const probe = defaultTemplateProbes().get('pattern');
  const allowlist = patternAllowlist();
  const params = parsedPatternParams([step()]);
  const read = (row: Record<string, unknown>) => probe?.read(normalizePatternCount([row]), params, allowlist);

  it('reads a count of at most the threshold as exact when nothing was bounded or left out, and as a lower bound with the value counted when a step was cut or an entity was left out; none of them warns', () => {
    const exact = read({ matches: 3, bounded: false, stopListed: false, supernodes: 0 });
    expect(exact && estimateOf(exact, 3, SCOPE)).toEqual({ estimate: { value: 3, quality: 'exact', scope: SCOPE }, heavy: false });
    for (const row of [{ matches: 3, bounded: true }, { matches: 3, stopListed: true }, { matches: 3, supernodes: 1 }]) {
      const bounded = read(row);
      expect(bounded && estimateOf(bounded, 3, SCOPE)).toEqual({ estimate: { value: 3, quality: 'lowerBound', scope: SCOPE }, heavy: false });
    }
  });

  it('reads one more than the threshold as heavy, a lower bound at the threshold', () => {
    const over = read({ matches: 4 });
    expect(over && estimateOf(over, 3, SCOPE)).toEqual({ estimate: { value: 3, quality: 'lowerBound', scope: SCOPE }, heavy: true });
  });

  it('gives no entity in its notices: a supernode or a stop-listed entity makes it bounded and adds no notice of its own', () => {
    const left = read({ matches: 1, bounded: false, stopListed: true, supernodes: 2 });
    expect(left?.bounded).toBe(true);
    expect(left?.notices.map((notice) => notice.code)).not.toContain('supernodesSkipped');
    expect(left?.notices.map((notice) => notice.code)).not.toContain('stopListSkipped');
    expect(read({ matches: 1, bounded: true })?.notices.map((notice) => notice.code)).toContain('readBounded');
  });

  it('reads nothing from an item that is not a pattern count', () => {
    expect(probe?.read({ estimateKind: 'other' }, params, allowlist)).toBeUndefined();
  });
});
