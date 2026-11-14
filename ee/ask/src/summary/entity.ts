import type { GraphNode } from '@neburyx/contracts';
import { SummaryBuilder, listOf, type ListedElements } from './core.js';
import { nodeItem } from './shared.js';
import { nodeTitle } from './title.js';

export const entityListed = (node: GraphNode): ListedElements => listOf([nodeItem(node)]);

export function summarizeEntity(node: GraphNode): ReturnType<SummaryBuilder['finish']> {
  const builder = new SummaryBuilder(entityListed(node));
  builder.add(`${nodeTitle(node)} is of type ${node.display.type}.`, [node.ref]);
  return builder.finish();
}
