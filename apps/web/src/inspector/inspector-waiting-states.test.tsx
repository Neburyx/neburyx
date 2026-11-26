import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedNeighborsResponse } from '@neburyx/contracts';
import { DERIVED_ROWS_WAIT_MS, READ_WAIT_MS } from '../api/read-wait.js';
import { end, ENDINGS, expectBlock, timesSaid, wait } from '../waiting-kit.js';
import { previewOf } from '../workspace/supernode-kit.js';
import { count, entity, inInspector, inspector, inspectorRig, select, TYPE } from './inspector-kit.js';
import { at } from './relationship-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DETAILS = 'Reading details…';
const COUNTING = 'Counting relationship ends…';
const DERIVED = 'Counting rule-derived neighbors…';
const RULE = { id: 'shared-device', from: TYPE, to: TYPE, via: ['link-a', TYPE, 'link-a'], ruleVersion: 2 };
const root = () => inspector() as HTMLElement;
const gone = (sentence: string) => {
  expect(timesSaid(sentence)).toBe(0);
  for (const block of root().querySelectorAll('.loading-block')) expect(block.textContent).not.toContain(sentence);
};

describe('the inspector while the details are read', () => {
  // the read of one entity has no bound of its own: it ends only by answering or failing
  it.each(['answer', 'failure'] as const)('says so once over a hidden skeleton, and stops on: %s', async (how) => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const waiting = () => void expectBlock(DETAILS, root());
    waiting();
    const call = rig.entityReads[0];
    await end(how, call === undefined ? undefined : { settle: call.answer }, entity('n1'), READ_WAIT_MS, waiting);
    gone(DETAILS);
    rig.unbind();
  });
});

describe('the inspector while the relationship ends are counted on the Overview', () => {
  it.each(ENDINGS)('says so once over a hidden skeleton, and stops on: %s', async (how) => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    const section = () => inInspector().getByRole('region', { name: 'Sourced relationship ends' });
    const waiting = () => void expectBlock(COUNTING, section());
    waiting();
    const call = rig.previews[0];
    await end(how, call === undefined ? undefined : { settle: call.answer }, previewOf(), READ_WAIT_MS, waiting);
    gone(COUNTING);
    expect(root().querySelector('section[aria-label="Sourced relationship ends"] [aria-busy="true"]')).toBeNull();
    rig.unbind();
  });
});

describe('the inspector while the relationship ends are counted on the Relationships tab', () => {
  it.each(ENDINGS)('says so once over a hidden skeleton, and stops on: %s', async (how) => {
    const rig = inspectorRig();
    select(rig.state, 'n1');
    // the details answer, so that the only wait on the tab is that of the count
    await act(async () => rig.entityReads[0]?.answer({ ok: true, value: entity('n1') }));
    await act(async () => void fireEvent.click(inInspector().getByRole('tab', { name: 'Relationships' })));
    await wait();
    const waiting = () => void expectBlock(COUNTING, root());
    waiting();
    const call = rig.previews[0];
    await end(how, call === undefined ? undefined : { settle: call.answer }, previewOf(), READ_WAIT_MS, waiting);
    gone(COUNTING);
    expect(inInspector().getByRole('tabpanel').querySelector('[aria-busy="true"], .loading-shape')).toBeNull();
    rig.unbind();
  });
});

describe('the inspector while the rule-derived neighbors are counted', () => {
  const value: DerivedNeighborsResponse = { ref: at('n1'), results: [{ ruleId: 'shared-device', ruleVersion: 2, count: count(1, 'exact'), nodes: [], edges: [], warnings: [] }] };

  it.each(ENDINGS)('says so once over a hidden skeleton, and stops on: %s', async (how) => {
    const rig = inspectorRig({ derivedRules: [RULE] });
    select(rig.state, 'n1');
    await act(async () => rig.previews[0]?.answer({ ok: true, value: previewOf() }));
    await act(async () => rig.entityReads[0]?.answer({ ok: true, value: entity('n1') }));
    const waiting = () => void expectBlock(DERIVED, root());
    waiting();
    const call = rig.derived[0];
    await end(how, call === undefined ? undefined : { settle: call.answer }, value, DERIVED_ROWS_WAIT_MS, waiting);
    gone(DERIVED);
    expect(root().querySelector('.loading-block')).toBeNull();
    rig.unbind();
  });

  it('draws the wait again for an entity shown again after its count was left unanswered', async () => {
    const rig = inspectorRig({ derivedRules: [RULE] });
    select(rig.state, 'n1');
    select(rig.state, 'n2');
    select(rig.state, 'n1');
    expectBlock(DERIVED, root());
    expect(rig.derivedCalls.map((call) => call.id)).toEqual(['n1', 'n2', 'n1']);
    await wait(DERIVED_ROWS_WAIT_MS);
    gone(DERIVED);
    rig.unbind();
  });
});
