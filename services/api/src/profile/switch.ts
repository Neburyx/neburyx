import { ConfigError } from '../config.js';
import type { MappingModel } from '../mapping/model.js';

const PROFILE_KEY = 'NEBURYX_PROFILE';

export type Profile = 'community' | 'enterprise';

export interface PreviewInputs {
  readonly profile: Profile;
  readonly aiPreview: boolean;
}

export type PreviewDecision =
  | { readonly state: 'off' }
  | { readonly state: 'on' }
  | { readonly state: 'refused'; readonly message: string };

const PROFILE_WITHOUT_PREVIEW =
  'invalid configuration: NEBURYX_PROFILE=enterprise is set but ai.preview: true is not set in the mapping file; set both or neither';
const PREVIEW_WITHOUT_PROFILE =
  'invalid configuration: ai.preview: true is set in the mapping file but NEBURYX_PROFILE=enterprise is not set; set both or neither';

export function parseProfile(env: Readonly<Record<string, string | undefined>>): Profile {
  const value = env[PROFILE_KEY];
  if (value === undefined || value === '' || value === 'community') return 'community';
  if (value === 'enterprise') return 'enterprise';
  throw new ConfigError([PROFILE_KEY]);
}

export function previewInputsOf(env: Readonly<Record<string, string | undefined>>, mapping: MappingModel): PreviewInputs {
  return { profile: parseProfile(env), aiPreview: mapping.ai?.preview === true };
}

export function decidePreviewSwitch(inputs: PreviewInputs): PreviewDecision {
  const enterprise = inputs.profile === 'enterprise';
  if (enterprise && inputs.aiPreview) return { state: 'on' };
  if (enterprise) return { state: 'refused', message: PROFILE_WITHOUT_PREVIEW };
  if (inputs.aiPreview) return { state: 'refused', message: PREVIEW_WITHOUT_PROFILE };
  return { state: 'off' };
}
