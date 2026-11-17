import { loadAskFolder } from '../folder/load.js';
import type { AskClassification, AskFolder } from '@neburyx/contracts';
import { createAskClassifier } from '../classify/classifier.js';
import { createAuditedModelCall } from '@neburyx/ee-ai-runtime';
import type { ModelProvider } from '@neburyx/ee-ai-runtime';

export interface LoadedSource {
  readonly sourceId: string;
  readonly folder: AskFolder;
  /** The SHA-256 of the bytes of `classification.md`: the hash of the prompt every call of the source carries. */
  readonly classificationSha256: string;
  readonly intents: readonly { readonly name: string; readonly parameters: readonly string[] }[];
}

export type LoadOutcome = { readonly ok: true; readonly source: LoadedSource } | { readonly ok: false; readonly problems: readonly string[] };

/** Reads the folder the way the product does, at start-up: `<folder>/<source id>/{classification.md,intents.json}`. */
export async function loadSource(folder: string, sourceId: string): Promise<LoadOutcome> {
  const loaded = await loadAskFolder({ folder, sourceIds: [sourceId] });
  if (!loaded.ok) return { ok: false, problems: loaded.problems };
  const found = loaded.folder.source(sourceId);
  if (found === undefined) return { ok: false, problems: [`the folder has no subfolder for the source ${sourceId}`] };
  return { ok: true, source: { sourceId, folder: loaded.folder, classificationSha256: found.classification.sha256, intents: found.intents.map((intent) => ({ name: intent.name, parameters: intent.parameters })) } };
}

const ACTOR = '00000000-0000-7000-8000-000000000001';
const SIGNAL = new AbortController().signal;

/**
 * Asks one question through the product's own classifier: the audited call (its events go nowhere here), the classification text of the source as the instructions, the strict reply reader.
 * No saved-pattern catalog is sent, so the question is the whole of the values and one call is made, never two.
 */
export async function classify(source: LoadedSource, provider: ModelProvider, model: string, question: string): Promise<AskClassification> {
  const classifier = createAskClassifier({ model: createAuditedModelCall({ provider, configuration: { model }, sink: { record: async () => undefined } }), folder: () => source.folder });
  return classifier.classify({ sourceId: source.sourceId, question, actorId: ACTOR, actorRole: 'investigator', traceId: 'ask-eval' }, SIGNAL);
}
