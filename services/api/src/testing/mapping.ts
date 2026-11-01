import { stringify } from 'yaml';
import { expect } from 'vitest';
import { MappingError, type MappingIssue } from '../mapping/diagnostics.js';
import { parseMapping } from '../mapping/load.js';
import type { MappingModel } from '../mapping/model.js';

export type Json = Record<string, unknown>;

export function baseSource(overrides: Json = {}): Json {
  return {
    id: 'demo',
    uri: 'neo4j+s://graph.example.test:7687',
    database: 'neo4j',
    auth: { kind: 'basic', username_env: 'DEMO_USER', password_env: 'DEMO_PASSWORD' },
    entities: [
      { type: 'node_a', label: 'NodeA', stable_id: 'id' },
      { type: 'node_b', label: 'NodeB', stable_id: 'key' },
    ],
    relationships: [{ type: 'LINKS', from: 'node_a', to: 'node_b' }],
    ...overrides,
  };
}

export function fileOf(...sources: Json[]): string {
  return stringify({ sources }, { aliasDuplicateObjects: false });
}

const MARKER = 'SUPPLIED_MARKER';

export const REFUSED_YAML: readonly (readonly [string, string, string])[] = [
  ['a YAML 1.1 directive', `%YAML 1.1\n---\n${fileOf(baseSource({ database: MARKER }))}`, 'YAML version other than 1.2'],
  ['a tag directive', `%TAG !e! tag:example.test,2026:\n---\n${fileOf(baseSource({ database: MARKER }))}`, '%TAG directive'],
  ['a string tag', `${fileOf(baseSource())}    style_rules: [!!str ${MARKER}]\n`, 'uses a tag'],
  ['a custom tag', `${fileOf(baseSource())}    style_rules: [!custom ${MARKER}]\n`, 'TAG_RESOLVE_FAILED'],
  ['a merge tag', `${fileOf(baseSource())}    !!merge <<: ${MARKER}\n`, 'uses a tag'],
  ['an anchor', `${fileOf(baseSource())}    style_rules: [&anchor ${MARKER}]\n`, 'uses an anchor'],
  ['an alias', `${fileOf(baseSource())}    style_rules: [&anchor 1, *anchor]\n`, 'uses an alias'],
  ['an alias to an undefined anchor', `${fileOf(baseSource())}    style_rules: [*${MARKER}]\n`, 'uses an alias'],
  ['an alias that refers to itself', `${fileOf(baseSource())}    style_rules: &loop [*loop]\n`, 'uses an alias'],
  ['a merge key', `${fileOf(baseSource())}    <<: {database: ${MARKER}}\n`, 'uses a merge key'],
  ['a mapping used as a key', `${fileOf(baseSource())}    ? {uri: "neo4j://${MARKER}@example.test"}\n    : x\n`, 'key that is not plain text'],
  ['a sequence used as a key', `${fileOf(baseSource())}    ? [${MARKER}]\n    : x\n`, 'key that is not plain text'],
  ['a second document', `${fileOf(baseSource())}---\nsources: [${MARKER}]\n`, 'more than one document'],
  ['a duplicate key', `${fileOf(baseSource())}    database: ${MARKER}\n`, 'DUPLICATE_KEY'],
  ['a literal block scalar', `${fileOf(baseSource())}    style_rules:\n      - |\n        ${MARKER}\n`, 'block or unsupported text style'],
  ['a folded block scalar', `${fileOf(baseSource())}    style_rules:\n      - >\n        ${MARKER}\n`, 'block or unsupported text style'],
];
export const REFUSED_MARKER = MARKER;

export function load(source: Json): MappingModel {
  return parseMapping(fileOf(source), 'neburyx.yaml');
}

export function issuesOf(text: string): readonly MappingIssue[] {
  try {
    parseMapping(text, 'neburyx.yaml');
  } catch (error) {
    if (error instanceof MappingError) return error.issues;
    throw error;
  }
  throw new Error('expected the mapping to be refused');
}

export function expectRefused(source: Json, path: string, reason: string, context?: string): MappingIssue {
  const issues = issuesOf(fileOf(source));
  const found = issues.find((issue) => issue.path === path && issue.reason.includes(reason) && (context === undefined || issue.context === context));
  expect(found, JSON.stringify(issues)).toBeDefined();
  return found ?? { path, reason };
}

export function firstSource(model: MappingModel) {
  const [source] = model.sources;
  if (source === undefined) throw new Error('expected one source');
  return source;
}
