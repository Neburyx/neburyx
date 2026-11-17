type Env = Readonly<Record<string, string | undefined>>;

export interface AiEnablement {
  /** A provider key, or the file that holds one, is given. */
  readonly providerConfigured: boolean;
  readonly ask: boolean;
  readonly summary: boolean;
  readonly assistant: boolean;
}

export type AiEnablementRead = { readonly ok: true; readonly enablement: AiEnablement } | { readonly ok: false; readonly problems: readonly string[] };

/** An empty value counts as not given; any value other than `on` or `off` is a problem that names the variable and never repeats the value. */
function flagOf(value: string | undefined, name: string, problems: string[]): boolean {
  if (value === undefined || value === '' || value === 'on') return true;
  if (value === 'off') return false;
  problems.push(`${name} must be on or off`);
  return true;
}

/** The three on/off settings are read only when a provider is configured: with none, no AI feature starts and a bad value is ignored. */
export function readAiEnablement(env: Env): AiEnablementRead {
  const providerConfigured = [env['NEBURYX_ASK_API_KEY'], env['NEBURYX_ASK_API_KEY_FILE']].some((value) => value !== undefined && value !== '');
  if (!providerConfigured) return { ok: true, enablement: { providerConfigured, ask: true, summary: true, assistant: true } };
  const problems: string[] = [];
  const enablement = { providerConfigured, ask: flagOf(env['NEBURYX_ASK_ENABLED'], 'NEBURYX_ASK_ENABLED', problems), summary: flagOf(env['NEBURYX_SUMMARY_ENABLED'], 'NEBURYX_SUMMARY_ENABLED', problems), assistant: flagOf(env['NEBURYX_ASSISTANT_ENABLED'], 'NEBURYX_ASSISTANT_ENABLED', problems) };
  return problems.length > 0 ? { ok: false, problems } : { ok: true, enablement };
}

/** Whether the enterprise extension is loaded: the old switch is on, or a provider is configured and Ask or the summary is on. The assistant alone loads nothing until it is built. */
export function extensionWanted(enablement: AiEnablement, oldSwitchOn: boolean): boolean {
  return oldSwitchOn || (enablement.providerConfigured && (enablement.ask || enablement.summary));
}
