import type { LabelledCase } from '../cases.js';
import type { RunSettings } from './hooks.js';
import { UsageError } from './paths.js';

interface ManifestCategory {
  readonly name: string;
  readonly views: number;
  /** The most requests the category can make. */
  readonly mostCalls: number;
  /** The fewest: one request for each view. */
  readonly leastCalls: number;
}

export interface Manifest {
  readonly categories: readonly ManifestCategory[];
  readonly mostCalls: number;
  readonly leastCalls: number;
}

export type MeasureMode = 'none' | 'add' | 'only';

/** The sizes of the plain samples a measuring run builds: 10 and 100 elements and the element cap. */
export const sampleSizes = (settings: RunSettings): number[] => [...new Set([10, 100, settings.maxElements])].sort((left, right) => left - right);

/** The sizes of the samples whose elements carry properties, twice (a realistic set of properties and a heavy one): 100 elements and the element cap. */
export const richSampleSizes = (settings: RunSettings): number[] => [...new Set([100, settings.maxElements])].sort((left, right) => left - right);

/**
 * What a run can cost before it is made: each category of views with the most and the fewest requests it can make. A scoring view can make as many as the call limit (a reply that does not fit, a verdict, an emptied
 * reply each earn a further call); a measuring view makes one request and no further call.
 */
export function manifestOf(scoring: readonly LabelledCase[], settings: RunSettings, measure: MeasureMode = 'none'): Manifest {
  const categories: ManifestCategory[] = [];
  if (measure !== 'only') categories.push({ name: 'scoring', views: scoring.length, mostCalls: scoring.length * settings.maxCalls, leastCalls: scoring.length });
  if (measure !== 'none') {
    const views = scoring.length + sampleSizes(settings).length + 2 * richSampleSizes(settings).length;
    categories.push({ name: 'measurement', views, mostCalls: views, leastCalls: views });
  }
  return { categories, mostCalls: categories.reduce((total, each) => total + each.mostCalls, 0), leastCalls: categories.reduce((total, each) => total + each.leastCalls, 0) };
}

/** The views a run is asked to cover: all of them, the demo views, the AML views, or the ids named. */
export function selectViews(cases: readonly LabelledCase[], selection: string): LabelledCase[] {
  if (selection === 'all') return [...cases];
  if (selection === 'demo') return cases.filter((each) => each.source_case !== undefined);
  if (selection === 'aml') return cases.filter((each) => each.shape !== undefined);
  const ids = selection.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const unknown = ids.filter((id) => !cases.some((each) => each.id === id));
  if (unknown.length > 0 || ids.length === 0) throw new UsageError(`--views names no view of the set: ${unknown.join(', ')}`);
  return cases.filter((each) => ids.includes(each.id));
}
