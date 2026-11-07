import type { AdminSession } from '@neburyx/test-neo4j';
import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { createTemplateCatalog, type TemplateDefinition } from '../gate/catalog.js';
import { renderTemplate } from '../gate/render.js';
import type { PlanOperator } from '../gate/types.js';
import type { SourceModel } from '../mapping/model.js';

export interface PlanReading {
  readonly operators: readonly PlanOperator[];
  readonly dbHits: number;
  readonly rows: readonly Record<string, unknown>[];
}

function flatten(plan: ProfiledPlan): PlanOperator[] {
  const details = plan.arguments['Details'];
  return [{ name: plan.operatorType, details: typeof details === 'string' ? details : null, dbHits: plan.dbHits }, ...plan.children.flatMap(flatten)];
}

/** Runs the statement a degree template renders for a node under `PROFILE` as the admin login and returns its operators, their db hits and the row. */
export async function profileDegreeRead(session: Pick<AdminSession, 'run'>, template: TemplateDefinition, source: SourceModel, entityType: string, stableId: string, countCap: number): Promise<PlanReading> {
  const catalog = createTemplateCatalog({ templates: [template] });
  const built = catalog.find(template.id);
  if (built === undefined) throw new Error('the template is not in its catalog');
  const rendered = renderTemplate(built, { entityType, stableId, stableInteger: null }, allowlistFromMapping(source), 1, countCap);
  const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(1), countCap: neo4j.int(countCap) });
  const operators = result.summary.profile === false ? [] : flatten(result.summary.profile);
  return { operators, dbHits: operators.reduce((sum, operator) => sum + operator.dbHits, 0), rows: result.records.map((record) => record.toObject()) };
}
