import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils.js';
import { INVESTIGATION_A, investigationOf, knowing, nodeOf, openedOf } from './test-data.js';

const A = { investigation: investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { caseRef: 'CASE-1' }), node: nodeOf('source-a', 'kind-a', 'A-1') };

function prompt() {
  const sent: unknown[] = [];
  const { client } = knowing([A], {
    openInvestigation: async (body) => {
      sent.push(body);
      return { ok: true, value: openedOf(A.investigation, A.node) };
    },
  });
  const view = renderApp('/dev/open-link', client);
  return { view, sent, user: userEvent.setup() };
}

const linkForm = () => screen.getByRole('form', { name: 'Open a link' });
const partsForm = () => screen.getByRole('form', { name: 'Open by parts' });
const typeInto = async (user: ReturnType<typeof userEvent.setup>, form: HTMLElement, label: string, text: string) => user.type(within(form).getByLabelText(label), text);

describe('the form that takes a pasted link', () => {
  it('goes to the link as if it had been followed: a path, then Enter', async () => {
    const { view, sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    await user.click(within(linkForm()).getByLabelText('Link'));
    await user.paste('/source-a/entity/kind-a/A-1?caseRef=CASE-1');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 })).toBeTruthy();
    expect(sent).toEqual([{ sourceId: 'source-a', entity: { sourceId: 'source-a', entityType: 'kind-a', stableId: 'A-1' }, caseRef: 'CASE-1', mask: false }]);
    expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_A}`);
  });

  it('goes to a link that has the address of this app in front of it', async () => {
    const { sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    await user.click(within(linkForm()).getByLabelText('Link'));
    await user.paste(`${window.location.origin}/source-a/entity/kind-a/A-1`);
    await user.click(within(linkForm()).getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['text that is not a link', 'hello', 'That is not a valid link'],
    ['a link with a fragment', '/source-a/entity/kind-a/A-1#x', 'That is not a valid link'],
    ['an address of another host', 'https://evil.example.test/source-a/entity/kind-a/A-1', 'That is not a link of this app'],
    ['a javascript address', 'javascript:alert(1)', 'That is not a link of this app'],
    ['a data address', 'data:text/html,<b>x</b>', 'That is not a link of this app'],
    ['a protocol-relative address', '//evil.example.test/source-a/entity/kind-a/A-1', 'That is not a link of this app'],
  ])('says so beside the field for %s, keeps what was typed, moves nothing and sends nothing', async (_name, text, message) => {
    const { view, sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    await user.click(within(linkForm()).getByLabelText('Link'));
    await user.paste(text);
    await user.click(within(linkForm()).getByRole('button', { name: 'Open' }));
    const alert = await within(linkForm()).findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(document.activeElement).toBe(alert);
    expect(within(linkForm()).getByLabelText('Link')).toHaveProperty('value', text);
    expect(view.router.state.location.pathname).toBe('/dev/open-link');
    expect(sent).toEqual([]);
  });
});

describe('the form that takes the parts', () => {
  it('goes to the link the parts make, with the type and the ID made by the one builder', async () => {
    const { sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    const form = partsForm();
    await typeInto(user, form, 'Source', 'source-a');
    await typeInto(user, form, 'Entity type', 'kind-a');
    await typeInto(user, form, 'Stable ID', 'A-1');
    await typeInto(user, form, 'Case reference (optional)', 'CASE-1');
    await user.click(within(form).getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
  });

  it.each(['..', 'a/b', '100%', 'Zoë'])('sends the stable ID %s as it was typed, whatever the route it travels by', async (stableId) => {
    const { sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    const form = partsForm();
    await user.click(within(form).getByLabelText('Source'));
    await user.paste('source-a');
    await user.click(within(form).getByLabelText('Entity type'));
    await user.paste('kind-a');
    await user.click(within(form).getByLabelText('Stable ID'));
    await user.paste(stableId);
    await user.click(within(form).getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { level: 1, name: 'kind-a A-1' });
    expect((sent[0] as { entity: { stableId: string } }).entity.stableId).toBe(stableId);
  });

  it.each([
    ['no source', { source: '', type: 'kind-a', id: 'A-1', caseRef: '' }, 'Give the source.'],
    ['no entity type', { source: 'source-a', type: '', id: 'A-1', caseRef: '' }, 'Give the entity type.'],
    ['no stable ID', { source: 'source-a', type: 'kind-a', id: '', caseRef: '' }, 'Give the stable ID.'],
    ['a source ID that starts with a dot', { source: '.x', type: 'kind-a', id: 'A-1', caseRef: '' }, 'The source ID starts with a letter or a digit'],
    ['a stable ID of 201 characters', { source: 'source-a', type: 'kind-a', id: 'x'.repeat(201), caseRef: '' }, 'longer than 200 characters'],
    ['a case reference of 101 characters', { source: 'source-a', type: 'kind-a', id: 'A-1', caseRef: 'x'.repeat(101) }, 'longer than 100 characters'],
  ])('says which part and why for %s, keeps what was typed and sends nothing', async (_name, values, message) => {
    const { view, sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    const form = partsForm();
    for (const [label, value] of [['Source', values.source], ['Entity type', values.type], ['Stable ID', values.id], ['Case reference (optional)', values.caseRef]] as const) {
      if (value !== '') {
        await user.click(within(form).getByLabelText(label));
        await user.paste(value);
      }
    }
    await user.click(within(form).getByRole('button', { name: 'Open' }));
    const alert = await within(form).findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(document.activeElement).toBe(alert);
    expect(within(form).getByLabelText('Stable ID')).toHaveProperty('value', values.id);
    expect(view.router.state.location.pathname).toBe('/dev/open-link');
    expect(sent).toEqual([]);
  });
});

describe('both forms together', () => {
  it('each Open uses only its own form’s fields', async () => {
    const { sent, user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    await user.click(within(partsForm()).getByLabelText('Source'));
    await user.paste('other');
    await user.click(within(linkForm()).getByLabelText('Link'));
    await user.paste('/source-a/entity/kind-a/A-1');
    await user.click(within(linkForm()).getByRole('button', { name: 'Open' }));
    await screen.findByRole('heading', { name: 'kind-a A-1', level: 1 });
    expect(sent).toHaveLength(1);
    expect((sent[0] as { sourceId: string }).sourceId).toBe('source-a');
  });

  it('is reachable by the keyboard in reading order, with every control named', async () => {
    const { user } = prompt();
    await screen.findByRole('heading', { name: 'Open a deep link', level: 1 });
    const expected = ['Link', 'Open', 'Source', 'Entity type', 'Stable ID', 'Case reference (optional)', 'Open'];
    const reached: string[] = [];
    const sidebarStops = 5;
    for (let presses = 0; presses < 40 && reached.length < expected.length; presses += 1) {
      await user.tab();
      const active = document.activeElement;
      if (active === null || active.closest('form') === null) continue;
      reached.push(active instanceof HTMLButtonElement ? (active.textContent ?? '') : (active.closest('label')?.textContent ?? ''));
    }
    expect(sidebarStops).toBeGreaterThan(0);
    expect(reached).toEqual(expected);
  });
});
