import { describe, expect, it } from 'vitest';
import { patternAllowlist } from '../testing/pattern-fixtures.js';
import { LOOKUP_INVENTORY as INVENTORY } from '../testing/stable-id-lookups.js';
import { defaultCatalog, defaultCatalogTemplates } from './assemble.js';
import { renderTemplate } from './render.js';

/**
 * Every statement of the catalog that finds an element by its stable ID names the index in a seek hint. The hint keeps the planner from scanning the index when the server has no
 * statistics for it (a fresh index, or one filled after the last sample), so whether a read seeks does not depend on them. The check renders each template the way the gate does and
 * reads the text: a lookup is `<variable>.<property> IN [`, where the property is a stable ID of the mapping, and its clause must carry `USING INDEX SEEK <variable>:<label or type>(<property>)`.
 */
const allowlist = patternAllowlist();
const stableProperties = new Set([...allowlist.stableIds.values(), ...allowlist.relationshipRows.flatMap((row) => (row.stableId === undefined ? [] : [row.stableId]))]);

/** The templates that read no element by its stable ID, or whose lookup is not one to seek, and why. */
const EXCEPTIONS: Record<string, string> = {
  'file-query': 'runs the operator’s own query file, which is theirs to write',
  connectivity: 'reads the server’s components, no element',
  capabilities: 'reads the server’s components, no element',
  privileges: 'reads the user’s privileges, no element',
  'schema-tokens': 'reads the schema’s names, no element',
  'schema-indexes': 'reads the schema’s indexes, no element',
  'schema-draft-tokens': 'reads the schema’s names, no element',
  'schema-draft-indexes': 'reads the schema’s indexes, no element',
  'schema-draft-constraints': 'reads the schema’s constraints, no element',
  'stable-id-duplicates': 'counts the whole index on purpose, the hint without SEEK is the scan it asks for',
  'degree-probe': 'one node of the label, no stable ID in it',
  'entity-search': 'finds nodes by a value, not by a stable ID the person holds; its branches are a follow-up',
  'entity-related': 'a search of related nodes; its branches are a follow-up',
  'relationship-evidence': 'a search of evidence; its branches are a follow-up',
  'search-facets': 'counts the facets of a search; its probes are a follow-up',
  'entity-search-prefix': 'a prefix search; its branches are a follow-up',
};

const LOOKUP = /(\b\w+)\.(`[^`]+`|[A-Za-z_]\w*)\s+IN\s+\[/g;

/** Each lookup of a stable ID in the statement that has no seek hint for its variable and property, as text. */
function unhintedLookups(cypher: string): string[] {
  const found: string[] = [];
  for (const match of cypher.matchAll(LOOKUP)) {
    const variable = match[1] ?? '';
    const property = (match[2] ?? '').replace(/`/g, '');
    if (!stableProperties.has(property)) continue;
    const before = cypher.slice(0, match.index);
    const clause = before.slice(Math.max(before.lastIndexOf('MATCH'), 0));
    const hinted = new RegExp(`USING INDEX SEEK ${variable}:[^(]+\\(\`?${property}\`?\\)`).test(clause);
    if (!hinted) found.push(`${variable}.${property}`);
  }
  return found;
}

const catalog = defaultCatalog();
const statementOf = (id: string, params: Record<string, unknown>) => {
  const template = catalog.find(id);
  if (template === undefined) throw new Error(`no template ${id}`);
  return renderTemplate(template, template.paramsSchema.parse(params) as Record<string, unknown>, allowlist, 25, 100).cypher;
};

describe('every statement that finds an element by its stable ID carries a seek hint', () => {
  it('names every template of the catalog: in the inventory or an exception with its reason', () => {
    const ids = defaultCatalogTemplates().map((template) => template.id);
    expect(ids.filter((id) => !(id in INVENTORY) && !(id in EXCEPTIONS))).toEqual([]);
    expect(Object.keys({ ...INVENTORY, ...EXCEPTIONS }).filter((id) => !ids.includes(id))).toEqual([]);
    expect(Object.keys(INVENTORY).filter((id) => id in EXCEPTIONS)).toEqual([]);
  });

  it.each(Object.entries(INVENTORY))('%s', (id, params) => {
    const cypher = statementOf(id, params);
    expect([...cypher.matchAll(LOOKUP)].length).toBeGreaterThan(0);
    expect(unhintedLookups(cypher)).toEqual([]);
  });

  it('refuses a statement with a lookup and no hint (the check is not empty)', () => {
    expect(unhintedLookups('MATCH (n:`Maker`) WHERE n.`makerId` IN [$stableId, $stableInteger] RETURN n')).toEqual(['n.makerId']);
    expect(unhintedLookups('MATCH (n:`Maker`) USING INDEX SEEK n:`Maker`(`makerId`) WHERE n.`makerId` IN [$stableId, $stableInteger] RETURN n')).toEqual([]);
    expect(unhintedLookups('MATCH (n:`Maker`) USING INDEX n:`Maker`(`makerId`) WHERE n.`makerId` IN [$stableId] RETURN n')).toEqual(['n.makerId']);
    expect(unhintedLookups('MATCH (a:`Maker`) USING INDEX SEEK a:`Maker`(`makerId`) WHERE a.`makerId` IN [$x] MATCH (b:`Maker`) WHERE b.`makerId` IN [$y] RETURN a, b')).toEqual(['b.makerId']);
  });
});
