import { rmSync } from 'node:fs';
import { join } from 'node:path';
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

export interface PackRun {
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
  /** A run that must answer 200 with a result, parsed with the contract; a heavy answer or any other status is an error. */
  readonly ok: (id: string, params: Record<string, unknown>) => Promise<TemplateRunOk>;
  readonly close: () => Promise<void>;
}

/** Loads the shipped pack's demo graph into a database of its own and serves the API over it, as the shipped mapping describes it. Test tooling: it writes only to that database. */
export async function startPackRun(pack: 'banking-fraud' | 'insurance-claims', sourceId: string): Promise<PackRun> {
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
  try {
    await loadExport({ directory, source: { ...mapping, database: server.database }, override: server.boltUri, env: { [mapping.usernameEnv]: server.user, [mapping.passwordEnv]: server.password }, reset: false });
    const text = packMappingText(pack, server.boltUri, server.database).replace(/username_env: [A-Z0-9_]+/, `username_env: ${ENV_USER}`).replace(/password_env: [A-Z0-9_]+/, `password_env: ${ENV_PASSWORD}`);
    const model = parseMapping(text, 'neburyx.yaml');
    const defaults = communitySeams();
    parts = createSourceGate({ mapping: model, env: { [ENV_USER]: server.user, [ENV_PASSWORD]: server.password }, seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
    app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping: model, gate: parts.gate, seams: communitySeams() });
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
  const gate = parts?.gate;
  if (gate === undefined) throw new Error('the pack run has no gate');
  return {
    generated,
    gate,
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
