import type { DegreePreview, GraphNode } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { addNamed, anchorItem } from './shared.js';

export const degreeListed = (preview: DegreePreview): ListedElements => listOf([anchorItem(preview.ref, new Map<string, GraphNode>())]);

/** The summary of a degree preview: what kinds of relationships the entity has and to which kinds of neighbors, without the counts (the application shows them). An exact total of nothing says so; a total that is not nothing with no group has no summary. */
export function summarizeDegree(preview: DegreePreview): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(degreeListed(preview));
  const anchor = anchorItem(preview.ref, new Map());
  if (preview.byType.length === 0) {
    if (preview.total.quality === 'exact' && preview.total.value === 0) builder.add(`${anchor.title} has no relationships.`, [preview.ref]);
    return builder.finish();
  }
  for (const group of preview.byType) {
    const direction = group.direction === 'out' ? 'outgoing' : 'incoming';
    addNamed(builder, (list, _count, whole) => `${anchor.title} has ${direction} ${group.relationshipType} relationships to ${whole ? '' : 'types including '}${list}.`, group.neighborTypes.map((type) => ({ title: type })), true, [preview.ref]);
  }
  return builder.finish();
}
