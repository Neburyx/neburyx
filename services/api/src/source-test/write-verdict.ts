import type { PrivilegeRow } from '../gate/templates/privileges.js';

/** Granted rights that read; the inspection never asks for them, and a listing that holds them is judged as if it did not. */
const READ_ONLY_ACTIONS: ReadonlySet<string> = new Set(['access', 'traverse', 'read', 'match', 'execute', 'execute_function', 'load', 'show_index', 'show_constraint']);
/** The graph actions that write; `write` stands for the first six and `graph_actions` for every graph action. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set(['create_element', 'delete_element', 'set_label', 'remove_label', 'set_property', 'merge', 'write', 'graph_actions']);
const SINGLE_WRITES: ReadonlySet<string> = new Set(['create_element', 'delete_element', 'set_label', 'remove_label', 'set_property', 'merge']);
/** Rights that let the login change the source or itself: schema, names, databases, users, roles, privileges and boosted execution. */
const CHANGE_ACTIONS: ReadonlySet<string> = new Set([
  'index',
  'constraint',
  'token',
  'create_label',
  'create_reltype',
  'create_propertykey',
  'transaction_management',
  'start_database',
  'stop_database',
  'dbms_actions',
  'database_actions',
  'admin',
  'database_management',
  'create_database',
  'drop_database',
  'alter_database',
  'set_database_access',
  'alias_management',
  'user_management',
  'create_user',
  'drop_user',
  'alter_user',
  'set_user_status',
  'set_passwords',
  'role_management',
  'create_role',
  'drop_role',
  'rename_role',
  'assign_role',
  'remove_role',
  'privilege_management',
  'assign_privilege',
  'remove_privilege',
  'impersonate',
  'execute_boosted',
  'execute_admin',
]);

const ALL_GRAPHS = '*';

function appliesTo(row: PrivilegeRow, database: string): boolean {
  return row.graph === ALL_GRAPHS || row.graph.toLowerCase() === database.toLowerCase();
}

function denialCoversAction(denied: string, granted: string): boolean {
  if (denied === granted) return true;
  if (denied === 'graph_actions') return WRITE_ACTIONS.has(granted);
  return denied === 'write' && SINGLE_WRITES.has(granted);
}

/** A denial for every graph reaches any grant; one for the source's database reaches a grant that applies to it, whichever graph name the grant carries; any other graph name must match the grant's. */
function denialCoversGraph(denial: PrivilegeRow, grant: PrivilegeRow, database: string): boolean {
  if (denial.graph === ALL_GRAPHS) return true;
  if (denial.graph.toLowerCase() === database.toLowerCase()) return appliesTo(grant, database);
  return denial.graph.toLowerCase() === grant.graph.toLowerCase();
}

function denialCoversSegment(denied: string, granted: string): boolean {
  if (denied === granted || denied === 'ELEMENT(*)') return true;
  return (denied === 'NODE(*)' && granted.startsWith('NODE(')) || (denied === 'RELATIONSHIP(*)' && granted.startsWith('RELATIONSHIP('));
}

function denialCoversResource(denied: string, granted: string): boolean {
  return denied === granted || (denied === 'all_properties' && granted.startsWith('property('));
}

/** True when a denial is for the same action (or a wider one), on the same graph or every graph, and no narrower in segment and resource; anything not visible from the columns does not cover. */
function isCovered(grant: PrivilegeRow, denials: readonly PrivilegeRow[], database: string): boolean {
  return denials.some(
    (denial) =>
      denialCoversAction(denial.action, grant.action) &&
      denialCoversGraph(denial, grant, database) &&
      denialCoversSegment(denial.segment, grant.segment) &&
      denialCoversResource(denial.resource, grant.resource),
  );
}

/**
 * Whether the login can write to the database: true when a right that changes the source applies to it and no denial covers it, false when every right it holds is a read right,
 * and null when the rows cannot settle it (an action this function does not know, a write right on a graph name that may be an alias of the database).
 */
export function loginCanWrite(rows: readonly PrivilegeRow[], database: string): boolean | null {
  const denials = rows.filter((row) => row.access.toUpperCase() === 'DENIED');
  let unsettled = false;
  for (const row of rows) {
    if (row.access.toUpperCase() !== 'GRANTED' || READ_ONLY_ACTIONS.has(row.action) || isCovered(row, denials, database)) continue;
    const changes = WRITE_ACTIONS.has(row.action) || CHANGE_ACTIONS.has(row.action);
    if (changes && appliesTo(row, database)) return true;
    unsettled = true;
  }
  return unsettled ? null : false;
}
