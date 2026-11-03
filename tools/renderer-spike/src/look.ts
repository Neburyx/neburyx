import type { Count } from '@neburyx/contracts';
import { createRandom } from './fixture/random.js';
import { ICON_KEYS, type Fixture, type FixtureNode, type FixtureRelationship } from './fixture/schema.js';

export type IconKey = (typeof ICON_KEYS)[number];

export const AREA = { width: 1200, height: 800 } as const;

const ICON_PATHS: Readonly<Record<IconKey, string>> = {
  circle: '<circle cx="12" cy="12" r="6" fill="white"/>',
  square: '<rect x="6" y="6" width="12" height="12" fill="white"/>',
  triangle: '<polygon points="12,5 19,18 5,18" fill="white"/>',
  diamond: '<polygon points="12,4 20,12 12,20 4,12" fill="white"/>',
};

const TYPE_COLORS = ['#2f6f9f', '#7a5aa6', '#2f8a6a', '#b0603a'] as const;

export function iconDataUri(iconKey: IconKey): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${ICON_PATHS[iconKey]}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function typeColor(fixture: Fixture, typeId: string): string {
  const index = fixture.types.findIndex((type) => type.id === typeId);
  return TYPE_COLORS[Math.max(index, 0) % TYPE_COLORS.length] ?? '#555555';
}

export function formatCount(count: Count): string {
  if (count.value === undefined) return '';
  const digits = count.value.toLocaleString('en-US');
  switch (count.quality) {
    case 'exact':
      return digits;
    case 'estimated':
      return `~ ${digits}`;
    case 'lowerBound':
      return `≥ ${digits}`;
    case 'unknown':
      return '';
  }
}

export function typeDisplayName(fixture: Fixture, typeId: string): string {
  return fixture.types.find((type) => type.id === typeId)?.displayName ?? typeId;
}

export function nodeLabel(fixture: Fixture, node: FixtureNode): string {
  if (node.kind === 'neighborAggregate') return `${typeDisplayName(fixture, node.type)} · ${node.loaded} / ${formatCount(node.total)}`;
  return `${node.label}\n${typeDisplayName(fixture, node.type)} · ${node.state}`;
}

export function relationshipLabel(relationship: FixtureRelationship): string {
  if (relationship.kind === 'aggregate') return `${relationship.type} · ${formatCount(relationship.members)}`;
  return relationship.kind === 'derived' ? `${relationship.type} · derived` : relationship.type;
}

export function iconKeyOf(fixture: Fixture, typeId: string): IconKey {
  return fixture.types.find((type) => type.id === typeId)?.iconKey ?? 'circle';
}

export function initialPositions(fixture: Fixture): ReadonlyMap<string, { readonly x: number; readonly y: number }> {
  const random = createRandom(fixture.seed);
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of fixture.nodes) positions.set(node.id, { x: random() * AREA.width, y: random() * AREA.height });
  return positions;
}
