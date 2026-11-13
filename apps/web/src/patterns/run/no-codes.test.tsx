import { ERROR_CODES, PATTERN_PROBLEM_CODES, PATTERN_UNAVAILABLE_CODES, type PatternProblem } from '@neburyx/contracts';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiFailure } from '../../api/client.js';
import { assertNoCodes, codesIn } from '../no-codes.js';
import { definitionHeavy, definitionOk, failure, listed, openPatterns, patternsWorkspace, settle } from '../patterns-kit.js';
import { SAVED_ID, previewed, previewedSaved, ran, runWorkspace } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const CLIENT = ['NETWORK_UNAVAILABLE', 'UNREADABLE_RESPONSE', 'SCHEMA_MISMATCH', 'UNEXPECTED_FAILURE'] as const;
const VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['CONFLICT', 'pattern-name-taken'],
  ['INVALID_REQUEST', 'pattern-limit'],
  ['INVALID_REQUEST', 'pattern-personal-condition'],
];
const ID = '0192f000-0000-7000-8000-000000000001';
const BETA = '0192f000-0000-7000-8000-000000000002';

/** The failure of a code with every detail a sentence may read, so that the sentence of each is the one the person would see. */
const forced = (code: string, reason?: string): ApiFailure =>
  (CLIENT as readonly string[]).includes(code) ? ({ code } as ApiFailure) : failure(code, { retryAfterMs: 2000, maxHops: 2, maxPage: 50, timeoutMs: 1000, ...(reason === undefined ? {} : { reason }) });

/** A click and the answers that follow it: quick, since the loops below press many buttons. */
const click = async (element: HTMLElement): Promise<void> => {
  fireEvent.click(element);
  await settle();
};

const scan = (where: string): void => assertNoCodes(document.body.textContent ?? '', where);

const CASES: ReadonlyArray<readonly [string, ApiFailure]> = [
  ...[...ERROR_CODES, ...CLIENT].map((code): readonly [string, ApiFailure] => [code, forced(code)]),
  ...VARIANTS.map(([code, reason]): readonly [string, ApiFailure] => [`${code} (${reason})`, forced(code, reason)]),
];

const inDialog = (name: string): HTMLElement | undefined => screen.queryAllByRole('button', { name }).find((button) => button.closest('[role="dialog"]') !== null);

describe('no code in the run lane, with each failure forced', () => {
  it.each(CASES)('shows none of the list when %s is the answer to reading it', async (name, refusal) => {
    await patternsWorkspace({ patterns: { listPatterns: async () => ({ ok: false, failure: refusal }) } });
    await openPatterns();
    scan(`the list after ${name}`);
  });

  it('shows none of the saved run, the dialogs of a row and the copy, whichever failure answers', { timeout: 120_000 }, async () => {
    let current = CASES[0]?.[1] as ApiFailure;
    const answer = async () => ({ ok: false as const, failure: current });
    await patternsWorkspace({
      patterns: {
        listPatterns: async () => ({ ok: true, value: { items: [listed({ id: ID, name: 'Alpha' }), listed({ id: BETA, name: 'Beta', ownedByYou: false, visibility: 'shared', owner: { name: 'Pat' } })], nextCursor: null } }),
        runSavedPattern: answer,
        changePattern: answer,
        deletePattern: answer,
        copyPattern: answer,
      },
    });
    await openPatterns();
    for (const [name, refusal] of CASES) {
      current = refusal;
      await click(screen.getByRole('button', { name: 'Run Alpha' }));
      await settle();
      scan(`the run of a saved pattern after ${name}`);
      await click(screen.getByRole('button', { name: 'Back to patterns' }));
      for (const entry of ['Rename', 'Delete', 'Share']) {
        await click(screen.getByRole('button', { name: 'More: Alpha' }));
        await click(screen.getByRole('menuitem', { name: entry }));
        const confirm = inDialog(entry) ?? inDialog('Delete pattern');
        if (confirm !== undefined) await click(confirm);
        await settle();
        scan(`the ${entry} dialog after ${name}`);
        const cancel = inDialog('Cancel');
        if (cancel !== undefined) await click(cancel);
      }
      await click(screen.getByRole('button', { name: 'More: Beta' }));
      await click(screen.getByRole('menuitem', { name: 'Copy' }));
      await settle();
      scan(`the copy after ${name}`);
    }
  });

  it('shows none of the run, the refusals of a save and the change dialogs, whichever failure answers', { timeout: 120_000 }, async () => {
    let current = CASES[0]?.[1] as ApiFailure;
    const refuse = async () => ({ ok: false as const, failure: current });
    await runWorkspace({ runDefinition: refuse, patterns: { savePattern: refuse } });
    await ran();
    for (const [name, refusal] of CASES) {
      current = refusal;
      await click(screen.getByRole('button', { name: 'Run pattern' }));
      await settle();
      scan(`the screen of the run after ${name}`);
      await click(screen.getByRole('button', { name: 'Save pattern…' }));
      await click(inDialog('Save') as HTMLElement);
      await settle();
      scan(`the Save pattern dialog after ${name}`);
      await click(inDialog('Cancel') as HTMLElement);
    }
  });

  it('shows none of the preview, whichever failure answers asking for it', async () => {
    let current = CASES[0]?.[1] as ApiFailure;
    await runWorkspace({ preview: async () => ({ ok: false, failure: current }) });
    await previewed();
    for (const [name, refusal] of CASES) {
      current = refusal;
      await click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      scan(`the preview after ${name}`);
    }
  });
});

describe('no code in the screens that no failure draws', () => {
  it('shows no code on the preview for each problem the source can find', async () => {
    let current: PatternProblem = { path: ['steps', 0], code: PATTERN_PROBLEM_CODES[0] };
    await runWorkspace({ preview: async () => ({ ok: true, value: { status: 'invalid', problems: [current] } }) });
    await previewed();
    for (const code of PATTERN_PROBLEM_CODES) {
      current = { path: ['steps', 0], code };
      await click(screen.getByRole('button', { name: 'Try again' }));
      await settle();
      scan(`the preview with the problem ${code}`);
    }
  });

  it('shows no code on the running, heavy and result screens', async () => {
    let finish: (value: { ok: true; value: ReturnType<typeof definitionHeavy> }) => void = () => undefined;
    await runWorkspace({ runDefinition: () => new Promise((resolve) => (finish = resolve as typeof finish)) });
    await ran();
    scan('the running screen');
    finish({ ok: true, value: definitionHeavy() });
    await settle();
    scan('the heavy screen');
    cleanup();
    document.body.replaceChildren();
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count: { value: 500, quality: 'lowerBound', scope: 'matches' } }) }) });
    await ran();
    scan('the result screen');
  });

  it('shows no code in the row or the run view of a pattern that cannot run, for each reason', async () => {
    let current: (typeof PATTERN_UNAVAILABLE_CODES)[number] = PATTERN_UNAVAILABLE_CODES[0];
    await patternsWorkspace({
      patterns: {
        listPatterns: async () => ({ ok: true, value: { items: [listed({ id: ID, name: 'Alpha', availability: { status: 'unavailable', reasons: PATTERN_UNAVAILABLE_CODES.map((code) => ({ code, path: ['steps', 0] })) } }), listed({ id: BETA, name: 'Beta' })], nextCursor: null } }),
        runSavedPattern: async () => ({ ok: true, value: { status: 'unavailable', reasons: [{ code: current, path: ['steps', 0] }] } }),
      },
    });
    await openPatterns();
    scan('the row of a pattern out of date');
    for (const code of PATTERN_UNAVAILABLE_CODES) {
      current = code;
      await click(screen.getByRole('button', { name: 'Run Beta' }));
      await settle();
      scan(`the run view of a pattern out of date for ${code}`);
      await click(screen.getByRole('button', { name: 'Back to patterns' }));
    }
  });

  it('shows no code in the question before a change of a pattern others run, nor after each refusal of it', { timeout: 120_000 }, async () => {
    let current = CASES[0]?.[1] as ApiFailure;
    const shared = listed({ id: SAVED_ID, name: 'Alpha', visibility: 'shared', definition: { anchorType: 'c-a', steps: [{ relationshipTypes: ['k-1'], direction: 'out', arrivesAt: 'c-b' }] } });
    await previewedSaved({ patterns: { listPatterns: async () => ({ ok: true, value: { items: [shared], nextCursor: null } }), changePattern: async () => ({ ok: false, failure: current }), savePattern: async () => ({ ok: false, failure: current }) } });
    await click(screen.getByRole('button', { name: 'Save changes…' }));
    scan('the question before a change');
    for (const [name, refusal] of CASES) {
      current = refusal;
      const everyone = inDialog('Save for everyone');
      if (everyone !== undefined) await click(everyone);
      scan(`the change dialog after ${name}`);
      await click(inDialog('Save as a copy') as HTMLElement);
      await settle();
      scan(`the copy of a change after ${name}`);
    }
  });
});
