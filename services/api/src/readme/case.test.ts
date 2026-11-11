import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { BUDGET_DEFAULTS } from '../mapping/budgets.js';
import { Doc, REPOSITORY_ROOT } from '../testing/doc.js';

const readme = new Doc('README.md');
const flat = readme.text.replace(/\s+/g, ' ');

interface Expectation {
  readonly node: { readonly type: string; readonly id: string };
  readonly via?: string;
  readonly ids?: readonly string[];
  readonly count?: number;
}
interface Case {
  readonly id: string;
  readonly expect: readonly Expectation[];
}
const file = parse(readFileSync(join(REPOSITORY_ROOT, 'domain-packs/banking-fraud/cases.yaml'), 'utf8')) as { preset: { entity: { type: string; id: string }; case_ref: string }; cases: Case[] };

describe('the case in the README', () => {
  it('starts at the preset account with its referral', () => {
    expect(flat).toContain(`starts at the account \`${file.preset.entity.id}\``);
    expect(flat).toContain(`the referral \`${file.preset.case_ref}\``);
  });

  it('lists the six accounts, the device and the address of the first case, as the file does', () => {
    const [device, address] = (file.cases[0]?.expect ?? []).filter((row) => row.ids !== undefined);
    expect(device?.ids).toEqual(address?.ids);
    expect(device?.ids).toHaveLength(6);
    for (const id of device?.ids ?? []) expect(flat).toContain(`\`${id}\``);
    expect(flat).toContain(`the device \`${device?.node.id}\``);
    expect(flat).toContain(`the address \`${address?.node.id}\``);
    const listed = [...flat.matchAll(/`(AC-\d+)`/g)].map((match) => match[1]);
    expect([...new Set(listed)].sort()).toEqual([...(device?.ids ?? [])].sort());
  });

  it('names the stop-list device of the second case and a first page of the default size', () => {
    const device = (file.cases[1]?.expect ?? []).find((row) => row.count !== undefined);
    expect(flat).toContain(`a device on a stop list, \`${device?.node.id}\`, that ${(device?.count ?? 0).toLocaleString('en-US')} accounts use`);
    expect(flat).toContain(`loads the first ${BUDGET_DEFAULTS.defaultPage} of them, not all ${(device?.count ?? 0).toLocaleString('en-US')}`);
  });
});
