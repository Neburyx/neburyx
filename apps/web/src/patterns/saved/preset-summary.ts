import type { SourceProfile } from '@neburyx/contracts';
import { plainName, type Field } from '../form-model.js';

export interface SummaryLine {
  readonly label: string;
  readonly text: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const windowText = (value: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof value['days'] === 'number') return `Last ${value['days']} ${value['days'] === 1 ? 'day' : 'days'}`;
  return typeof value['from'] === 'string' && typeof value['to'] === 'string' ? `${value['from']} – ${value['to']}` : undefined;
};

/** The parameters of a built-in run as the form names them, one line for each field that holds a value; the starting entity is never listed. */
export function fieldsSummary(fields: readonly Field[], params: Readonly<Record<string, unknown>>): readonly SummaryLine[] {
  const lines: SummaryLine[] = [];
  for (const field of fields) {
    const value = params[field.name];
    if (value === undefined) continue;
    const text = textOf(value);
    if (text === undefined) continue;
    const chosen = Array.isArray(value) ? value[0] : value;
    lines.push({ label: field.label, text: field.options?.find((candidate) => candidate.value === chosen)?.text ?? text });
  }
  return lines;
}

type Preset = SourceProfile['presets'][number];

const textOf = (value: unknown): string | undefined => {
  if (isRecord(value)) return windowText(value);
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === 'string' || typeof one === 'number' ? String(one) : undefined;
};

/** The stored parameters of a saved run in a line, for its row: the preset's own labels, or the parameter's plain name, in the order stored; the starting entity is not a parameter and is never listed. */
export function paramsInWords(preset: Pick<Preset, 'labels'>, params: Readonly<Record<string, unknown>>): string {
  return Object.entries(params)
    .filter(([key]) => key !== 'ref')
    .flatMap(([key, value]) => {
      const text = textOf(value);
      return text === undefined ? [] : [`${preset.labels.find((label) => label.key === key)?.text ?? plainName(key)} ${text}`];
    })
    .join(', ');
}
