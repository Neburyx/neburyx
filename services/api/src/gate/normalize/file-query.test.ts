import { describe, expect, it } from 'vitest';
import { EMPTY_MODEL } from './model.js';
import { normalizeFileQuery } from './file-query.js';

describe('the bound of a whole file-query result', () => {
  it('refuses when the context has no count cap, so the bound is never skipped', () => {
    expect(() => normalizeFileQuery({ sourceId: 'alpha', hasMore: false, model: EMPTY_MODEL, limit: 50 }, [])).toThrow();
  });
});
