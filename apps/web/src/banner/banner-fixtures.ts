import type { BannerAction, BannerState } from './banner-state.js';

export function action(id: string, label: string, run: () => void = () => undefined, disabled?: boolean): BannerAction {
  return disabled === undefined ? { id, label, run } : { id, label, run, disabled };
}

export function sampleBanner(overrides: Partial<BannerState> = {}): BannerState {
  return {
    id: 'sample',
    tone: 'warning',
    chip: 'Sample',
    headline: 'A sample headline',
    text: 'A sample explanation line.',
    sideLabel: 'A side label',
    actions: [action('first', 'First action')],
    ...overrides,
  };
}
