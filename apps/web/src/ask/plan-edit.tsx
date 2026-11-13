import { useId } from 'react';
import { EDIT_COPY, type EditField } from './plan-edit-model.js';
import { PLAN_COPY } from './plan-copy.js';
import type { PlanPanel } from './use-plan.js';

/** The editable parameters of the plan as fields, with the words of each refused value beside it; Save sends the edit, Back returns to the plan as it was. */
export function PlanEdit({ panel }: { readonly panel: PlanPanel }) {
  const { stage } = panel;
  const ids = useId();
  if (stage.kind !== 'editing') return null;
  const { values, errors, saving } = stage;
  const field = (item: EditField) => {
    const id = `${ids}-${item.key}`;
    const error = errors[item.key];
    const described = error === undefined ? undefined : `${id}-error`;
    if (item.kind === 'number' || item.kind === 'text') {
      return (
        <div key={item.key} className="ask-plan-field">
          <label htmlFor={id}>{item.label}</label>
          <input id={id} className="ask-plan-input" type="text" inputMode={item.kind === 'number' ? 'numeric' : undefined} value={String(values[item.key] ?? '')} aria-invalid={error !== undefined} aria-describedby={described} disabled={saving} onChange={(event) => panel.setValue(item.key, event.target.value)} />
          {error === undefined ? null : (
            <p id={described} className="ask-note ask-plan-error">
              {error}
            </p>
          )}
        </div>
      );
    }
    if (item.kind === 'choice') {
      const value = values[item.key] ?? (item.multiple ? [] : '');
      return (
        <div key={item.key} className="ask-plan-field">
          <label htmlFor={id}>{item.label}</label>
          <select
            id={id}
            className="ask-plan-input"
            multiple={item.multiple}
            value={item.multiple ? [...(Array.isArray(value) ? value : [])] : String(value)}
            aria-invalid={error !== undefined}
            aria-describedby={described}
            disabled={saving}
            onChange={(event) => panel.setValue(item.key, item.multiple ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value)}
          >
            {item.multiple ? null : <option value="">{EDIT_COPY.none}</option>}
            {item.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.text}
              </option>
            ))}
          </select>
          {error === undefined ? null : (
            <p id={described} className="ask-note ask-plan-error">
              {error}
            </p>
          )}
        </div>
      );
    }
    const kind = String(values['windowKind'] ?? 'none');
    return (
      <fieldset key={item.key} className="ask-plan-field" disabled={saving}>
        <legend>{item.label}</legend>
        <select aria-label={item.label} className="ask-plan-input" value={kind} onChange={(event) => panel.setValue('windowKind', event.target.value)}>
          <option value="none">{EDIT_COPY.windowNone}</option>
          <option value="days">{EDIT_COPY.windowDays}</option>
          <option value="range">{EDIT_COPY.windowRange}</option>
        </select>
        {kind === 'days' ? <input className="ask-plan-input" type="text" inputMode="numeric" aria-label={EDIT_COPY.days} aria-invalid={error !== undefined} value={String(values['windowDays'] ?? '')} onChange={(event) => panel.setValue('windowDays', event.target.value)} /> : null}
        {kind === 'range' ? (
          <>
            <input className="ask-plan-input" type="text" aria-label={EDIT_COPY.from} aria-invalid={error !== undefined} value={String(values['windowFrom'] ?? '')} onChange={(event) => panel.setValue('windowFrom', event.target.value)} />
            <input className="ask-plan-input" type="text" aria-label={EDIT_COPY.to} aria-invalid={error !== undefined} value={String(values['windowTo'] ?? '')} onChange={(event) => panel.setValue('windowTo', event.target.value)} />
          </>
        ) : null}
        {error === undefined ? null : <p className="ask-note ask-plan-error">{error}</p>}
      </fieldset>
    );
  };
  return (
    <form
      className="ask-plan-edit"
      onSubmit={(event) => {
        event.preventDefault();
        panel.save();
      }}
    >
      {stage.fields.map(field)}
      {errors['form'] === undefined ? null : <p className="ask-note ask-plan-error">{errors['form']}</p>}
      {stage.failure === undefined ? null : <p className="ask-note ask-plan-error">{stage.failure.text}</p>}
      <div className="ask-actions">
        <button type="submit" className="ask-primary" disabled={saving}>
          {saving ? PLAN_COPY.saving : PLAN_COPY.save}
        </button>
        <button type="button" className="ask-secondary" disabled={saving} onClick={panel.back}>
          {PLAN_COPY.back}
        </button>
      </div>
    </form>
  );
}
