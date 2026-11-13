import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { patternRunResponseSchema, type PatternRunResponse } from '../../../../packages/contracts/src/pattern-run.js';
import { savedPatternRunResponseSchema, type SavedPatternRunResponse } from '../../../../packages/contracts/src/saved-pattern-run.js';
import type { Gate } from '../../../../services/api/src/gate/types.js';
import { templateRunResponseSchema, type TemplateRunOk } from '../../../../packages/contracts/src/template-run.js';
import { buildApp } from '../../../../services/api/src/app.js';
import { createSourceGate, type SourceGate } from '../../../../services/api/src/gate/source-gate.js';
import { createLogger } from '../../../../services/api/src/logger.js';
import { parseMapping } from '../../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../../services/api/src/testing/app-store.js';
import { packMappingText } from '../../../../services/api/src/testing/pack-fixtures.js';
import { makeWebRoot } from '../../../../services/api/src/testing/web-root.js';
import { readDefinition } from '../definition.js';
import { writeExport } from '../export.js';
import { generate, type Generated } from '../generate.js';
import { loadExport } from '../load.js';
import { readMappingSource } from '../mapping.js';
import { packFiles } from '../packs.js';
import { startNeo4j, type RunningNeo4j } from './container.js';
import { scratch } from './export-helpers.js';

const ENV_USER = 'DEMO_RUN_USER';
const ENV_PASSWORD = 'DEMO_RUN_PASSWORD';

/** A pack's API as a person using it sees it: saving patterns, listing them and running a saved one, with a key of its own prefix. */
export interface SavedPatternApi {
  /** `POST /v1/patterns` for the pack's source: the pattern saved, or the refusal. */
  readonly save: (body: Record<string, unknown>) => Promise<{ readonly status: number; readonly json: unknown }>;
  /** `GET /v1/patterns` for the pack's source. */
  readonly list: () => Promise<{ readonly items: readonly Record<string, unknown>[] }>;
  /** `POST /v1/patterns/{id}/run`: the answer with its status code and the replay header. */
  readonly run: (id: string, body: Record<string, unknown>, key?: string) => Promise<{ readonly status: number; readonly json: unknown; readonly replayed: boolean }>;
  /** A saved run that must answer 200, parsed with the contract. */
  readonly ok: (id: string, body: Record<string, unknown>) => Promise<SavedPatternRunResponse>;
}

export interface PackRun {
  /** The saved-pattern routes of the pack's API. */
  readonly saved: SavedPatternApi;
  /**
   * A second API over the same database **and the same store of saved patterns**, whose mapping is the pack's with `edit` applied to its text (a type taken out, say): what a person sees after a mapping change. The number of gate calls
   * it made is `gateCalls()`. Close it before closing the run.
   */
  readonly reopen: (edit: (mappingText: string) => string) => Promise<{ readonly saved: SavedPatternApi; readonly gateCalls: () => number; readonly close: () => Promise<void> }>;
  /** The generated export of the pack at its own seed, to compute an expected answer from. */
  readonly generated: Generated;
  /** The lines of the export file of one relationship type, parsed. */
  readonly relationships: (type: string) => readonly { readonly f: string; readonly t: string }[];
  /** The properties of the generated entities of one type. */
  readonly entities: (type: string) => readonly Record<string, unknown>[];
  /** The gate of the pack's source, to run a built-in template that no route runs. */
  readonly gate: SourceGate['gate'];
  /** `POST /v1/templates/{id}/run` for the pack's source; the answer is returned with its status code. */
  readonly run: (id: string, params: Record<string, unknown>) => Promise<{ readonly status: number; readonly json: unknown }>;
  /** `POST /v1/patterns/run` for the pack's source with a key of its own: the answer with its status code and the replay header. */
  readonly patternRun: (body: Record<string, unknown>, key?: string) => Promise<{ readonly status: number; readonly json: unknown; readonly replayed: boolean }>;
  /** A pattern run that must answer 200, parsed with the contract. */
  readonly patternOk: (body: Record<string, unknown>) => Promise<PatternRunResponse>;
  /** A run that must answer 200 with a result, parsed with the contract; a heavy answer or any other status is an error. */
  readonly ok: (id: string, params: Record<string, unknown>) => Promise<TemplateRunOk>;
  readonly close: () => Promise<void>;
}

/** The mapping text with a `budgets` section of the numbers given, under the source's database line (a pack's mapping has none), so that a test can lower a budget of the source it serves. */
export function withBudgets(text: string, budgets: Readonly<Record<string, number>> | undefined): string {
  if (budgets === undefined) return text;
  return text.replace(/^(\s*)(database:\s*\S+)\s*$/m, (_whole, indent: string, line: string) => `${indent}${line}\n${indent}budgets:\n${Object.entries(budgets).map(([name, value]) => `${indent}  ${name}: ${value}`).join('\n')}`);
}

/** Loads the shipped pack's demo graph into a database of its own and serves the API over it, as the shipped mapping describes it. Test tooling: it writes only to that database. */
export async function startPackRun(pack: 'banking-fraud' | 'insurance-claims', sourceId: string, options: { readonly budgets?: Readonly<Record<string, number>> } = {}): Promise<PackRun> {
  const files = packFiles(pack);
  const webRoot = makeWebRoot();
  const mapping = readMappingSource(files.mapping);
  const definition = readDefinition(files.definition, mapping);
  const generated = generate(mapping, definition, definition.seed);
  const directory = join(scratch(), 'export');
  writeExport(directory, generated);
  const server: RunningNeo4j = await startNeo4j();
  let parts: SourceGate | undefined;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const store = memoryAppStore();
  try {
    await loadExport({ directory, source: { ...mapping, database: server.database }, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
    const text = withBudgets(packMappingText(pack, server.boltUri, server.database), options.budgets).replace(/username_env: [A-Z0-9_]+/, `username_env: ${ENV_USER}`).replace(/password_env: [A-Z0-9_]+/, `password_env: ${ENV_PASSWORD}`);
    const model = parseMapping(text, 'neburyx.yaml');
    const defaults = communitySeams();
    parts = createSourceGate({ mapping: model, env: { [ENV_USER]: server.user, [ENV_PASSWORD]: server.password }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
    app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: model, gate: parts.gate, seams: communitySeams() });
    await app.ready();
  } catch (error) {
    await app?.close();
    await parts?.close();
    await server.stop();
    rmSync(webRoot, { recursive: true, force: true });
    throw error;
  }
  const served = app;
  let keys = 0;
  const run: PackRun['run'] = async (id, params) => {
    const response = await served.inject({ method: 'POST', url: `/v1/templates/${id}/run`, payload: { sourceId, params }, headers: { 'idempotency-key': `pack-proof-key-${pack}-${(keys += 1)}` } });
    return { status: response.statusCode, json: response.json() as unknown };
  };
  let patternKeys = 0;
  const patternRun: PackRun['patternRun'] = async (body, key = `pattern-proof-key-${pack}-${(patternKeys += 1)}`) => {
    const response = await served.inject({ method: 'POST', url: '/v1/patterns/run', payload: { sourceId, ...body }, headers: { 'idempotency-key': key } });
    return { status: response.statusCode, json: response.json() as unknown, replayed: response.headers['idempotent-replay'] === 'true' };
  };
  let savedKeys = 0;
  const savedApi = (target: Awaited<ReturnType<typeof buildApp>>): SavedPatternApi => {
    const run: SavedPatternApi['run'] = async (id, body, key = `saved-proof-key-${pack}-${(savedKeys += 1)}`) => {
      const response = await target.inject({ method: 'POST', url: `/v1/patterns/${id}/run`, payload: body, headers: { 'idempotency-key': key } });
      return { status: response.statusCode, json: response.json() as unknown, replayed: response.headers['idempotent-replay'] === 'true' };
    };
    return {
      save: async (body) => {
        const response = await target.inject({ method: 'POST', url: '/v1/patterns', payload: { sourceId, ...body } });
        return { status: response.statusCode, json: response.json() as unknown };
      },
      list: async () => (await target.inject({ method: 'GET', url: `/v1/patterns?sourceId=${sourceId}` })).json() as { items: Record<string, unknown>[] },
      run,
      ok: async (id, body) => {
        const answer = await run(id, body);
        if (answer.status !== 200) throw new Error(`the saved run answered ${answer.status}: ${JSON.stringify(answer.json)}`);
        return savedPatternRunResponseSchema.parse(answer.json);
      },
    };
  };
  const reopen: PackRun['reopen'] = async (edit) => {
    const text = edit(withBudgets(packMappingText(pack, server.boltUri, server.database), options.budgets)).replace(/username_env: [A-Z0-9_]+/, `username_env: ${ENV_USER}`).replace(/password_env: [A-Z0-9_]+/, `password_env: ${ENV_PASSWORD}`);
    const model = parseMapping(text, 'neburyx.yaml');
    const defaults = communitySeams();
    const second = createSourceGate({ mapping: model, env: { [ENV_USER]: server.user, [ENV_PASSWORD]: server.password }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
    let calls = 0;
    const counting: Gate = { run: (request) => ((calls += 1), second.gate.run(request)), runMany: (requests) => ((calls += 1), second.gate.runMany(requests)) };
    const other = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store, mapping: model, gate: counting, seams: communitySeams() });
    await other.ready();
    return {
      saved: savedApi(other),
      gateCalls: () => calls,
      close: async () => {
        await other.close();
        await second.close();
      },
    };
  };
  const gate = parts?.gate;
  if (gate === undefined) throw new Error('the pack run has no gate');
  return {
    generated,
    gate,
    saved: savedApi(served),
    reopen,
    patternRun,
    patternOk: async (body) => {
      const answer = await patternRun(body);
      if (answer.status !== 200) throw new Error(`the pattern run answered ${answer.status}: ${JSON.stringify(answer.json)}`);
      return patternRunResponseSchema.parse(answer.json);
    },
    relationships: (type) => generated.files.filter((file) => file.kind === 'relationship' && file.type === type).flatMap((file) => file.lines).map((line) => {
      const { f, t } = JSON.parse(line) as { f: string; t: string };
      return { f, t };
    }),
    entities: (type) => generated.files.filter((file) => file.kind === 'entity' && file.type === type).flatMap((file) => file.lines).map((line) => (JSON.parse(line) as { p: Record<string, unknown> }).p),
    run,
    ok: async (id, params) => {
      const answer = await run(id, params);
      if (answer.status !== 200) throw new Error(`the run of ${id} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
      const parsed = templateRunResponseSchema.parse(answer.json);
      if (parsed.status !== 'ok') throw new Error(`the run of ${id} stopped as ${parsed.status}: the estimate was ${parsed.estimate.value} (${parsed.estimate.quality}) against a threshold of ${parsed.threshold}`);
      return parsed;
    },
    close: async () => {
      await served.close();
      await parts?.close();
      await server.stop();
      rmSync(webRoot, { recursive: true, force: true });
    },
  };
}
