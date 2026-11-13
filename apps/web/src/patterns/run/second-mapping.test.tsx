import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphEdge, GraphNode, GraphProperty, PatternRunOk } from '@neburyx/contracts';
import { fakeClient } from '../../api/fake-client.js';
import { assertNoCodes } from '../no-codes.js';
import { entityLabel } from './entity-label.js';
import { titleHoldsId } from './id-in-title.js';
import { detailsOf, pathOf } from './match-model.js';
import { ResultScreen } from './result-screen.js';
import { StartChoice } from './start-choice.js';
import type { AddResult } from './use-add-matches.js';

/** A second mapping, unlike the one the other tests use: other type names, other relationship, key properties of its own, titles that do and do not hold the ID. Nothing in the screens may depend on either. */
const VESSEL = 'registry-vessel';
const PORT = 'registry-port';
const BERTH = 'registry-berth';
const TOKEN = 'p1.4f9c2a7e11d0b8a3';
const CALLED_AT = 'CALLED_AT';
const KEYS: Readonly<Record<string, readonly string[]>> = { [VESSEL]: ['flag', 'tonnage', 'callsign'], [PORT]: [] };
const PERSONAL: Readonly<Record<string, readonly string[]>> = { [VESSEL]: ['master'] };

const text = (key: string, value: unknown, extra: Partial<GraphProperty> = {}): GraphProperty => ({ key, value, dataClass: 'text', masked: false, ...extra }) as GraphProperty;
const entity = (type: string, id: string, title: string, properties: readonly GraphProperty[] = []): GraphNode => ({
  ref: { sourceId: 's', entityType: type, stableId: id },
  display: { title, type },
  properties: [...properties],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const LONG_ID = `IMO-${'9'.repeat(80)}`;
const LONG_TEXT = 'Östersjö-Hafen '.repeat(30).trim();
const MANY = Array.from({ length: 40 }, (_, index) => text(`attribute-${index}`, `value ${index}`));

const anchor = entity(PORT, 'P-1', 'Rotterdam');
const matches: readonly GraphNode[] = [
  entity(VESSEL, 'V-1', 'MV Aurora V-1', [text('flag', 'PA'), { ...text('tonnage', 51200), dataClass: 'number' } as GraphProperty, text('callsign', 'HOBR'), text('master', 'A. Jørgensen', { dataClass: 'name' }), text('built', '2011')]),
  entity(VESSEL, 'V-2', 'Sjøfarer', [text('flag', ''), text('tonnage', null), text('callsign', 'ÆØÅ-1', { masked: true }), text('owner note', LONG_TEXT)]),
  entity(VESSEL, LONG_ID, '', MANY),
  entity(PORT, 'P-2', 'Ørestad — 港口 — ميناء'),
  entity(VESSEL, 'V-5', 'N'.repeat(200)),
  entity(BERTH, TOKEN, ''),
  entity(BERTH, 'p1.0000aaaa1111bbbb', 'North quay, berth 4'),
];

const keyed = (type: string): boolean => type === BERTH;

const answer = (): PatternRunOk =>
  ({
    status: 'ok',
    templateVersion: '1',
    count: { value: matches.length, quality: 'exact', scope: 'matches' },
    matches: matches.map((found) => ({ match: found.ref, hops: 1 as const, through: [], relationships: [{ relationshipType: CALLED_AT, from: anchor.ref, to: found.ref }] })),
    nodes: [anchor, ...matches],
    edges: matches.map(
      (found, index): GraphEdge =>
        ({ ref: { sourceId: 's', type: CALLED_AT, from: PORT, to: found.ref.entityType, stableId: `c${index}` }, type: CALLED_AT, from: anchor.ref, to: found.ref, display: { title: CALLED_AT }, properties: [text('berth', `B${index}`)], qualityFlags: [], provenanceRefs: [], evidenceRefs: [], authorization: { canInspect: true, canExport: true } }) as unknown as GraphEdge,
    ),
    notices: [],
    warnings: [],
  }) as unknown as PatternRunOk;

const add: AddResult = { canAdd: true, running: false, onGraph: () => false, add: () => undefined, added: undefined };

const showResult = (mask = false): HTMLElement => {
  const { container } = render(
    <ResultScreen
      answer={answer()}
      at={new Date('2026-11-13T09:46:00.000Z')}
      page={0}
      before={0}
      hasNext={false}
      reading={false}
      mask={mask}
      personal={(type) => PERSONAL[type] ?? []}
      keyProperties={(type) => KEYS[type] ?? []}
      keyed={keyed}
      startName="Rotterdam"
      typeName="registry port"
      add={add}
      evidenceOpener={undefined}
      notice={null}
      saveLink={null}
      onEdit={() => undefined}
      onRunAnother={() => undefined}
      onPrevious={() => undefined}
      onNext={() => undefined}
    />,
  );
  return container;
};

const card = (n: number): HTMLElement => within(screen.getByRole('list', { name: 'Matches' })).getAllByRole('listitem').filter((item) => item.classList.contains('run-match'))[n - 1] as HTMLElement;
const rows = (item: HTMLElement): string[] => Array.from(item.querySelectorAll('.run-detail')).map((row) => row.textContent ?? '');

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('an entity read as a title and an ID, whatever the mapping', () => {
  it('shows the ID beside a title that does not hold it, and not twice when it does', () => {
    expect(entityLabel(entity(VESSEL, 'V-9', 'Plain title'), true)).toEqual({ title: 'Plain title', id: 'V-9', titleIsId: false });
    expect(entityLabel(entity(VESSEL, 'V-9', 'MV Aurora V-9'), true)).toEqual({ title: 'MV Aurora V-9', id: undefined, titleIsId: false });
    expect(entityLabel(entity(VESSEL, 'V-9', 'V-9'), true).id).toBeUndefined();
  });

  it('reads an entity with no title by its ID, or by a plain word while IDs are hidden', () => {
    expect(entityLabel(entity(VESSEL, 'V-9', '   '), true)).toEqual({ title: 'V-9', id: undefined, titleIsId: true });
    expect(entityLabel(entity(VESSEL, 'V-9', ''), false)).toEqual({ title: 'an entity', id: undefined, titleIsId: false });
  });

  it('never gives a hidden ID back, whatever the title', () => {
    expect(entityLabel(entity(VESSEL, 'V-9', 'Plain title'), false).id).toBeUndefined();
  });

  it('finds an ID in a title only as a whole token, so "10" is not found in "Unit 100"', () => {
    expect(titleHoldsId('Unit 100', '10')).toBe(false);
    expect(titleHoldsId('Unit 10', '10')).toBe(true);
    expect(titleHoldsId('Unit (10)', '10')).toBe(true);
    expect(titleHoldsId('X10', '10')).toBe(false);
    expect(titleHoldsId('Ørestad ÆØÅ-7 Hafen', 'ÆØÅ-7')).toBe(true);
    expect(titleHoldsId('anything', '')).toBe(false);
    expect(entityLabel(entity(VESSEL, '10', 'Unit 100'), true)).toEqual({ title: 'Unit 100', id: '10', titleIsId: false });
  });

  it('keeps non-ASCII text and very long values whole', () => {
    expect(entityLabel(entity(VESSEL, LONG_ID, 'Ørestad — 港口'), true)).toEqual({ title: 'Ørestad — 港口', id: LONG_ID, titleIsId: false });
  });
});

describe('the start field with a second mapping', () => {
  const field = (chosen: GraphNode | undefined, showIds = true) =>
    render(<StartChoice client={fakeClient()} sourceId="s" sourceName="Registry" mask={!showIds} typeName="registry vessel" entityType={VESSEL} candidates={matches.filter((found) => found.ref.entityType === VESSEL)} chosen={chosen} onChoose={() => undefined} showIds={showIds} inputId="start" />);

  it('lists each entity once: a title with its ID only where the title lacks it, an untitled one by its ID, long values cut by the style and whole in the hover title', async () => {
    field(undefined);
    await userEvent.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['MV Aurora V-1', `Sjøfarer${'V-2'}`, LONG_ID, `${'N'.repeat(200)}V-5`]);
    expect(options[2]?.getAttribute('title')).toBe(LONG_ID);
    expect(options[3]?.getAttribute('title')).toBe(`${'N'.repeat(200)} · V-5`);
  });

  it('names the chosen entity once and drops the helper line', () => {
    const view = field(matches[0]);
    expect(view.container.querySelector('.run-start-chosen')?.textContent).toBe('Chosen: MV Aurora V-1');
    expect(document.getElementById('start-help')).toBeNull();
    expect(screen.getByRole('combobox').getAttribute('aria-describedby')).toBeNull();
  });

  it('keeps the helper, in one short line, until one is chosen', () => {
    field(undefined);
    expect(document.getElementById('start-help')?.textContent).toBe('From the registry vessel selected on the canvas, or search.');
    expect(screen.getByRole('combobox').getAttribute('aria-describedby')).toBe('start-help');
  });

  it('shows an ID only when allowed, and an untitled chosen entity by its ID in the mono face', () => {
    const view = field(matches[2]);
    const title = view.container.querySelector('.run-start-title');
    expect(title?.textContent).toBe(LONG_ID);
    expect(title?.classList.contains('run-start-id')).toBe(true);
  });

  it('reads an untitled entity as a plain word while IDs are hidden', () => {
    const view = field(matches[2], false);
    expect(view.container.querySelector('.run-start-chosen')?.textContent).toBe('Chosen: an entity');
  });
});

describe('the result card with a second mapping', () => {
  it('shows the key properties of the type, in the mapping order, at most three, left out when empty, null or masked', () => {
    showResult();
    expect(rows(card(1))).toEqual(['flagPA', 'tonnage51,200', 'callsignHOBR']);
    expect(rows(card(2))).toEqual(['owner note' + LONG_TEXT]);
  });

  it('puts the other properties behind the toggle with their count, and keeps the count honest for many', async () => {
    showResult();
    const toggle = within(card(3)).getByRole('button', { name: 'Show all properties (41)' });
    expect(rows(card(3))).toHaveLength(3);
    await userEvent.click(toggle);
    expect(rows(card(3))).toHaveLength(41);
    expect(within(card(3)).getByRole('button', { name: 'Show fewer properties' }).getAttribute('aria-expanded')).toBe('true');
  });

  it('shows the first three the answer carries for a type with no key properties, and none for an entity with nothing', () => {
    showResult();
    expect(rows(card(4))).toEqual([]);
    expect(within(card(4)).queryByRole('button', { name: /^Show all properties/ })).toBeTruthy();
  });

  it('shows no personal-data value while masking is on, shown or folded', async () => {
    showResult(true);
    await userEvent.click(within(card(1)).getByRole('button', { name: /^Show all properties/ }));
    expect(card(1).textContent).not.toContain('Jørgensen');
    expect(card(1).textContent).toContain('built');
  });

  it('draws a title with no ID once, an untitled entity by its ID, and cuts nothing from the DOM text of a long one', () => {
    showResult();
    const chips = (n: number): string[] => Array.from(card(n).querySelectorAll('.run-path-entity')).map((chip) => chip.textContent ?? '');
    expect(chips(1)).toEqual(['Rotterdam', 'MV Aurora V-1']);
    expect(chips(3)[1]).toBe(LONG_ID);
    expect(chips(5)[1]).toBe('N'.repeat(200));
    expect(card(4).textContent).toContain('Ørestad — 港口 — ميناء');
  });

  it('splits a title that ends with its ID into name and ID, the full ID in the hover title', () => {
    showResult();
    const id = card(1).querySelector('.run-chip-id');
    expect(id?.textContent).toBe('V-1');
    expect(id?.getAttribute('title')).toBe('V-1');
    expect(card(1).querySelector('.run-chip-name')?.textContent).toBe('MV Aurora');
  });

  it('writes the relationship type as the answer names it, with no code in the words of the screen', () => {
    showResult();
    expect(card(1).querySelector('.run-path-relationship')?.textContent).toContain(CALLED_AT);
    assertNoCodes((document.querySelector('.run-summary') as HTMLElement).textContent ?? '', 'the summary');
  });

  it('puts the explanation of counts behind a button, not in the header', async () => {
    showResult();
    expect(screen.queryByText(/^Counts are always labelled/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'About these counts' }));
    expect(screen.getByText(/^Counts are always labelled/)).toBeTruthy();
  });
});

describe('a keyed type, whose stored ID is a token', () => {
  it('draws the path chips with the title, and a plain word for an untitled one, never the token', () => {
    showResult();
    const chips = (n: number): string[] => Array.from(card(n).querySelectorAll('.run-path-entity')).map((chip) => chip.textContent ?? '');
    expect(chips(6)).toEqual(['Rotterdam', 'an entity']);
    expect(chips(7)).toEqual(['Rotterdam', 'North quay, berth 4']);
    expect(card(6).textContent).not.toContain('p1.');
    expect(card(7).textContent).not.toContain('p1.');
  });

  it('shows no token in the start field: not in the rows, the chosen line or the hover title', async () => {
    const view = render(<StartChoice client={fakeClient()} sourceId="s" sourceName="Registry" mask={false} typeName="registry berth" entityType={BERTH} candidates={matches.filter((found) => found.ref.entityType === BERTH)} chosen={matches[5]} onChoose={() => undefined} showIds={false} inputId="start" />);
    expect(view.container.querySelector('.run-start-chosen')?.textContent).toBe('Chosen: an entity');
    expect(view.container.innerHTML).not.toContain('p1.');
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['an entity', 'North quay, berth 4']);
    expect(document.body.innerHTML).not.toContain('p1.');
  });
});

describe('the match model with a second mapping', () => {
  it('falls back to the first rows when the key properties named are all missing', () => {
    const found = answer();
    const first = found.matches[0];
    if (first === undefined) throw new Error('match');
    const { shown } = detailsOf(first, found, false, () => [], () => ['not-there']);
    expect(shown.map((row) => row.label)).toEqual(['flag', 'tonnage', 'callsign']);
  });

  it('gives a hidden entity a plain word when masking and no title came', () => {
    const found = answer();
    const stripped = { ...found, nodes: found.nodes.filter((held) => held.ref.stableId !== 'V-1') } as PatternRunOk;
    const first = stripped.matches[0];
    if (first === undefined) throw new Error('match');
    expect(pathOf(first, stripped, true).filter((part) => part.kind === 'entity').map((part) => part.text)).toEqual(['Rotterdam', 'an entity']);
  });
});
