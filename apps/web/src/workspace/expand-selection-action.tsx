import { useEffect, useRef } from 'react';
import { isEdgeKey, nodeRefOfKey } from '../state/keys.js';
import { NARROWED_BY_FILTERS, cannotExpandText, failedBeforeText, skippedByFiltersText } from './expand-copy.js';
import { neighborTypesOf, planExpansion, useExpandStoreWhenProvided } from './expand-context.js';
import { useClientStateWhenProvided } from '../state/context.js';
import { NO_TYPE_FILTER } from '../state/presentation-state.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { SELECTION_ACTION_ORDER, useSelectionActionRegistryWhenProvided } from './selection-actions.js';

/** Puts *Expand* on the selection bar: each selected entity is expanded by a request of its own, one after another, and the relationships in the selection are left out. Draws nothing. */
export function ExpandSelectionAction() {
  const registry = useSelectionActionRegistryWhenProvided();
  const store = useExpandStoreWhenProvided();
  const profile = useProfileWhenProvided();
  const state = useClientStateWhenProvided();
  const latest = useRef({ store, profile, state });
  latest.current = { store, profile, state };
  useEffect(() => {
    if (registry === undefined || store === undefined) return undefined;
    return registry.register({
      id: 'expand',
      order: SELECTION_ACTION_ORDER.expand,
      label: 'Expand',
      icon: <span className="icon icon-expand" aria-hidden="true" />,
      run: (selection) => {
        const nodes = selection.flatMap((key) => {
          const ref = nodeRefOfKey(key);
          return ref === undefined ? [] : [ref];
        });
        const current = latest.current;
        const filter = current.state?.presentation.view.getState().typeFilter ?? NO_TYPE_FILTER;
        let skipped = 0;
        let narrowed = false;
        const notesOf: string[] = [];
        const askable = nodes.flatMap((ref) => {
          if (neighborTypesOf(current.profile, ref.entityType).length === 0) return [];
          const plan = planExpansion(current.profile, filter, ref.entityType);
          if (plan.neighborTypes.length === 0) {
            skipped += 1;
            return [];
          }
          if (plan.note !== undefined) {
            narrowed = true;
            notesOf.push(plan.note);
          }
          return [{ ref, types: plan.neighborTypes, relTypes: plan.relTypes }];
        });
        // a node the warning holds stops the run; its banner counts the nodes still to ask, and Continue runs the rest after it
        // one entity asked says its own counts; several share one line, since each has counts of its own
        const filterNotes = (): string[] => [...(narrowed ? [askable.length === 1 && notesOf[0] !== undefined ? notesOf[0] : NARROWED_BY_FILTERS] : []), ...(skipped > 0 ? [skippedByFiltersText(skipped)] : [])];
        const from = async (index: number, bounded: boolean): Promise<void> => {
          let failed = 0;
          for (let at = index; at < askable.length; at += 1) {
            const item = askable[at];
            if (item === undefined) return;
            const outcome = await current.store?.expand(item.ref, item.types, item.relTypes, { waiting: askable.length - at, ...(bounded ? { bounded } : {}), after: () => from(at + 1, true) });
            if (outcome === 'failed') failed += 1;
            if (outcome === 'held') {
              // the warning replaces the banner an earlier failure of this run may have shown, so it is told here
              const notes = [...(failed > 0 ? [failedBeforeText(failed)] : []), ...filterNotes()];
              if (notes.length > 0) current.store?.report(notes.join(' '));
              return;
            }
          }
          const notes = filterNotes();
          if (notes.length > 0) current.store?.report(notes.join(' '));
        };
        void from(0, false);
        const blocked = selection.filter((key) => !isEdgeKey(key) && nodeRefOfKey(key) === undefined).length;
        return blocked === 0 ? undefined : cannotExpandText(blocked);
      },
    });
  }, [registry, store]);
  return null;
}
