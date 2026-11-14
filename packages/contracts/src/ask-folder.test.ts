import { describe, expect, it } from 'vitest';
import { ASK_FOLDER_LIMITS, parseIntentsFile } from './ask-folder.js';

const QUERY = 'MATCH (n) WHERE n.id = $id RETURN n LIMIT 5';
const file = (intents: unknown): string => JSON.stringify(intents);
const problemsOf = (intents: unknown): readonly string[] => {
  const parsed = parseIntentsFile(typeof intents === 'string' ? intents : file(intents));
  return parsed.ok ? [] : parsed.problems;
};

describe('the intents file', () => {
  it('reads a query intent and a template intent in file order', () => {
    const parsed = parseIntentsFile(file({ byId: { parameters: ['id'], query: QUERY }, shared: { parameters: ['ref'], template: 'shared-attribute', settings: { attributeType: 'shape' } } }));
    expect(parsed).toEqual({
      ok: true,
      intents: [
        { name: 'byId', parameters: ['id'], kind: 'query', query: QUERY },
        { name: 'shared', parameters: ['ref'], kind: 'template', template: 'shared-attribute', settings: { attributeType: 'shape' } },
      ],
    });
  });

  it('takes a template without settings as empty settings', () => {
    expect(parseIntentsFile(file({ one: { parameters: ['ref'], template: 'entity' } }))).toMatchObject({ ok: true, intents: [{ settings: {} }] });
  });

  it.each([
    ['text that is not JSON', 'not json', 'the file is not valid JSON'],
    ['a list', '[]', 'the file must be one object'],
    ['no intent', '{}', 'the file names no intent'],
  ])('refuses %s', (_name, text, expected) => {
    expect(problemsOf(text).join(' ')).toContain(expected);
  });

  it.each([
    ['both a query and a template', { parameters: [], query: 'MATCH (n) RETURN n', template: 'entity' }, 'exactly one of query and template'],
    ['neither', { parameters: [] }, 'exactly one of query and template'],
    ['a template that is not one of the eight', { parameters: [], template: 'saved-pattern' }, 'the template is not one of'],
    ['an unknown key', { parameters: [], query: 'MATCH (n) RETURN n', extra: 1 }, 'the key extra is not known'],
    ['a duplicate parameter', { parameters: ['id', 'id'], query: QUERY }, 'a parameter is listed twice'],
    ['a parameter name with a dash', { parameters: ['a-b'], query: 'MATCH (n) RETURN n' }, 'a parameter name is not'],
    ['parameters that are not a list', { parameters: 'id', query: QUERY }, 'parameters must be a list'],
    ['settings with a query', { parameters: ['id'], query: QUERY, settings: {} }, 'settings belong to a template'],
    ['settings that are not an object', { parameters: [], template: 'entity', settings: [] }, 'settings must be an object'],
    ['an empty query', { parameters: [], query: '  ' }, 'the query must be text'],
    ['a query that writes', { parameters: ['id'], query: 'MATCH (n) WHERE n.id = $id SET n.x = 1 RETURN n' }, 'SET'],
    ['a query whose parameters differ', { parameters: ['other'], query: QUERY }, 'id'],
  ])('refuses %s, naming the intent', (_name, entry, expected) => {
    const problems = problemsOf({ named: entry });
    expect(problems.join(' ')).toContain(expected);
    expect(problems.join(' ')).toContain('"named"');
  });

  it('refuses a name that does not fit and the reserved name of the saved patterns', () => {
    expect(problemsOf({ '1bad': { parameters: [], query: 'MATCH (n) RETURN n' } }).join(' ')).toContain('an intent name is not');
    expect(problemsOf({ 'saved-pattern': { parameters: [], query: 'MATCH (n) RETURN n' } }).join(' ')).toContain('reserved');
  });

  it('refuses a query longer than the limit, more than 20 parameters and more than 200 intents', () => {
    expect(problemsOf({ big: { parameters: [], query: `MATCH (n) RETURN n ${' '.repeat(ASK_FOLDER_LIMITS.queryBytes)}` } }).join(' ')).toContain('the query is longer than');
    const many = Array.from({ length: ASK_FOLDER_LIMITS.parameters + 1 }, (_, index) => `p${index}`);
    expect(problemsOf({ many: { parameters: many, template: 'entity' } }).join(' ')).toContain('more than 20 parameters');
    const intents = Object.fromEntries(Array.from({ length: ASK_FOLDER_LIMITS.intents + 1 }, (_, index) => [`i${index}`, { parameters: [], template: 'entity' }]));
    expect(problemsOf(intents).join(' ')).toContain('more than 200 intents');
  });

  it('refuses an intent name used twice, which JSON.parse would merge', () => {
    const text = '{"same": {"parameters": [], "template": "entity"}, "other": {"parameters": [], "template": "entity"}, "same": {"parameters": [], "template": "entity"}}';
    expect(problemsOf(text)).toEqual(['an intent name is used twice']);
    expect(problemsOf('{"a": {"parameters": [], "template": "entity", "settings": {"same": 1, "same": 2}}}')).toEqual([]);
    const spaced = `{"a": {"parameters": [], "template": "entity"}, "a"${' '.repeat(80)}: {"parameters": [], "template": "entity"}}`;
    expect(problemsOf(spaced)).toEqual(['an intent name is used twice']);
  });

  it('prints a key only when it is plain, and freezes what it returns', () => {
    expect(problemsOf({ named: { parameters: [], template: 'entity', 'bad key\n\u001b[31m': 1 } }).join(' ')).toContain('a key is not known');
    const parsed = parseIntentsFile(file({ one: { parameters: ['id'], template: 'entity', settings: { a: { b: 1 } } } }));
    expect(parsed.ok && Object.isFrozen(parsed.intents[0]?.parameters)).toBe(true);
    expect(parsed.ok && parsed.intents[0]?.kind === 'template' && Object.isFrozen(parsed.intents[0].settings)).toBe(true);
  });

  it('never repeats the text of a query or a value in a problem', () => {
    const problems = problemsOf({ leak: { parameters: [], query: "MATCH (n) WHERE n.x = 'SENTINEL_TEXT' CREATE (m) RETURN n" }, other: { parameters: ['SENTINEL_NAME-x'], template: 'entity' } });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).not.toContain('SENTINEL');
  });
});
