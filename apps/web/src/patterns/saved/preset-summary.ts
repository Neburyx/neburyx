import type { SourceProfile } from '@neburyx/contracts';
import { dayOf, isDate, plainName, windowLabel, type Field } from '../form-model.js';

export interface SummaryLine {
  readonly label: string;
  readonly text: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const partsOf = (iso: string): { readonly year: number; readonly month: string; readonly day: number } | undefined => {
  if (!isDate(iso)) return undefined;
  const date = new Date(dayOf(iso));
  const month = MONTHS[date.getUTCMonth()];
  return month === undefined ? undefined : { year: date.getUTCFullYear(), month, day: date.getUTCDate() };
};

/** Two dates as the frames write them: "21–28 Oct 2026", "28 Oct – 3 Nov 2026", "28 Dec 2026 – 3 Jan 2027". */
export function dateRange(from: string, to: string): string {
  const a = partsOf(from);
  const b = partsOf(to);
  if (a === undefined || b === undefined) return `${from} – ${to}`;
  if (a.year === b.year && a.month === b.month) return a.day === b.day ? `${a.day} ${a.month} ${a.year}` : `${a.day}–${b.day} ${a.month} ${a.year}`;
  if (a.year === b.year) return `${a.day} ${a.month} – ${b.day} ${b.month} ${a.year}`;
  return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
}

const windowText = (value: Readonly<Record<string, unknown>>): string | undefined => {
  if (typeof value['days'] === 'number') return `Last ${value['days']} ${value['days'] === 1 ? 'day' : 'days'}`;
  return typeof value['from'] === 'string' && typeof value['to'] === 'string' ? dateRange(value['from'], value['to']) : undefined;
};

/** The window of a run in a few words for a name: "7-day window" for a relative one, the dates for a range, nothing when it has none. */
export function windowName(params: Readonly<Record<string, unknown>>): string | undefined {
  const value = params['window'];
  if (!isRecord(value)) return undefined;
  if (typeof value['days'] === 'number') return `${value['days']}-day window`;
  return windowText(value);
}

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
export function paramsInWords(preset: Pick<Preset, 'labels'>, params: Readonly<Record<string, unknown>>, windowText?: string): string {
  return Object.entries(params)
    .filter(([key]) => key !== 'ref')
    .flatMap(([key, value]) => {
      const text = textOf(value);
      const label = preset.labels.find((entry) => entry.key === key)?.text ?? plainName(key);
      return text === undefined ? [] : [`${isRecord(value) ? (windowText ?? windowLabel(label)) : label} ${text}`];
    })
    .join(', ');
}
