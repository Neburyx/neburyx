import { act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EdgeDetail } from '@neburyx/contracts';
import { AGGREGATE_EVIDENCE_WAIT_MS, READ_WAIT_MS } from '../api/read-wait.js';
import { end, ENDINGS, expectBlock, timesSaid } from '../waiting-kit.js';
import { aggregateDetailOf, derivedDetailOf, detailOf, evidenceRig, inPanel, openOn, OWNS, panel, SHARED, SUMMED } from './evidence-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const SENTENCE = 'Reading the evidence…';
const KINDS = [
  ['a stored relationship', OWNS, () => detailOf(OWNS), READ_WAIT_MS],
  ['a derived relationship', SHARED, () => derivedDetailOf(), READ_WAIT_MS],
  ['an aggregate relationship', SUMMED, () => aggregateDetailOf(), AGGREGATE_EVIDENCE_WAIT_MS],
] as const;

describe.each(KINDS)('the evidence of %s while it is read', (_name, edge, detail, bound) => {
  describe.each(['Evidence', 'Properties'])('on the %s sub-tab', (tab) => {
    it.each(ENDINGS)('says so once over a hidden skeleton, and stops on: %s', async (how) => {
      const rig = evidenceRig({}, [OWNS, SHARED, SUMMED]);
      openOn(rig, edge);
      if (tab === 'Properties') await act(async () => void fireEvent.click(inPanel().getByRole('tab', { name: tab })));
      const root = () => panel() as HTMLElement;
      const waiting = () => void expectBlock(SENTENCE, root());
      waiting();
      const call = rig.edgeReads[0];
      await end<EdgeDetail>(how, call === undefined ? undefined : { settle: call.answer }, detail(), bound, waiting);
      expect(timesSaid(SENTENCE)).toBe(0);
      expect(root().querySelector('.loading-block, .loading-shape, [aria-busy="true"]')).toBeNull();
      if (how !== 'answer') expect(inPanel().getByRole('alert').textContent).toBe('The server could not be reached.');
      rig.unbind();
    });
  });
});
