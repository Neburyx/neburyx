import type { DegreePreview, GraphNode } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { countWords } from './counts.js';
import { anchorItem } from './shared.js';

export const degreeListed = (preview: DegreePreview): ListedElements => listOf([anchorItem(preview.ref, new Map<string, GraphNode>())]);

export function summarizeDegree(preview: DegreePreview): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(degreeListed(preview));
  const anchor = anchorItem(preview.ref, new Map());
  builder.add(`Relationships of ${anchor.title}: ${countWords(preview.total)}.`, [preview.ref]);
  for (const group of preview.byType) {
    builder.add(`${group.relationshipType} (${group.direction === 'out' ? 'outgoing' : 'incoming'}): ${countWords(group.count)}, to ${group.neighborTypes.join(', ')}.`, [preview.ref]);
  }
  return builder.finish();
}
