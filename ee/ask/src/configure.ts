import { type ConfigureOutcome } from '@neburyx/contracts';
import { configureProvider, given, type Env, type ProviderConfiguration } from '@neburyx/ee-ai-runtime';

export interface AskConfiguration extends ProviderConfiguration {
  /** The folder of the intents and the classification text; read once at start-up. */
  readonly mappingFolder: string;
}

const FOLDER_VARIABLE = 'NEBURYX_ASK_MAPPING_FOLDER';

/** The folder of the intents where Ask is off: the assistant's `ask` route reads it when it is given, and runs without it when it is not. */
export function optionalFolderChoice(env: Env): { readonly folder?: string; readonly problems: readonly string[] } {
  return given(env, FOLDER_VARIABLE) === undefined ? { problems: [] } : folderChoice(env);
}

export type Configuration = { readonly outcome: ConfigureOutcome; readonly configuration?: AskConfiguration };

function folderChoice(env: Env): { readonly folder?: string; readonly problems: readonly string[] } {
  const folder = given(env, FOLDER_VARIABLE);
  if (folder === undefined) return { problems: [`${FOLDER_VARIABLE} is required when the AI preview is on`] };
  if (!folder.startsWith('/')) return { problems: [`${FOLDER_VARIABLE} must be an absolute path`] };
  return { folder, problems: [] };
}

/** Checks the settings of Ask, which are in the environment: the provider's and the folder of its intents. */
export async function configureAsk(env: Env): Promise<Configuration> {
  const chosen = folderChoice(env);
  const provided = await configureProvider(env);
  const problems = [...chosen.problems, ...(provided.outcome.ok ? [] : provided.outcome.problems)];
  if (problems.length > 0 || chosen.folder === undefined || provided.configuration === undefined) return { outcome: { ok: false, problems } };
  return { outcome: { ok: true }, configuration: { ...provided.configuration, mappingFolder: chosen.folder } };
}
