import { useEffect, useRef, useState } from 'react';
import { FORM_COPY } from './copy.js';
import { RELATIVE_WINDOWS, customKey, stepsOf, windowKey, windowModeKey, type Field, type FormValues } from './form-model.js';
import { dateRange } from './saved/preset-summary.js';

interface Props {
  readonly fields: readonly Field[];
  readonly values: FormValues;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
}

const DEFAULT = '';
const CUSTOM = 'custom';

function WindowField({ field, values, error, onChange }: { readonly field: Field; readonly values: FormValues; readonly error: string | undefined; readonly onChange: Props['onChange'] }) {
  const id = `patterns-field-${field.name}`;
  const from = values[windowKey(field.name, 'from')] ?? '';
  const to = values[windowKey(field.name, 'to')] ?? '';
  const mode = values[windowModeKey(field.name)] ?? '';
  const chosen = mode === CUSTOM || from !== '' || to !== '' ? CUSTOM : mode;
  const committed = from !== '' && to !== '';
  const range = committed ? dateRange(from, to) : FORM_COPY.customRange;
  const [editing, setEditing] = useState(false);
  const fromInput = useRef<HTMLInputElement>(null);
  const focusOnOpen = useRef(false);
  const showDates = chosen === CUSTOM && (editing || !committed);
  const describedBy = error === undefined ? undefined : `${id}-error`;
  useEffect(() => {
    if (showDates && focusOnOpen.current) fromInput.current?.focus();
    focusOnOpen.current = false;
  }, [showDates]);
  const choose = (value: string): void => {
    setEditing(value === CUSTOM);
    onChange(windowModeKey(field.name), value);
    if (value !== CUSTOM) {
      onChange(windowKey(field.name, 'from'), '');
      onChange(windowKey(field.name, 'to'), '');
    }
  };
  return (
    <>
      <label className="supernode-label" htmlFor={id}>
        {field.label}
      </label>
      <select id={id} className="patterns-input" value={chosen} aria-invalid={error !== undefined} aria-describedby={describedBy} onChange={(event) => choose(event.target.value)}>
        <option value={DEFAULT}>{FORM_COPY.anyTime}</option>
        {RELATIVE_WINDOWS.map((days) => (
          <option key={days} value={`days:${days}`}>
            {FORM_COPY.lastDays(days)}
          </option>
        ))}
        <option value={CUSTOM}>{range}</option>
      </select>
      {chosen === CUSTOM && !showDates ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            focusOnOpen.current = true;
            setEditing(true);
          }}
        >
          {FORM_COPY.changeDates}
        </button>
      ) : null}
      {showDates ? (
        <div
          className="patterns-dates"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setEditing(false);
          }}
        >
          <input ref={fromInput} id={`${id}-from`} type="date" className="patterns-input" aria-label={`${field.label}: from`} value={from} onChange={(event) => onChange(windowKey(field.name, 'from'), event.target.value)} aria-invalid={error !== undefined} aria-describedby={describedBy} />
          <input id={`${id}-to`} type="date" className="patterns-input" aria-label={`${field.label}: to`} value={to} onChange={(event) => onChange(windowKey(field.name, 'to'), event.target.value)} aria-invalid={error !== undefined} aria-describedby={describedBy} />
        </div>
      ) : null}
    </>
  );
}

function NumberField({ field, values, error, onChange }: { readonly field: Field; readonly values: FormValues; readonly error: string | undefined; readonly onChange: Props['onChange'] }) {
  const id = `patterns-field-${field.name}`;
  const value = values[field.name] ?? '';
  const { steps, whole } = stepsOf(field);
  const unlisted = value !== '' && !steps.some((step) => String(step) === value.trim());
  const own = unlisted || values[customKey(field.name)] === '1';
  const chosen = own ? CUSTOM : value.trim();
  const choose = (next: string): void => {
    if (next === CUSTOM) return onChange(customKey(field.name), '1');
    onChange(customKey(field.name), '');
    onChange(field.name, next);
  };
  return (
    <>
      <label className="supernode-label" htmlFor={id}>
        {field.label}
      </label>
      <select id={id} className="patterns-input" value={chosen} aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-error`} onChange={(event) => choose(event.target.value)}>
        <option value={DEFAULT}>{FORM_COPY.defaultChoice}</option>
        {steps.map((step) => (
          <option key={step} value={String(step)}>
            {step}
          </option>
        ))}
        {whole && !own ? null : <option value={CUSTOM}>{FORM_COPY.customNumber}</option>}
      </select>
      {own ? (
        <input type="text" inputMode="numeric" className="patterns-input" aria-label={FORM_COPY.numberOf(field.label)} value={value}
          onChange={(event) => {
            onChange(customKey(field.name), '1');
            onChange(field.name, event.target.value);
          }}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? undefined : `${id}-error`}
        />
      ) : null}
    </>
  );
}

/** One control for each field of the model; the controls are made from the schema's fields, never from free text. A date range or a number of one's own is entered after choosing "Custom". */
export function PatternForm({ fields, values, errors, onChange }: Props) {
  return (
    <>
      {fields.map((field) => {
        const id = `patterns-field-${field.name}`;
        const error = errors[field.name];
        return (
          <div className="patterns-field" key={field.name}>
            {field.kind === 'window' ? (
              <WindowField field={field} values={values} error={error} onChange={onChange} />
            ) : field.kind === 'integer' ? (
              <NumberField field={field} values={values} error={error} onChange={onChange} />
            ) : (
              <>
                <label className="supernode-label" htmlFor={id}>
                  {field.label}
                </label>
                <select id={id} className="patterns-input" value={values[field.name] ?? ''} onChange={(event) => onChange(field.name, event.target.value)}>
                  <option value="" />
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.text}
                    </option>
                  ))}
                </select>
              </>
            )}
            {error === undefined ? null : (
              <p className="patterns-error" id={`${id}-error`} role="alert">
                {error}
              </p>
            )}
          </div>
        );
      })}
    </>
  );
}
