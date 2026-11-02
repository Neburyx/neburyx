import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { privilegeRowSchema, privilegesTemplate, type PrivilegeRow } from '../gate/templates/privileges.js';
import { loginCanWrite } from './write-verdict.js';

// Action names: the "Privileges" reference of the Neo4j Operations Manual, 5.x and 2026.x (the actions `SHOW PRIVILEGES` reports: access, traverse, read, match, write, create_element,
// delete_element, set_label, remove_label, set_property, merge, graph_actions, index, constraint, token, the *_management and database actions, dbms_actions, impersonate, execute_boosted, execute_admin).
// The rows below are synthetic listings written for these cases; the Enterprise cases further down are rows captured from a server.

const row = (action: string, overrides: Partial<PrivilegeRow> = {}): PrivilegeRow => ({ access: 'GRANTED', action, resource: 'graph', graph: '*', segment: 'NODE(*)', ...overrides });
const denied = (action: string, overrides: Partial<PrivilegeRow> = {}): PrivilegeRow => row(action, { access: 'DENIED', ...overrides });

/** What the listing is for the database `neo4j`. */
const verdict = (rows: readonly PrivilegeRow[], database = 'neo4j'): boolean | null => loginCanWrite(rows, database);

const PUBLIC_DEFAULTS = [row('execute'), row('execute_function'), row('load'), row('show_index'), row('show_constraint')];

describe('a login that holds only read rights', () => {
  it.each([
    ['no rows', []],
    ['the read rights', [row('access'), row('traverse'), row('read'), row('match')]],
    ['the read rights and the default rights of the PUBLIC role', [row('match'), row('access'), ...PUBLIC_DEFAULTS]],
  ])('%s cannot write', (_name, rows) => {
    expect(verdict(rows)).toBe(false);
  });
});

describe('a login that holds a right that changes the source', () => {
  it.each([
    'create_element',
    'delete_element',
    'set_label',
    'remove_label',
    'set_property',
    'merge',
    'write',
    'graph_actions',
    'index',
    'constraint',
    'token',
    'create_label',
    'transaction_management',
    'dbms_actions',
    'database_actions',
    'admin',
    'user_management',
    'role_management',
    'privilege_management',
    'assign_role',
    'impersonate',
    'execute_boosted',
    'execute_admin',
  ])('with %s can write', (action) => {
    expect(verdict([row('match'), row(action)])).toBe(true);
  });

  it('can write when the right is among the default rights of the PUBLIC role', () => {
    expect(verdict([...PUBLIC_DEFAULTS, row('execute_boosted')])).toBe(true);
  });

  it('can write on the database named in the source, in any letter case, and on every graph', () => {
    expect(verdict([row('create_element', { graph: 'neo4j' })])).toBe(true);
    expect(verdict([row('create_element', { graph: 'NEO4J' })], 'neo4j')).toBe(true);
    expect(verdict([row('create_element', { graph: 'neo4j' })], 'NEO4J')).toBe(true);
  });
});

describe('a denial', () => {
  it.each([
    ['write granted and set_property denied: the denial is narrower', [row('write'), denied('set_property')], true],
    ['write granted and write denied', [row('write'), denied('write')], false],
    ['write granted and graph_actions denied', [row('write'), denied('graph_actions')], false],
    ['write granted and database_actions denied: another kind of right', [row('write'), denied('database_actions')], true],
    ['set_property granted and denied on every graph', [row('set_property', { resource: 'property(note)' }), denied('set_property', { resource: 'property(note)' })], false],
    ['set_property granted on every graph and denied on another graph', [row('set_property'), denied('set_property', { graph: 'other' })], true],
    ['set_property on a property granted and all properties denied', [row('set_property', { resource: 'property(note)' }), denied('set_property', { resource: 'all_properties' })], false],
    ['set_property on all properties granted and one property denied', [row('set_property', { resource: 'all_properties' }), denied('set_property', { resource: 'property(note)' })], true],
    ['create_element on nodes granted and on nodes and relationships denied', [row('create_element', { segment: 'NODE(Person)' }), denied('create_element', { segment: 'ELEMENT(*)' })], false],
    ['create_element on relationships granted and on nodes denied', [row('create_element', { segment: 'RELATIONSHIP(*)' }), denied('create_element', { segment: 'NODE(*)' })], true],
    ['create_element on every node granted and on one label denied', [row('create_element', { segment: 'NODE(*)' }), denied('create_element', { segment: 'NODE(Person)' })], true],
    ['a grant of graph_actions and a denial of write', [row('graph_actions'), denied('write')], true],
    ['write granted on every graph and denied on the database of the source', [row('write'), denied('write', { graph: 'neo4j' })], false],
    ['write granted on the database and denied on every graph', [row('write', { graph: 'neo4j' }), denied('write')], false],
    ['write granted on every graph and denied on another database', [row('write'), denied('write', { graph: 'other' })], true],
    ['an index right granted and graph_actions denied: graph_actions covers graph actions only', [row('index', { resource: 'database' }), denied('graph_actions')], true],
    ['an unknown action granted and graph_actions denied', [row('an_action_of_a_newer_server'), denied('graph_actions')], null],
    ['dbms_actions granted and graph_actions denied', [row('dbms_actions', { resource: 'database' }), denied('graph_actions')], true],
    ['a grant of an index right and a denial of it', [row('index', { resource: 'database' }), denied('index', { resource: 'database' })], false],
  ] as const)('%s', (_name, rows, expected) => {
    expect(verdict(rows)).toBe(expected);
  });

  it('covers a grant on the same graph in another letter case', () => {
    expect(verdict([row('write', { graph: 'neo4j' }), denied('write', { graph: 'NEO4J' })])).toBe(false);
  });

  it('is ignored when it covers nothing', () => {
    expect(verdict([denied('write')])).toBe(false);
  });
});

describe('a listing the function cannot settle', () => {
  it.each([
    ['an action it does not know', [row('an_action_of_a_newer_server')]],
    ['a write right on the graph HOME', [row('create_element', { graph: 'HOME' })]],
    ['a write right on a graph that may be an alias of the database', [row('create_element', { graph: 'some_alias' })]],
    ['an unknown action, though the read rights are all there is besides', [row('match'), row('show_user')]],
  ])('%s gives null', (_name, rows) => {
    expect(verdict(rows)).toBeNull();
  });

  it('gives true when another row proves the login can write, though one row is unknown', () => {
    expect(verdict([row('an_action_of_a_newer_server'), row('write')])).toBe(true);
  });

  it('gives null, not false, when a write right is on another graph and nothing proves a write on this one', () => {
    expect(verdict([row('set_property', { graph: 'nbxprivcheck' })], 'neo4j')).toBeNull();
  });
});

const fixtureSchema = z.object({
  server: z.object({ product: z.string(), version: z.string(), edition: z.string() }),
  logins: z.record(z.string(), z.object({ roles: z.array(z.string()), rows: z.array(privilegeRowSchema.extend({ role: z.string(), immutable: z.boolean() }).strict()) })),
});
const fixture = fixtureSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'enterprise-privileges-5.26.32.json'), 'utf8')));
const fiveColumns = (login: string): PrivilegeRow[] =>
  (fixture.logins[login]?.rows ?? []).map((captured) => privilegeRowSchema.parse({ access: captured.access, action: captured.action, resource: captured.resource, graph: captured.graph, segment: captured.segment }));

/** The rows the privileges template would return: the Cypher of the template drops the actions it names in its WHERE. */
function templateRows(rows: readonly PrivilegeRow[]): PrivilegeRow[] {
  const list = /action IN \[([^\]]*)\]/.exec(privilegesTemplate.cypher)?.[1] ?? '';
  const excluded = new Set(list.split(',').map((name) => name.trim().replaceAll("'", '')));
  return rows.filter((candidate) => !excluded.has(candidate.action));
}

describe('the rows captured from an Enterprise server', () => {
  it('come from the 5.26 Enterprise edition and hold a login for each built-in role and two custom roles', () => {
    expect(fixture.server).toEqual({ product: 'Neo4j Kernel', version: '5.26.32', edition: 'enterprise' });
    expect(Object.keys(fixture.logins).sort()).toEqual(['admin', 'architect', 'editor', 'publisher', 'reader', 'readonly', 'sneaky']);
  });

  it.each([
    ['reader', 'neo4j', false],
    ['editor', 'neo4j', true],
    ['publisher', 'neo4j', true],
    ['architect', 'neo4j', true],
    ['admin', 'neo4j', true],
    ['readonly', 'nbxprivcheck', false],
    ['readonly', 'neo4j', false],
    ['sneaky', 'nbxprivcheck', true],
  ] as const)('the %s login on the database %s gives %s, from the full listing and from the rows the template returns', (login, database, expected) => {
    expect(loginCanWrite(fiveColumns(login), database)).toBe(expected);
    expect(loginCanWrite(templateRows(fiveColumns(login)), database)).toBe(expected);
  });

  it('give null for the login whose only write right is on a database other than the source, which may be an alias of it', () => {
    expect(loginCanWrite(fiveColumns('sneaky'), 'neo4j')).toBeNull();
  });

  it('leave the reader with no row at all after the template drops the read rights and the defaults of the PUBLIC role', () => {
    expect(templateRows(fiveColumns('reader'))).toEqual([]);
    expect(templateRows(fiveColumns('readonly'))).toEqual([]);
  });

  it('leave the login with a single SET PROPERTY right with that one row', () => {
    expect(templateRows(fiveColumns('sneaky'))).toEqual([{ access: 'GRANTED', action: 'set_property', resource: 'property(note)', graph: 'nbxprivcheck', segment: 'NODE(*)' }]);
  });
});
