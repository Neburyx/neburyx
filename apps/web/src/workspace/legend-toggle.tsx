import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { Slot } from './slots.js';

let toggleElement: HTMLElement | null = null;

/** Puts the focus on the legend's toggle, where the control that closed the legend from inside it sends it. */
export function focusLegendToggle(): void {
  toggleElement?.focus();
}

/** The legend's toggle: the strip the design draws at the bottom left, which shows the two commonest line styles and opens the legend. */
export function LegendToggle() {
  const state = useClientState();
  const open = useStoreSelector(state.presentation.view, (current) => current.legendOpen);
  return (
    <button
      ref={(element) => {
        toggleElement = element;
      }}
      type="button"
      className="legend-toggle"
      aria-label="Legend" aria-expanded={open} onClick={() => state.presentation.setLegendOpen(!open)}>
      <span className="legend-toggle-sourced" aria-hidden="true">
        — sourced
      </span>
      <span className="legend-toggle-derived" aria-hidden="true">
        - - rule-derived
      </span>
    </button>
  );
}

/** What fills the bottom-left region: the table toggle, when a feature registers one, then the legend toggle. */
export function Toggles() {
  return (
    <>
      <Slot name="table-toggle" />
      <LegendToggle />
    </>
  );
}
