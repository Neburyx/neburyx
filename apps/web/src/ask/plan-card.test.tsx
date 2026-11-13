import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AskPlan } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { field } from './ask-kit.js';
import { button, cleanup, drawPlan, hasButton, sharedPlan } from './plan-kit.js';
import { planView } from './plan-model.js';

afterEach(cleanup);

const plan = (templateId: string, params: object): AskPlan => ({ kind: 'plan', templateId, templateVersion: 1, rationale: 'x', params }) as AskPlan;
const REF = { entityType: 'widget', stableId: 'w-1' };
const names = { entityType: (type: string) => type };

describe('the plan card when nothing has been pressed', () => {
  it('is drawn with its heading, the template and its ID, the typed parameters as labelled values and the read-only line, and says nothing has run', async () => {
    const { runs, edits, cancels } = await drawPlan();
    expect(screen.getByRole('region', { name: 'Review before running' })).toBeTruthy();
    expect(screen.getByText('Shared attribute')).toBeTruthy();
    expect(screen.getByText('shared-attribute')).toBeTruthy();
    for (const [label, value] of [['Anchor', 'widget · w-1'], ['Attribute', 'gadget'], ['Through', 'HOLDS'], ['Window', '30 days'], ['Limit', '25']] as const) {
      const term = screen.getByText(label, { selector: 'dt' });
      expect(term.nextElementSibling?.textContent).toBe(String(value));
    }
    expect(screen.getByText('Read-only · same limits as manual exploration')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Sent. The plan is ready.');
    expect(screen.getByText('The plan is ready. Nothing has run.')).toBeTruthy();
    expect([runs, edits, cancels].map((list) => list.length)).toEqual([0, 0, 0]);
  });

  it('offers Run, Edit and Cancel in that order and makes no run, edit or cancel request until one is pressed', async () => {
    const { runs, edits, cancels } = await drawPlan();
    const buttons = screen.getAllByRole('button').map((item) => item.textContent);
    expect(buttons.slice(buttons.indexOf('Run'), buttons.indexOf('Run') + 3)).toEqual(['Run', 'Edit', 'Cancel']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect([runs.length, edits.length, cancels.length]).toEqual([0, 0, 0]);
  });

  it('takes the focus when it is drawn', async () => {
    await drawPlan();
    expect(document.activeElement?.getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { name: 'Review before running' }).id);
  });

  it('draws no placeholder, no question text and no rationale of the model', async () => {
    await drawPlan();
    const card = screen.getByRole('region', { name: 'Review before running' }).textContent ?? '';
    for (const text of ['‹', 'Widgets that share a gadget', 'which widgets']) expect(card).not.toContain(text);
  });

  it('draws no card for a plan that is unsupported, and none after the question changes', async () => {
    await drawPlan({ kind: 'unsupported', reason: 'No template fits.' } as AskPlan);
    expect(screen.queryByRole('region', { name: 'Review before running' })).toBeNull();
    cleanup();
    await drawPlan();
    await userEvent.click(button('Edit question'));
    expect(screen.queryByRole('region', { name: 'Review before running' })).toBeNull();
  });

  it('clears the card when the text of the question is changed', async () => {
    await drawPlan();
    await userEvent.type(field(), ' more');
    expect(screen.queryByRole('region', { name: 'Review before running' })).toBeNull();
  });

  it('shows the parameters of a template it has no words for as plain labelled values instead of failing', async () => {
    await drawPlan(plan('future-template', { ref: REF, depth: 3, kinds: ['a', 'b'] }));
    expect(screen.getByText('depth', { selector: 'dt' }).nextElementSibling?.textContent).toBe('3');
    expect(screen.getByText('kinds', { selector: 'dt' }).nextElementSibling?.textContent).toBe('a, b');
    expect(screen.getAllByText('future-template').length).toBeGreaterThan(0);
    expect(hasButton('Run')).toBe(true);
  });
});

describe('the words of each template', () => {
  it.each([
    ['linked-entities', { ref: REF, targetType: 'gadget', via: ['HOLDS', 'OWNS'], direction: 'out', maxHops: 2, window: { from: '2026-01-01', to: '2026-02-01' }, limit: 10 }, [['Anchor', 'widget · w-1'], ['Target', 'gadget'], ['Through', 'HOLDS, OWNS'], ['Direction', 'Outgoing'], ['Steps', '2'], ['Window', '2026-01-01 to 2026-02-01'], ['Limit', '10']]],
    ['entity', { ref: REF }, [['Entity', 'widget · w-1']]],
    ['degree-preview', { ref: REF }, [['Entity', 'widget · w-1']]],
    ['expand', { ref: REF, neighborTypes: ['gadget', 'part'], relTypes: ['HOLDS'], direction: 'both', sort: 'observed', window: { days: 1 }, limit: 5 }, [['Neighbors', 'gadget, part'], ['Relationships', 'HOLDS'], ['Direction', 'Both directions'], ['Order', 'Newest first'], ['Window', '1 day'], ['Limit', '5']]],
    ['derived-rule-run', { ref: REF, ruleId: 'shared_gadget' }, [['Rule', 'shared_gadget']]],
    ['derived-edge-support', { ruleId: 'shared_gadget', ends: [REF, { entityType: 'widget', stableId: 'w-2' }] }, [['From', 'widget · w-1'], ['To', 'widget · w-2']]],
    ['search', { entityTypes: ['widget'], text: 'ref 77' }, [['Types', 'widget'], ['Text', '“ref 77”']]],
  ] as const)('gives a plan of %s as labelled values', (id, params, lines) => {
    const view = planView(plan(id, params) as never, names);
    for (const [label, value] of lines) expect(view.lines).toContainEqual({ label, value });
  });

  it('leaves a parameter out that the plan does not hold, and says the defaults fill it in', () => {
    expect(planView(sharedPlan({ limit: undefined, window: undefined }) as never, names).lines.map((line) => line.label)).toEqual(['Anchor', 'Attribute', 'Through']);
  });

  it('uses the display name the mapping gives an entity type', () => {
    expect(planView(sharedPlan() as never, { entityType: (type) => (type === 'widget' ? 'Widget' : type) }).lines[0]).toEqual({ label: 'Anchor', value: 'Widget · w-1' });
  });
});
