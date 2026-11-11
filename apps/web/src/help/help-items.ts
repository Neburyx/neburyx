import type { ClientState } from '../state/client-state.js';
import { SHORTCUTS_BINDING_ID } from '../workspace/shortcut-sheet.js';
import { HELP_LINKS } from './links.js';

interface HelpItemBase {
  readonly id: string;
  readonly label: string;
  readonly dividerBefore?: boolean;
}

export type HelpItem =
  | (HelpItemBase & { readonly kind: 'link'; readonly href: string })
  | (HelpItemBase & { readonly kind: 'action'; readonly bindingId: string; readonly run: (state: ClientState) => void });

export const HELP_ITEMS: readonly HelpItem[] = [
  { kind: 'action', id: 'shortcuts', label: 'Keyboard shortcuts', bindingId: SHORTCUTS_BINDING_ID, run: (state) => state.presentation.setSheetOpen(true) },
  { kind: 'link', id: 'documentation', label: 'Documentation', href: HELP_LINKS.documentation },
  { kind: 'link', id: 'quickstart', label: 'Quickstart: the demo case', href: HELP_LINKS.quickstart },
  { kind: 'link', id: 'enterprise', label: 'Talk to us about Enterprise', href: HELP_LINKS.enterprise, dividerBefore: true },
  { kind: 'link', id: 'problem', label: 'Report a problem', href: HELP_LINKS.problem },
];
