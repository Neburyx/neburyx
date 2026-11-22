import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Field, FormValues } from './form-model.js';
import { PatternForm } from './pattern-form.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const WINDOW: Field = { name: 'window', label: 'Window · UTC', kind: 'window' };
const HOPS: Field = { name: 'maxHops', label: 'Hops', kind: 'integer', min: 1, max: 4 };

function Harness({ fields, initial, errors = {} }: { readonly fields: readonly Field[]; readonly initial: FormValues; readonly errors?: Readonly<Record<string, string>> }) {
  const [values, setValues] = useState(initial);
  return <PatternForm fields={fields} values={values} errors={errors} onChange={(key, value) => setValues((held) => ({ ...held, [key]: value }))} />;
}

describe('a number field of a short range', () => {
  it('lists every whole number, and shows a value outside the range in the number of Custom', () => {
    render(<Harness fields={[HOPS]} initial={{ maxHops: '5' }} />);
    const select = screen.getByLabelText('Hops');
    expect([...select.querySelectorAll('option')].map((option) => option.textContent)).toEqual(['Default', '1', '2', '3', '4', 'Custom…']);
    expect(select).toHaveProperty('value', 'custom');
    expect(screen.getByLabelText('Hops (number)')).toHaveProperty('value', '5');
  });

  it('offers no Custom while every value is a listed number', () => {
    render(<Harness fields={[HOPS]} initial={{ maxHops: '3' }} />);
    expect([...screen.getByLabelText('Hops').querySelectorAll('option')].at(-1)?.textContent).toBe('4');
    expect(screen.getByLabelText('Hops')).toHaveProperty('value', '3');
    expect(screen.queryByLabelText('Hops (number)')).toBeNull();
  });
});

const LIMIT: Field = { name: 'limit', label: 'Limit', kind: 'integer', min: 1 };

describe('a retained number that the list does not hold', () => {
  it.each([
    ['a short range', HOPS, 'maxHops', '5'],
    ['a long range', LIMIT, 'limit', '37'],
  ])('stays in its input while it is cleared and replaced, in %s', async (_name, field, key, value) => {
    render(<Harness fields={[field]} initial={{ [key]: value }} />);
    const input = screen.getByLabelText(`${field.label} (number)`);
    input.focus();
    await userEvent.clear(input);
    expect(document.activeElement).toBe(screen.getByLabelText(`${field.label} (number)`));
    expect(screen.getByLabelText(field.label)).toHaveProperty('value', 'custom');
    await userEvent.type(screen.getByLabelText(`${field.label} (number)`), '9');
    expect(screen.getByLabelText(`${field.label} (number)`)).toHaveProperty('value', '9');
    await userEvent.selectOptions(screen.getByLabelText(field.label), '');
    expect(screen.queryByLabelText(`${field.label} (number)`)).toBeNull();
  });
});

describe('a window that holds a range', () => {
  it('shows the range alone in the select, opens the dates again from Change dates, and closes them when the focus leaves', async () => {
    render(<Harness fields={[WINDOW]} initial={{ 'window.mode': 'custom', 'window.from': '2026-10-21', 'window.to': '2026-10-28' }} />);
    expect(screen.getByLabelText('Window · UTC').querySelector('option[value="custom"]')?.textContent).toBe('21–28 Oct 2026');
    expect(screen.queryByLabelText('Window · UTC: from')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change dates' }));
    expect(screen.getByLabelText('Window · UTC: from')).toHaveProperty('value', '2026-10-21');
    expect(screen.queryByRole('button', { name: 'Change dates' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Window · UTC: from'));
    fireEvent.blur(screen.getByLabelText('Window · UTC: to'), { relatedTarget: document.body });
    expect(screen.queryByLabelText('Window · UTC: from')).toBeNull();
    expect(screen.getByRole('button', { name: 'Change dates' })).toBeTruthy();
  });

  it('keeps the dates open while one is missing, and points the error at the controls', () => {
    render(<Harness fields={[WINDOW]} initial={{ 'window.mode': 'custom', 'window.from': '2026-10-21' }} errors={{ window: 'Set both dates, or clear both.' }} />);
    expect(screen.getByLabelText('Window · UTC: to')).toBeTruthy();
    const error = screen.getByRole('alert');
    for (const control of [screen.getByLabelText('Window · UTC'), screen.getByLabelText('Window · UTC: from'), screen.getByLabelText('Window · UTC: to')]) expect(control.getAttribute('aria-describedby')).toBe(error.id);
  });
});
