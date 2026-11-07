import neo4j from 'neo4j-driver';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { assembleGate } from '../gate/assemble.js';
import { createTemplateCatalog } from '../gate/catalog.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { renderTemplate } from '../gate/render.js';
import { SEARCH_FACETS_ID, searchFacetsTemplate, type FacetProbe } from '../gate/templates/search-facets.js';
import type { SourceModel } from '../mapping/model.js';
import { createSearchService, type SearchRequest } from '../search/search-service.js';
import { communitySeams } from '../seams/community-seams.js';
import { createNeo4jExecutor, type Neo4jExecutor } from '../sources/executor.js';
import { prepareParameters } from '../sources/parameters.js';
import { LOCAL_PRINCIPAL } from './gate.js';
import { envFor, runAll, runAdmin, sourceFor, startNeo4j, type RunningNeo4j } from './neo4j-server.js';
import { communityAccess } from './source-access.js';

export interface FacetsRigOptions {
  readonly mapping: Record<string, unknown>;
  /** Makes the indexes and the data of the database, after it exists. */
  readonly seed: (run: (cypher: string, parameters?: Record<string, unknown>) => Promise<void>) => Promise<void>;
}

export interface PlanOperator {
  readonly name: string;
  readonly rows: number;
  readonly dbHits: number;
  readonly details: string;
}

/**
 * A real Neo4j database of one test file with the search service on it: the service reads through the real gate and the real adapter with the read-only login of the run, every data statement it sends is recorded, and
 * `hook` may answer a statement instead of the server (to make a read time out), which the schema read can be spared. `independent` counts with a query of the test's own, and `profile` runs the facet statement of probes with `PROFILE`.
 */
export async function startFacetsRig(options: FacetsRigOptions) {
  const server = await startNeo4j();
  const source: SourceModel = sourceFor(server, options.mapping);
  const statements: ExecuteCall[] = [];
  let hook: ((call: ExecuteCall) => ExecuteOutcome | undefined) | undefined;
  let executor: Neo4jExecutor | undefined;
  try {
    await options.seed((cypher, parameters = {}) => runAdmin(server, cypher, parameters));
    await runAdmin(server, 'CALL db.awaitIndexes(120)');
    const defaults = communitySeams();
    let busy = false;
    const coordinator = { acquireRead: (request: Parameters<typeof defaults.coordinator.acquireRead>[0]) => (busy ? Promise.resolve({ status: 'busy' as const }) : defaults.coordinator.acquireRead(request)) };
    executor = createNeo4jExecutor({ sources: [source], env: envFor(server), logger: { warn: () => undefined } });
    const real = executor;
    const recording: Neo4jExecutor = {
      ...real,
      execute: (call) => {
        statements.push(call);
        const answer = hook?.(call);
        return answer === undefined ? real.execute(call) : Promise.resolve(answer);
      },
    };
    const assembled = assembleGate({ mapping: { sources: [source] }, seams: { policy: defaults.policy, coordinator, audit: defaults.audit }, executor: recording, logger: { warn: () => undefined } });
    const service = createSearchService({ gate: assembled.gate, indexes: assembled.indexes, mapping: { sources: [source] }, access: communityAccess({ sources: [source] }) });
    return {
      server,
      source,
      statements,
      search: (text: string, request: Partial<SearchRequest> = {}) => service.search({ traceId: 'tr-facets', principal: LOCAL_PRINCIPAL, sourceId: 'graph', text, mask: false, ...request }),
      admin: (cypher: string) => runAdmin(server, cypher),
      setBusy: (flag: boolean) => void (busy = flag),
      onStatement: (answer: ((call: ExecuteCall) => ExecuteOutcome | undefined) | undefined) => void (hook = answer),
      independent: async (cypher: string, parameters: Record<string, unknown> = {}): Promise<number> => {
        const session = server.admin.session({ database: server.database });
        try {
          const result = await session.run(cypher, parameters);
          return neo4j.integer.toNumber(result.records[0]?.get('c'));
        } finally {
          await session.close();
        }
      },
      profile: async (text: string, probes: readonly FacetProbe[], countCap = source.budgets.heavyOpThreshold): Promise<{ readonly operators: PlanOperator[]; readonly row: Record<string, number> }> => {
        const template = createTemplateCatalog({ templates: [searchFacetsTemplate] }).find(SEARCH_FACETS_ID);
        if (template === undefined) throw new Error('no facet template');
        const rendered = renderTemplate(template, template.paramsSchema.parse({ text, probes }), allowlistFromMapping(source), 25, countCap);
        const session = server.admin.session({ database: server.database });
        try {
          const result = await session.run(`PROFILE ${rendered.cypher}`, prepareParameters(rendered.parameters, []));
          const operators: PlanOperator[] = [];
          const number = (value: unknown): number => (typeof value === 'number' ? value : neo4j.isInt(value) ? neo4j.integer.toNumber(value) : 0);
          const walk = (node: unknown): void => {
            if (!isPlanNode(node)) return;
            operators.push({ name: node.operatorType, rows: number(node.rows), dbHits: number(node.dbHits), details: String(node.arguments?.['Details'] ?? '') });
            node.children.forEach(walk);
          };
          walk(result.summary.profile);
          const first = result.records[0];
          const row = first === undefined ? {} : Object.fromEntries(first.keys.map((key) => [String(key), neo4j.integer.toNumber(first.get(key))]));
          return { operators, row };
        } finally {
          await session.close();
        }
      },
      close: () => runAll([() => executor?.close(), () => server.stop()]),
    };
  } catch (error) {
    await runAll([() => executor?.close(), () => server.stop()]).catch(() => undefined);
    throw error;
  }
}

interface PlanNode {
  readonly operatorType: string;
  readonly rows: unknown;
  readonly dbHits: unknown;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly children: readonly unknown[];
}

function isPlanNode(value: unknown): value is PlanNode {
  return typeof value === 'object' && value !== null && 'operatorType' in value && typeof value.operatorType === 'string' && 'children' in value && Array.isArray(value.children);
}

export type FacetsRig = Awaited<ReturnType<typeof startFacetsRig>>;
export type { RunningNeo4j };
