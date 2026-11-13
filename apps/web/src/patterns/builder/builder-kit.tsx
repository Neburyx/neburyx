import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATTERN_LIMITS, type SourceProfile } from '@neburyx/contracts';
import { testProfile } from '../../dev/test-profile.js';
import { openPatterns, patternsWorkspace, settle, type KitOptions, type PatternsKit } from '../patterns-kit.js';
import { CHECK_DEBOUNCE_MS } from './use-check.js';
import { vi } from 'vitest';

const row = (type: string, from: string, to: string) => ({ type, from, to, aggregate: false, observedAt: null, filterable: [], sortable: [], evidence: [], properties: [], stableIdProperty: null });

/**
 * A neutral mapping of four node types: n-a to n-b by two relationship types, n-b to n-c by one, n-c to n-d by seven (the most a step may check is six), n-a to itself by one, and n-e joined to nothing.
 * Display names are the type names in capitals, as the shared test profile has them.
 */
export function builderProfile(): SourceProfile {
  const base = testProfile('a', ['n-a', 'n-b', 'n-c', 'n-d', 'n-e']);
  return {
    ...base,
    relationshipTypes: [row('r-1', 'n-a', 'n-b'), row('r-2', 'n-a', 'n-b'), row('r-3', 'n-b', 'n-c'), ...Array.from({ length: PATTERN_LIMITS.relationshipTypesPerStep + 1 }, (_, index) => row(`r-d${index + 1}`, 'n-c', 'n-d')), row('r-self', 'n-a', 'n-a')],
  };
}

export async function builderWorkspace(options: KitOptions = {}): Promise<PatternsKit> {
  const kit = await patternsWorkspace({ profile: async () => ({ ok: true, value: builderProfile() }), ...options });
  await openPatterns();
  return kit;
}

export const openBuilder = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('button', { name: 'New pattern' }));
  await settle();
};

export const builderPanel = (): HTMLElement => screen.getByRole('region', { name: 'New pattern' });
export const startSelect = (): HTMLSelectElement => screen.getByLabelText('Starts at') as HTMLSelectElement;
export const addStepButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Add step' }) as HTMLButtonElement;
export const stepCard = (n: number): HTMLElement => within(builderPanel()).getByRole('group', { name: `Step ${n}` });
export const field = (n: number, label: string): HTMLSelectElement => within(stepCard(n)).getByLabelText(label) as HTMLSelectElement;

export async function chooseStart(type: string): Promise<void> {
  await userEvent.selectOptions(startSelect(), type);
}

/** Adds a step and chooses its direction, arrival type and relationship types. */
export async function buildStep(n: number, direction: string, arrivesAt: string, types: readonly string[]): Promise<void> {
  await userEvent.click(addStepButton());
  await userEvent.selectOptions(field(n, 'Direction'), direction);
  await userEvent.selectOptions(field(n, 'Arrives at'), arrivesAt);
  for (const type of types) await userEvent.click(within(stepCard(n)).getByRole('checkbox', { name: type }));
}

/** Lets the debounce of the check pass and the answer arrive. */
export async function afterDebounce(): Promise<void> {
  await act(async () => void (await vi.advanceTimersByTimeAsync(CHECK_DEBOUNCE_MS + 20)));
  await settle();
}

export { cleanup, fireEvent, screen, within, userEvent };
