/** Helpers of the tests of the loading and waiting states. They run under fake timers. */
import { act, fireEvent } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { ApiResult } from './api/client.js';

export const ENDINGS = ['answer', 'failure', 'bound'] as const;
export type Ending = (typeof ENDINGS)[number];

export const wait = (ms = 0) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** Lets reads that follow one another be made, with no time passing. */
export const drawn = async () => {
  for (let round = 0; round < 5; round += 1) await wait();
};
export const press = async (element: Element) => {
  await act(async () => void fireEvent.click(element));
  await drawn();
};

/** Reads that stay out until the test answers them. */
export function held<T>() {
  const calls: { readonly settle: (result: ApiResult<T>) => void; readonly signal: AbortSignal | undefined }[] = [];
  const read = (signal?: AbortSignal): Promise<ApiResult<T>> => new Promise((settle) => void calls.push({ settle, signal }));
  return { calls, read };
}

/** Ends the wait of one read in the given way; before the bound the state `stillWaiting` asserts must hold. `elapsed` is the part of the bound that has already passed. */
export async function end<T>(how: Ending, call: { readonly settle: (result: ApiResult<T>) => void } | undefined, value: T, bound: number, stillWaiting: () => void, elapsed = 0): Promise<void> {
  if (call === undefined) throw new Error('no read is out');
  if (how === 'bound') {
    await wait(bound - 1 - elapsed);
    stillWaiting();
    await wait(1);
  } else await act(async () => call.settle(how === 'answer' ? { ok: true, value } : { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
  await drawn();
}

export const statuses = (text: string, root: ParentNode = document.body): Element[] => [...root.querySelectorAll('[role="status"]')].filter((element) => element.textContent === text);
export const timesSaid = (text: string, root: Node = document.body): number => (root.textContent ?? '').split(text).length - 1;

const expectStill = (root: ParentNode) => {
  for (const bar of root.querySelectorAll('[class*="skeleton-"]')) expect(bar.closest('[aria-hidden="true"]')).not.toBeNull();
};

/** A first read: the sentence is said once in a status, in a busy block whose skeleton is hidden and says nothing. Returns the block. */
export function expectBlock(sentence: string, root: ParentNode = document.body): Element {
  const lines = statuses(sentence, root);
  expect(lines).toHaveLength(1);
  const block = lines[0]?.closest('.loading-block') as Element;
  expect(block.getAttribute('aria-busy')).toBe('true');
  expect(timesSaid(sentence, block)).toBe(1);
  const shape = block.querySelector('.loading-shape') as Element;
  expect(shape.getAttribute('aria-hidden')).toBe('true');
  expect(shape.querySelector('.skeleton-bar')).not.toBeNull();
  expect(shape.querySelector('[role="status"]')).toBeNull();
  expect(shape.textContent).toBe('');
  expectStill(block);
  return block;
}

/** A wait over what stays on screen: the word is said once, in one status, with a hidden spinner. */
export function expectLine(word: string, root: ParentNode = document.body): Element {
  const lines = statuses(word, root);
  expect(lines).toHaveLength(1);
  expect(timesSaid(word, root as Node)).toBe(1);
  expect(lines[0]?.querySelector('.waiting-spinner')?.getAttribute('aria-hidden')).toBe('true');
  return lines[0] as Element;
}
