import { expandRequestSchema, type ExpandFilter, type ExpandRank } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { baseSource, firstSource, load } from '../../testing/mapping.js';
import { allowlistFromMapping } from '../allowlist.js';
import { renderTemplate } from '../render.js';
import type { Template } from '../types.js';
import { expandNeighborsTemplate } from './expand-neighbors.js';
import { expandBranchesOf, expandStatementOf, undeclaredFilter, undeclaredRank } from './expand-statement.js';

const allowlist = allowlistFromMapping(
  firstSource(
    load(
      baseSource({
        entities: [
          { type: 'hub', label: 'Hub', stable_id: 'hubId' },
          { type: 'leaf', label: 'Leaf', stable_id: 'leafId', filterable: ['band', 'size'], sortable: ['size'], pii: ['secret'] },
        ],
        relationships: [
          { type: 'LINKED', from: 'hub', to: 'leaf', stable_id: 'relId', observed_at: 'seenAt', filterable: ['score'], sortable: ['score'] },
          { type: 'MET', from: 'hub', to: 'leaf', filterable: ['weight'] },
        ],
      }),
    ),
  ),
);
const branches = expandBranchesOf(allowlist, 'hub', 'leaf', undefined, 'out');
const eq = (on: 'neighbor' | 'relationship', property: string, value: string): ExpandFilter => ({ on, property, op: 'eq', value: { kind: 'text', value } });
const base = { entityType: 'hub', stableId: 'H-1', neighborType: 'leaf', direction: 'out', sort: 'observed' };
const parse = (filters: unknown) => expandNeighborsTemplate.paramsSchema.safeParse({ ...base, ...(filters === undefined ? {} : { filters }) });

describe('the statement of a filtered expansion', () => {
  it('is today\'s statement when there is no filter', () => {
    expect(expandStatementOf(allowlist, 'hub', 'leaf', branches)).toBe(expandStatementOf(allowlist, 'hub', 'leaf', branches, []));
    expect(expandStatementOf(allowlist, 'hub', 'leaf', branches)).not.toContain('$filters');
  });

  it('puts a neighbor condition in every branch, stored and aggregate, with the name from the mapping and the value as a parameter', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', branches, [eq('neighbor', 'band', 'SECRET-VALUE-1')]);
    expect(text).toContain('m.`band` IS :: STRING NOT NULL AND m.`band` = $filters[0].value.value');
    expect(text).not.toContain('SECRET-VALUE-1');
    const parts = text.split('UNION ALL');
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part).toContain('m.`band`');
  });

  it('puts a relationship condition before an aggregate groups, so its members are the matching ones', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', expandBranchesOf(allowlist, 'hub', 'leaf', ['MET'], 'out'), [{ on: 'relationship', property: 'weight', op: 'between', from: { kind: 'number', value: 1 } }]);
    expect(text).toContain('WHERE ((r.`weight`');
    expect(text.indexOf('r.`weight`')).toBeLessThan(text.indexOf('count(r)'));
    expect(text).toContain('r.`weight` >= $filters[0].from.value');
    expect(text).not.toContain('<=');
  });

  it.each([
    ['date', 'date($filters[0].value.value)', 'DATE'],
    ['dateTime', 'datetime($filters[0].value.value)', 'ZONED DATETIME'],
    ['localDateTime', 'localdatetime($filters[0].value.value)', 'LOCAL DATETIME'],
    ['time', 'time($filters[0].value.value)', 'ZONED TIME'],
    ['localTime', 'localtime($filters[0].value.value)', 'LOCAL TIME'],
  ] as const)('compares %s with a value of that kind, and only a stored value of that kind', (kind, converted, type) => {
    const value = { date: '2024-03-01', dateTime: '2024-03-01T10:00:00Z', localDateTime: '2024-03-01T10:00:00', time: '10:00:00Z', localTime: '10:00:00' }[kind];
    const text = expandStatementOf(allowlist, 'hub', 'leaf', branches, [{ on: 'neighbor', property: 'band', op: 'eq', value: { kind, value } }]);
    expect(text).toContain(`m.\`band\` IS :: ${type} NOT NULL`);
    expect(text).toContain(converted);
  });

  it('reads a number from an integer or a float, and a list from the parameter', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', branches, [{ on: 'neighbor', property: 'size', op: 'in', values: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }] }]);
    expect(text).toContain('(m.`size` IS :: INTEGER NOT NULL OR m.`size` IS :: FLOAT NOT NULL)');
    expect(text).toContain('m.`size` IN [v IN $filters[0].values | v.value]');
  });
});

describe('which properties a filter may name', () => {
  it('accepts a declared neighbor property, a declared relationship property of every row read, and the observed time of a row', () => {
    expect(undeclaredFilter(allowlist, 'leaf', branches, [eq('neighbor', 'band', 'x')])).toBeUndefined();
    expect(undeclaredFilter(allowlist, 'leaf', expandBranchesOf(allowlist, 'hub', 'leaf', ['LINKED'], 'out'), [eq('relationship', 'score', 'x'), eq('relationship', 'seenAt', 'x')])).toBeUndefined();
  });

  it('refuses an undeclared neighbor property, a relationship property that one of the rows read does not declare, and a stable id that is not listed', () => {
    expect(undeclaredFilter(allowlist, 'leaf', branches, [eq('neighbor', 'leafId', 'x')])).toBeDefined();
    expect(undeclaredFilter(allowlist, 'leaf', branches, [eq('neighbor', 'score', 'x')])).toBeDefined();
    expect(undeclaredFilter(allowlist, 'leaf', branches, [eq('relationship', 'score', 'x')])).toBeDefined();
    expect(undeclaredFilter(allowlist, 'leaf', branches, [eq('relationship', 'band', 'x')])).toBeDefined();
  });

  it('refuses at the render, so nothing reaches the server, an undeclared name or a shape outside the closed set', () => {
    const render = (filters: unknown) => {
      const parsed = parse(filters);
      if (!parsed.success) return 'schema';
      try {
        renderTemplate(expandNeighborsTemplate as Template, parsed.data, allowlist, 10);
        return 'rendered';
      } catch (error) {
        return error instanceof AppError ? error.code : 'other';
      }
    };
    expect(render([eq('neighbor', 'band', 'x')])).toBe('rendered');
    expect(render([eq('neighbor', 'nope', 'x')])).toBe('INVALID_REQUEST');
    expect(render([eq('neighbor', 'band`) RETURN 1 //', 'x')])).toBe('INVALID_REQUEST');
    expect(render([{ on: 'neighbor', property: 'band', op: 'contains', value: { kind: 'text', value: 'x' } }])).toBe('schema');
    expect(render([{ on: 'neighbor', property: 'band', op: 'between' }])).toBe('schema');
  });
});

describe('the filters of a request', () => {
  const body = { sourceId: 's', ref: { entityType: 'hub', stableId: 'H-1' }, neighborTypes: ['leaf'] };
  const accepts = (filters: unknown) => expandRequestSchema.safeParse({ ...body, filters }).success;
  const number = (value: number) => ({ kind: 'number', value });

  it('holds at least one condition: an empty list is not a request with no filter', () => {
    expect(accepts([])).toBe(false);
    expect(expandRequestSchema.safeParse(body).success).toBe(true);
  });

  it('holds at most 6 conditions, an `in` of 1 to 20 values of one kind, and a `between` with an end', () => {
    expect(accepts(Array.from({ length: 6 }, (_unused, index) => eq('neighbor', `p${index}`, 'x')))).toBe(true);
    expect(accepts(Array.from({ length: 7 }, (_unused, index) => eq('neighbor', `p${index}`, 'x')))).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'in', values: Array.from({ length: 20 }, (_unused, index) => number(index)) }])).toBe(true);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'in', values: Array.from({ length: 21 }, (_unused, index) => number(index)) }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'in', values: [] }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'in', values: [number(1), { kind: 'text', value: 'a' }] }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'between', from: number(1) }])).toBe(true);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'between' }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'between', from: number(1), to: { kind: 'text', value: 'a' } }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'between', from: { kind: 'boolean', value: false } }])).toBe(false);
  });

  it('refuses a number that is not exact or not finite, and text that is not an ISO value of its kind', () => {
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: number(2 ** 53) }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: number(0.5) }])).toBe(true);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'date', value: '2024-02-30' } }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'date', value: '2024-02-29' } }])).toBe(true);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'dateTime', value: '2024-03-01T10:00:00' } }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'localDateTime', value: '2024-03-01T10:00:00' } }])).toBe(true);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'time', value: '25:00:00Z' } }])).toBe(false);
    expect(accepts([{ on: 'neighbor', property: 'p', op: 'eq', value: { kind: 'text', value: 'x', extra: 1 } }])).toBe(false);
  });

  it('is the same request, with the same cursor, when the conditions or the values of an `in` come in another order or twice', () => {
    const left = parse([eq('neighbor', 'band', 'b'), { on: 'neighbor', property: 'size', op: 'in', values: [{ kind: 'number', value: 2 }, { kind: 'number', value: 1 }] }]);
    const right = parse([{ on: 'neighbor', property: 'size', op: 'in', values: [{ kind: 'number', value: 1 }, { kind: 'number', value: 2 }, { kind: 'number', value: 1 }] }, eq('neighbor', 'band', 'b'), eq('neighbor', 'band', 'b')]);
    expect(left.success && right.success).toBe(true);
    expect(left.success && right.success ? left.data : 0).toEqual(right.success ? right.data : 1);
  });
});

describe('the statement of a ranked expansion', () => {
  const rank = (order: 'asc' | 'desc', on: 'neighbor' | 'relationship' = 'relationship', property = 'score'): ExpandRank => ({ on, property, order });
  const linked = expandBranchesOf(allowlist, 'hub', 'leaf', ['LINKED'], 'out');
  const noted = expandBranchesOf(allowlist, 'hub', 'leaf', ['MET'], 'out');

  it('orders each branch, the whole page and the rows after the cursor the same way, descending', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', linked, [], rank('desc'));
    expect(text).toContain('r.`score` DESC, toString(r.`relId`) DESC');
    expect(text).toContain('ORDER BY phase, sk, sv DESC, id DESC, rtype DESC, dir DESC');
    expect(text).toContain('r.`score` < CASE $cursor.tk');
    expect(text).not.toContain('r.`score` > CASE $cursor.tk');
  });

  it('flips the sort value in all three places when ascending, and nothing else: kinds still go up and ties still go down', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', linked, [], rank('asc'));
    expect(text).toContain('r.`score` ASC, toString(r.`relId`) DESC');
    expect(text).toContain('ORDER BY phase, sk, sv ASC, id DESC, rtype DESC, dir DESC');
    expect(text).toContain('r.`score` > CASE $cursor.tk');
    expect(text).toContain('> $cursor.tk');
    expect(text).not.toContain('r.`score` < CASE $cursor.tk');
  });

  it('keeps the observed times of an aggregate in their own columns and ranks by the largest (descending) or smallest (ascending) member', () => {
    const desc = expandStatementOf(allowlist, 'hub', 'leaf', noted, [], rank('desc'));
    expect(desc).toContain('max(CASE WHEN');
    expect(desc).toMatch(/AS ts, null AS first|min\(CASE WHEN[^)]*seenAt[^)]*\) THEN r\.`seenAt` END\) AS first/);
    expect(desc).toContain(' AS sv, coalesce(toString(m.`leafId`)');
    expect(desc).toContain('AS sk, ');
    const asc = expandStatementOf(allowlist, 'hub', 'leaf', noted, [], rank('asc'));
    expect(asc).toMatch(/min\(CASE WHEN \(r\.`score`[^]*?END\) AS sv/);
  });

  it('ranks by a neighbor property read from the neighbor, grouped with it', () => {
    const text = expandStatementOf(allowlist, 'hub', 'leaf', noted, [], rank('desc', 'neighbor', 'size'));
    expect(text).toContain('THEN m.`size` END AS sv');
    expect(text).not.toMatch(/max\(CASE WHEN \(m\./);
  });

  it('includes the undated rows of a branch with no observed time, because every row now has a sort value or none', () => {
    const plain = expandBranchesOf(allowlist, 'hub', 'leaf', ['MET'], 'out');
    expect(expandStatementOf(allowlist, 'hub', 'leaf', plain, [], rank('desc')).split('UNION ALL')).toHaveLength(2);
  });

  it('only names a sortable property: a neighbor property, a row property of every row read, or a row\'s observed time', () => {
    expect(undeclaredRank(allowlist, 'leaf', linked, rank('desc'))).toBe(false);
    expect(undeclaredRank(allowlist, 'leaf', linked, rank('desc', 'relationship', 'seenAt'))).toBe(false);
    expect(undeclaredRank(allowlist, 'leaf', linked, rank('desc', 'neighbor', 'size'))).toBe(false);
    expect(undeclaredRank(allowlist, 'leaf', linked, rank('desc', 'neighbor', 'band'))).toBe(true);
    expect(undeclaredRank(allowlist, 'leaf', branches, rank('desc'))).toBe(true);
    expect(undeclaredRank(allowlist, 'leaf', linked, rank('desc', 'relationship', 'weight'))).toBe(true);
  });
});
