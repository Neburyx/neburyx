import { AI_LABELS } from '../ai/copy.js';

/** Puts the focus back on the Ask control of the header, which opened the panel. */
export function focusAskControl(): void {
  const controls = document.querySelectorAll<HTMLElement>('.header-ai-unlocked');
  for (const control of controls) {
    if (control.textContent?.trim() === AI_LABELS.ask) {
      control.focus();
      return;
    }
  }
}
