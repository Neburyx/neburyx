import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATTERN_LIMITS, type SourceProfile } from '@neburyx/contracts';
import { testProfile } from '../../dev/test-profile.js';
import { typedNode } from '../../workspace/filters-kit.js';
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

const mapped = (type: string, from: string, to: string, observedAt: string | null, filterable: readonly string[]) => ({ ...row(type, from, to), observedAt, filterable: [...filterable] });

/**
 * A neutral mapping for conditions. c-a to c-b by k-1 (dated, `q-size`), k-2 (undated, `q-size` and `q-tag`) and k-5 (dated, nothing) and k-6 (undated, nothing); c-b to c-c by k-3 (undated, no property); c-c and c-d by one type, k-two, whose
 * row c-c to c-d is dated and declares `fwd` and whose row c-d to c-c is undated and declares `back`. c-b has a personal-data property, c-c has no filterable property.
 */
export function conditionsProfile(): SourceProfile {
  const base = testProfile('a', ['c-a', 'c-b', 'c-c', 'c-d']);
  const declared: Readonly<Record<string, { readonly filterable: readonly string[]; readonly pii: readonly string[] }>> = {
    'c-a': { filterable: ['a-name'], pii: [] },
    'c-b': { filterable: ['b-name', 'b-count', 'b-secret'], pii: ['b-secret'] },
    'c-c': { filterable: [], pii: [] },
    'c-d': { filterable: ['d-x'], pii: [] },
  };
  return {
    ...base,
    entityTypes: base.entityTypes.map((entity) => ({ ...entity, filterable: [...(declared[entity.type]?.filterable ?? [])], pii: [...(declared[entity.type]?.pii ?? [])] })),
    relationshipTypes: [
      mapped('k-1', 'c-a', 'c-b', 'q-when', ['q-size']),
      mapped('k-2', 'c-a', 'c-b', null, ['q-size', 'q-tag']),
      mapped('k-5', 'c-a', 'c-b', 'q-when', []),
      mapped('k-6', 'c-a', 'c-b', null, []),
      mapped('k-3', 'c-b', 'c-c', null, []),
      mapped('k-two', 'c-c', 'c-d', 'q-when', ['fwd']),
      mapped('k-two', 'c-d', 'c-c', null, ['back']),
    ],
  };
}

export async function conditionsWorkspace(options: KitOptions = {}): Promise<PatternsKit> {
  const kit = await patternsWorkspace({ profile: async () => ({ ok: true, value: conditionsProfile() }), ...options });
  await openPatterns();
  return kit;
}

export const addCondition = async (n: number): Promise<void> => userEvent.click(within(stepCard(n)).getByRole('button', { name: 'Add condition' }));
export const conditionRow = (n: number, m: number): HTMLElement => within(stepCard(n)).getByRole('group', { name: `Step ${n} condition ${m}` });
export const rowField = (n: number, m: number, label: string): HTMLElement => within(conditionRow(n, m)).getByLabelText(`Step ${n} condition ${m}: ${label}`);
export const optionTexts = (select: HTMLElement): string[] => [...(select as HTMLSelectElement).options].map((option) => option.textContent ?? '');

/** A workspace of two loaded entities of the first node type, the first being the one the investigation was opened on. */
export async function runWorkspace(options: KitOptions = {}): Promise<PatternsKit> {
  const kit = await builderWorkspace({ nodes: [typedNode('x-1', 'n-a'), typedNode('x-2', 'n-a')], opened: { entityType: 'n-a', stableId: 'x-1' }, ...options });
  await openBuilder();
  return kit;
}

/** Builds the one-step pattern the run tests use and lets the check and the preview answer. */
export async function validPattern(): Promise<void> {
  await chooseStart('n-a');
  await buildStep(1, 'out', 'n-b', ['r-1']);
  await afterDebounce();
}

export const runButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Run pattern' }) as HTMLButtonElement;
export const runReason = (): string | undefined => document.getElementById('pattern-run-reason')?.textContent ?? undefined;
