import { readFileSync, rmSync } from 'node:fs';
import { PRESET_TEMPLATES, templateListResponseSchema } from '../../../packages/contracts/src/index.js';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { z } from 'zod';
import { buildApp } from '../../../services/api/src/app.js';
import { createLogger } from '../../../services/api/src/logger.js';
import { parseMapping } from '../../../services/api/src/mapping/load.js';
import { communitySeams } from '../../../services/api/src/seams/community-seams.js';
import { memoryAppStore } from '../../../services/api/src/testing/app-store.js';
import { TestExecutor } from '../../../services/api/src/testing/gate.js';
import { packMappingText, repoRoot, PACKS, type Pack } from '../../../services/api/src/testing/pack-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../../../services/api/src/testing/search-fixtures.js';
import { testSourceGate } from '../../../services/api/src/testing/source-gate.js';
import { makeWebRoot } from '../../../services/api/src/testing/web-root.js';
import { join } from 'node:path';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const declaredSchema = z.object({
  sources: z.array(z.object({ id: z.string(), patterns: z.array(z.object({ id: z.string(), name: z.string(), template: z.string(), bind: z.record(z.string(), z.string()), labels: z.record(z.string(), z.string()).optional() })).optional() })),
});

/** The presets a pack declares in its own file, as a client reads them: the bind as it is and the labels as a list in the order of their keys. */
function declaredBy(pack: Pack) {
  const file = declaredSchema.parse(parse(readFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), 'utf8')));
  const source = file.sources[0];
  if (source === undefined) throw new Error('the pack has no source');
  return { sourceId: source.id, presets: (source.patterns ?? []).map((preset) => ({ id: preset.id, name: preset.name, template: preset.template, bind: preset.bind, labels: Object.entries(preset.labels ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, text]) => ({ key, text })) })) };
}

async function listOf(pack: Pack) {
  const mapping = parseMapping(packMappingText(pack), 'neburyx.yaml');
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the pack has no source');
  const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), () => Promise.resolve({ status: 'rows' as const, rows: [] })));
  const parts = testSourceGate(mapping, { executor });
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, seams: communitySeams() });
  const response = await app.inject({ method: 'GET', url: `/v1/templates?sourceId=${source.id}` });
  await app.close();
  return { body: templateListResponseSchema.parse(response.json()), executor };
}

describe.each(PACKS)('the template list of the %s pack', (pack) => {
  it('holds exactly the presets the pack declares, in its order, and every built-in template', async () => {
    const { body, executor } = await listOf(pack);
    const declared = declaredBy(pack);
    expect(declared.presets.length).toBeGreaterThan(0);
    expect(body.sourceId).toBe(declared.sourceId);
    expect(body.presets).toEqual(declared.presets);
    expect(body.templates.map((template) => template.id)).toEqual([...PRESET_TEMPLATES]);
    expect(executor.calls).toEqual([]);
  });
});
