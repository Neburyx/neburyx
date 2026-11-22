import type { BuiltInDefinition, ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import { relativeTime } from '../../home/relative-time.js';
import { presetSummary, savedSummary } from '../saved/list-model.js';
import { paramValuesOf } from '../saved/preset-summary.js';
import { LIBRARY_COPY } from './library-copy.js';

type Preset = TemplateListResponse['presets'][number];

type Reasons = Extract<ListedPattern['availability'], { status: 'unavailable' }>['reasons'];

export interface LibraryRow {
  readonly key: string;
  readonly name: string;
  readonly pattern: string;
  readonly parameters: string;
  readonly lastRun: string;
  readonly visibility: string;
  readonly reasons: Reasons;
}

const patternOf = (item: ListedPattern, presets: readonly Preset[] | undefined): string =>
  item.kind === 'preset-run' ? presets?.find((preset) => preset.id === item.presetId)?.name ?? item.presetId : LIBRARY_COPY.builtInInTheApp;

const parametersOf = (item: ListedPattern, presets: readonly Preset[] | undefined, nameOf: (type: string) => string): string => {
  if (item.kind === 'definition') return savedSummary(item, presets, nameOf);
  const preset = presets?.find((candidate) => candidate.id === item.presetId);
  return paramValuesOf(preset ?? { labels: [] }, item.params);
};

export function savedRowOf(item: ListedPattern, presets: readonly Preset[] | undefined, nameOf: (type: string) => string, now: number): LibraryRow {
  return {
    key: item.id,
    name: item.name,
    pattern: patternOf(item, presets),
    parameters: parametersOf(item, presets, nameOf) || LIBRARY_COPY.noValue,
    lastRun: item.lastRunAt === null ? LIBRARY_COPY.notRun : relativeTime(item.lastRunAt, now),
    visibility: item.ownedByYou ? (item.visibility === 'shared' ? LIBRARY_COPY.everyone : LIBRARY_COPY.onlyMe) : LIBRARY_COPY.sharedBy(item.owner.name),
    reasons: item.availability.status === 'unavailable' ? item.availability.reasons : [],
  };
}

export function presetRowOf(preset: Preset, nameOf: (type: string) => string): LibraryRow {
  return { key: `preset:${preset.id}`, name: preset.name, pattern: presetSummary(preset, nameOf), parameters: LIBRARY_COPY.noValue, lastRun: LIBRARY_COPY.noValue, visibility: LIBRARY_COPY.builtInVisibility, reasons: [] };
}

export function definitionRowOf(definition: BuiltInDefinition): LibraryRow {
  return { key: `definition:${definition.id}`, name: definition.name, pattern: definition.description ?? definition.group ?? LIBRARY_COPY.noValue, parameters: LIBRARY_COPY.noValue, lastRun: LIBRARY_COPY.noValue, visibility: LIBRARY_COPY.builtInVisibility, reasons: [] };
}

