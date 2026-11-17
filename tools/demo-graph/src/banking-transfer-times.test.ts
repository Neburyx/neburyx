import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readDefinition } from './definition.js';
import { generate } from './generate.js';
import { readMappingSource } from './mapping.js';
import { packFiles } from './packs.js';

const files = packFiles('banking-fraud');
const mapping = readMappingSource(files.mapping);
const definition = readDefinition(files.definition, mapping);
const data = generate(mapping, definition, definition.seed);
const account = (index: number): string => `AC-${String(index).padStart(7, '0')}`;
const hashOf = (lines: readonly string[]): string => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);

interface Transfer {
  readonly f: string;
  readonly t: string;
  readonly at: number | undefined;
}
const transfers: Transfer[] = (data.files.find((file) => file.type === 'TRANSFERRED_TO')?.lines ?? []).map((line) => {
  const { f, t, p } = JSON.parse(line) as { f: string; t: string; p: { transferredAt?: { $datetime?: string } } };
  const value = p.transferredAt?.$datetime;
  return { f, t, at: value === undefined ? undefined : Date.parse(value) };
});
const between = (from: number, to: number): Transfer[] => transfers.filter((transfer) => transfer.f === account(from) && transfer.t === account(to));

describe('the banking pack with a time on its transfers', () => {
  it('leaves every generated file but the transfers byte-identical to what it was before the time was added (pinned by hash)', () => {
    const expected: Record<string, string> = {
      'entity:account': '58416ec07ba623cd',
      'entity:customer': '7fc6b94d140ce001',
      'entity:device': '0c653b7d9fba8069',
      'entity:ip_address': '5249de41eb434677',
      'entity:transaction': 'a135d5b188914122',
      'entity:merchant': '83cbe6308753b65b',
      'relationship:HOLDS_ACCOUNT': '5abeca307e1c76ee',
      'relationship:USES_DEVICE': '214a9e24373b07cb',
      'relationship:CONNECTS_FROM': '708d5155ba21c545',
      'relationship:INITIATED': '98da245052c61f82',
      'relationship:PAID_TO': '0603dcb3ed1bb267',
    };
    const actual = Object.fromEntries(data.files.filter((file) => `${file.kind}:${file.type}` in expected).map((file) => [`${file.kind}:${file.type}`, hashOf(file.lines)]));
    expect(actual).toEqual(expected);
  });

  it('keeps the transfers of before as they were: the same first 12,034 endpoint pairs, in the same order, with the time removed, and the rows of the typologies come after them (pinned by hash)', () => {
    const lines = data.files.find((file) => file.type === 'TRANSFERRED_TO')?.lines ?? [];
    expect(lines.length).toBeGreaterThan(12_034);
    const before = lines.slice(0, 12_034).map((line) => {
      const { f, t } = JSON.parse(line) as { f: string; t: string };
      return JSON.stringify({ f, t, p: {} });
    });
    expect(hashOf(before)).toBe('d8b256011bf61099');
  });

  it('keeps every transfer line of before, times included, byte for byte, and appends only the two lines of the chain that is later than a day (pinned by hash)', () => {
    const lines = data.files.find((file) => file.type === 'TRANSFERRED_TO')?.lines ?? [];
    expect(lines).toHaveLength(12_067);
    expect(hashOf(lines.slice(0, 12_065))).toBe('5c040799390cf0f4');
    const appended = lines.slice(12_065).map((line) => JSON.parse(line) as { f: string; t: string });
    expect(appended.map((row) => [row.f, row.t])).toEqual([[account(7320), account(7321)], [account(7321), account(7322)]]);
  });

  it('gives a time to every transfer but a small share, which stays without one so that the left-out path is shown', () => {
    const untimed = transfers.filter((transfer) => transfer.at === undefined).length;
    expect(untimed).toBeGreaterThan(0);
    expect(untimed / transfers.length).toBeLessThan(0.15);
    for (const typology of [between(7000, 7001), between(7101, 7100), between(7200, 7201), between(7300, 7301)]) expect(typology.every((transfer) => transfer.at !== undefined)).toBe(true);
  });

  it('holds the accounts each typology finds: twelve out, twelve in, a cycle of three, a rapid pass-through chain, the chain whose second transfer is earlier and the chain that is later than a day', () => {
    expect(new Set(transfers.filter((transfer) => transfer.f === account(7000) && Number(transfer.t.slice(3)) >= 7001 && Number(transfer.t.slice(3)) <= 7012).map((transfer) => transfer.t)).size).toBe(12);
    expect(new Set(transfers.filter((transfer) => transfer.t === account(7100) && Number(transfer.f.slice(3)) >= 7101 && Number(transfer.f.slice(3)) <= 7112).map((transfer) => transfer.f)).size).toBe(12);
    for (const [from, to] of [[7200, 7201], [7201, 7202], [7202, 7200]] as const) expect(between(from, to)).toHaveLength(1);
    const [first] = between(7300, 7301);
    const [second] = between(7301, 7302);
    expect((first?.at ?? 0) < (second?.at ?? 0)).toBe(true);
    const [early] = between(7311, 7312);
    const [late] = between(7310, 7311);
    expect((early?.at ?? 0) < (late?.at ?? 0)).toBe(true);
    const DAY = 24 * 3_600_000;
    const [slowFirst] = between(7320, 7321);
    const [slowSecond] = between(7321, 7322);
    const gap = (slowSecond?.at ?? 0) - (slowFirst?.at ?? 0);
    expect(gap).toBeGreaterThan(DAY);
    const [quickFirst] = between(7300, 7301);
    const [quickSecond] = between(7301, 7302);
    expect((quickSecond?.at ?? 0) - (quickFirst?.at ?? 0)).toBeLessThan(DAY);
  });
});
