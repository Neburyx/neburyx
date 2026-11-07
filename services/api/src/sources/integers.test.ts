import neo4j from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { callFor, rig, useClock } from '../testing/source-rig.js';
import { prepareParameters } from './parameters.js';

function integerValue(value: unknown): number {
  if (!neo4j.isInt(value)) throw new Error('expected a driver integer');
  return value.toNumber();
}

describe('prepareParameters', () => {
  it('turns the count cap of a degree read into a driver integer without a declaration', () => {
    expect(integerValue(prepareParameters({ countCap: 500, limit: 1 }, [])['countCap'])).toBe(500);
  });

  it('turns the page limit into a driver integer, with or without a declaration', () => {
    expect(integerValue(prepareParameters({ limit: 4 }, [])['limit'])).toBe(4);
  });

  it('turns a declared integer parameter that is a safe integer into a driver integer', () => {
    expect(integerValue(prepareParameters({ k: 7, limit: 1 }, ['k'])['k'])).toBe(7);
  });

  it('leaves an undeclared whole number as a JavaScript number', () => {
    expect(prepareParameters({ k: 2 }, [])).toEqual({ k: 2 });
  });

  it('leaves a declared integer beyond 2^53 and a non-integer as they are', () => {
    const big = 2 ** 53 + 2;
    expect(prepareParameters({ k: big, f: 1.5 }, ['k', 'f'])).toEqual({ k: big, f: 1.5 });
  });

  it('does not reach into lists or other values, and does not convert a text that looks like a number', () => {
    const prepared = prepareParameters({ k: [1, 2], s: '3', limit: 2 }, ['k', 's']);
    expect(prepared['k']).toEqual([1, 2]);
    expect(prepared['s']).toBe('3');
  });

  it('keeps a parameter named like an object property as an own key', () => {
    const prepared = prepareParameters(JSON.parse('{"__proto__": 1, "limit": 1}'), ['__proto__']);
    expect(Object.hasOwn(prepared, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(prepared)).toBe(Object.prototype);
  });

  it('does not change the object it was given', () => {
    const given = { k: 7, limit: 3 };
    prepareParameters(given, ['k']);
    expect(given).toEqual({ k: 7, limit: 3 });
  });
});

describe('the adapter', () => {
  it('hands the driver the limit and the declared integers as driver integers, and every other value unchanged', async () => {
    useClock();
    const { executor, fake } = rig({ rows: [] });
    const big = 2 ** 53 + 2;
    await executor.execute(callFor({ parameters: { limit: 4, k: 7, undeclared: 2, huge: big, list: [1, 2] }, integerParameters: ['k', 'huge'] }));
    const [query] = fake.drivers[0]?.sessions[0]?.queries ?? [];
    expect(integerValue(query?.parameters['limit'])).toBe(4);
    expect(integerValue(query?.parameters['k'])).toBe(7);
    expect(query?.parameters['undeclared']).toBe(2);
    expect(query?.parameters['huge']).toBe(big);
    expect(query?.parameters['list']).toEqual([1, 2]);
    await executor.close();
  });
});
