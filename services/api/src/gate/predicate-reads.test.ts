import { describe, expect, it } from 'vitest';
import { patternAllowlist } from '../testing/pattern-fixtures.js';
import { LOOKUP_INVENTORY } from '../testing/stable-id-lookups.js';
import { defaultCatalog } from './assemble.js';
import { renderTemplate } from './render.js';

/**
 * A property read of a node or a relationship in the condition of a match that has an anchor is written `head([x.property])`. A direct `x.property` in such a condition lets the planner start the match from an
 * index on the property and join to the anchor, instead of expanding from the anchor, and on the server series this was measured on (5.26) a plan driven from an index by a negated type test returned rows missing
 * the elements that have no value for the property. The wrapped read has the same value and no index can serve it. The one exception is a lookup that a `USING INDEX SEEK` hint serves: the hint needs the direct read.
 * The check renders every template of the inventory and fails for a condition with a direct read, so that a statement added later cannot bring it back; the oracle suite of the Neo4j tests is the guard on the server.
 */
const allowlist = patternAllowlist();
const catalog = defaultCatalog();

const KEYWORD = /^(WITH|RETURN|MATCH|OPTIONAL|CALL|UNWIND|UNION|ORDER|LIMIT|SKIP)\b/;
const READ = /\b[a-z]\w*\.`[^`]+`/g;

/** The text of every `WHERE` condition of a statement: from the word to the next clause of the statement, or to the end of the group that holds it. */
function conditionsOf(cypher: string): string[] {
  const found: string[] = [];
  for (const match of cypher.matchAll(/\bWHERE\b/g)) {
    let depth = 0;
    let end = cypher.length;
    for (let at = (match.index ?? 0) + 5; at < cypher.length; at += 1) {
      const char = cypher[at] ?? '';
      if ('([{'.includes(char)) depth += 1;
      else if (')]}'.includes(char)) {
        depth -= 1;
        if (depth < 0) {
          end = at;
          break;
        }
      } else if (depth === 0 && char === ' ' && KEYWORD.test(cypher.slice(at + 1))) {
        end = at;
        break;
      }
    }
    found.push(cypher.slice((match.index ?? 0) + 5, end));
  }
  return found;
}

/** The text with every `head([ ... ])` taken out. */
function withoutWrapped(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf('head([');
    if (start < 0) return out;
    let depth = 0;
    let at = start + 4;
    for (; at < out.length; at += 1) {
      if (out[at] === '[') depth += 1;
      if (out[at] === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out = `${out.slice(0, start)}${out.slice(at + 2)}`;
  }
}

/** The direct property reads in the conditions of a statement, other than the lookups that a seek hint serves. */
function directReads(cypher: string): string[] {
  const hinted = new Set([...cypher.matchAll(/USING INDEX SEEK (\w+):`[^`]+`\((`[^`]+`)\)/g)].map((hint) => `${hint[1] ?? ''}.${hint[2] ?? ''}`));
  return conditionsOf(cypher).flatMap((condition) => {
    const bare = withoutWrapped(condition);
    return [...bare.matchAll(READ)].flatMap((read) => {
      const served = hinted.has(read[0]) && bare.slice((read.index ?? 0) + read[0].length).startsWith(' IN [');
      return served ? [] : [read[0]];
    });
  });
}

const statementOf = (id: string, params: Record<string, unknown>) => {
  const template = catalog.find(id);
  if (template === undefined) throw new Error(`no template ${id}`);
  return renderTemplate(template, template.paramsSchema.parse(params) as Record<string, unknown>, allowlist, 25, 100).cypher;
};

describe('no condition of a match with an anchor reads a property directly', () => {
  it.each(Object.entries(LOOKUP_INVENTORY))('%s', (id, params) => {
    expect(directReads(statementOf(id, params))).toEqual([]);
  });

  it('fails for a direct read and passes for a wrapped one and for a hinted lookup (the check is not empty)', () => {
    const anchor = 'MATCH (a:`Maker`) USING INDEX SEEK a:`Maker`(`makerId`) WHERE a.`makerId` IN [$stableId, $stableInteger] WITH a LIMIT 1';
    expect(directReads(`${anchor} MATCH (a)-[r:\`LINKS\`]->(m) WHERE NOT (r.\`linkId\` IS :: STRING NOT NULL) RETURN r`)).toEqual(['r.`linkId`']);
    expect(directReads(`${anchor} MATCH (a)-[r:\`LINKS\`]->(m) WHERE NOT (head([r.\`linkId\`]) IS :: STRING NOT NULL) RETURN r`)).toEqual([]);
    expect(directReads(`${anchor} MATCH (a)-[r:\`LINKS\`]->(m) WHERE coalesce(m.\`stop\`, false) <> true AND m <> a RETURN r`)).toEqual(['m.`stop`']);
    expect(directReads(`${anchor} MATCH (a)-[r:\`LINKS\`]->(m) WHERE head([m.\`stop\`]) = 1 RETURN r.\`linkId\``)).toEqual([]);
    expect(directReads('MATCH (a:`Maker`) WHERE a.`makerId` IN [$stableId] RETURN a')).toEqual(['a.`makerId`']);
  });
});
