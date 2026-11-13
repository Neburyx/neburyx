import { patternDefinitionSchema, type ListedPattern, type TemplateListResponse } from '@neburyx/contracts';
import { ARROW } from '../copy.js';
import { pathSummary } from './path-summary.js';

type Preset = TemplateListResponse['presets'][number];

/** The chain of a built-in pattern in a line, from its binding: the start type, the relationship type, the type reached. */
export function presetSummary(preset: Pick<Preset, 'bind'>, nameOf: (type: string) => string): string {
  const { anchor, attribute, target, via } = preset.bind;
  const reached = attribute ?? target ?? anchor;
  return [anchor === undefined ? undefined : nameOf(anchor), via === undefined ? undefined : `${ARROW.out} ${via} ${ARROW.out}`, reached === undefined ? undefined : nameOf(reached)].filter((part): part is string => part !== undefined).join(' ');
}

/** The chain of a saved pattern in a line: from its definition, or, for a saved run of a built-in pattern, from the binding of that pattern. */
export function savedSummary(item: ListedPattern, presets: readonly Preset[] | undefined, nameOf: (type: string) => string): string {
  if (item.kind === 'definition') {
    const parsed = patternDefinitionSchema.safeParse(item.definition);
    return parsed.success ? pathSummary(parsed.data, nameOf) : '';
  }
  const preset = presets?.find((candidate) => candidate.id === item.presetId);
  return preset === undefined ? '' : presetSummary(preset, nameOf);
}

/** Whether a row shows for the search text: the text is in its name or in its chain, ignoring case; no text shows every row. */
export function rowMatches(text: string, name: string, summary: string): boolean {
  const needle = text.trim().toLowerCase();
  return needle === '' || name.toLowerCase().includes(needle) || summary.toLowerCase().includes(needle);
}
