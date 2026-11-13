import type { Field, FormValues } from './form-model.js';
import { windowKey } from './form-model.js';

interface Props {
  readonly fields: readonly Field[];
  readonly values: FormValues;
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (key: string, value: string) => void;
}

/** One control for each field of the model; the controls are made from the schema's fields, never from free text. */
export function PatternForm({ fields, values, errors, onChange }: Props) {
  return (
    <>
      {fields.map((field) => {
        const id = `patterns-field-${field.name}`;
        const error = errors[field.name];
        return (
          <div className="patterns-field" key={field.name}>
            {field.kind === 'window' ? (
              <fieldset className="patterns-field patterns-group">
                <legend className="supernode-label">{field.label}</legend>
                <div className="patterns-dates">
                  <input id={`${id}-from`} type="date" className="patterns-input" aria-label={`${field.label}: from`} value={values[windowKey(field.name, 'from')] ?? ''} onChange={(event) => onChange(windowKey(field.name, 'from'), event.target.value)} aria-invalid={error !== undefined} />
                  <input id={`${id}-to`} type="date" className="patterns-input" aria-label={`${field.label}: to`} value={values[windowKey(field.name, 'to')] ?? ''} onChange={(event) => onChange(windowKey(field.name, 'to'), event.target.value)} aria-invalid={error !== undefined} />
                </div>
              </fieldset>
            ) : (
              <>
                <label className="supernode-label" htmlFor={id}>
                  {field.label}
                </label>
                {field.kind === 'choice' ? (
                  <select id={id} className="patterns-input" value={values[field.name] ?? ''} onChange={(event) => onChange(field.name, event.target.value)}>
                    <option value="" />
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.text}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input id={id} type="text" inputMode="numeric" className="patterns-input" value={values[field.name] ?? ''} onChange={(event) => onChange(field.name, event.target.value)} aria-invalid={error !== undefined} aria-describedby={error === undefined ? undefined : `${id}-error`} />
                )}
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
