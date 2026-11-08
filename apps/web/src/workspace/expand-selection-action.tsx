import { useEffect, useRef } from 'react';
import { isEdgeKey, nodeRefOfKey } from '../state/keys.js';
import { cannotExpandText, failedBeforeText } from './expand-copy.js';
import { neighborTypesOf, useExpandStoreWhenProvided } from './expand-context.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { SELECTION_ACTION_ORDER, useSelectionActionRegistryWhenProvided } from './selection-actions.js';

/** Puts *Expand* on the selection bar: each selected entity is expanded by a request of its own, one after another, and the relationships in the selection are left out. Draws nothing. */
export function ExpandSelectionAction() {
  const registry = useSelectionActionRegistryWhenProvided();
  const store = useExpandStoreWhenProvided();
  const profile = useProfileWhenProvided();
  const latest = useRef({ store, profile });
  latest.current = { store, profile };
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
        const askable = nodes.flatMap((ref) => {
          const types = neighborTypesOf(current.profile, ref.entityType);
          return types.length > 0 ? [{ ref, types }] : [];
        });
        // a node the warning holds stops the run; its banner counts the nodes still to ask, and Continue runs the rest after it
        const from = async (index: number, bounded: boolean): Promise<void> => {
          let failed = 0;
          for (let at = index; at < askable.length; at += 1) {
            const item = askable[at];
            if (item === undefined) return;
            const outcome = await current.store?.expand(item.ref, item.types, undefined, { waiting: askable.length - at, ...(bounded ? { bounded } : {}), after: () => from(at + 1, true) });
            if (outcome === 'failed') failed += 1;
            if (outcome === 'held') {
              // the warning replaces the banner an earlier failure of this run may have shown, so it is told here
              if (failed > 0) current.store?.report(failedBeforeText(failed));
              return;
            }
          }
        };
        void from(0, false);
        const blocked = selection.filter((key) => !isEdgeKey(key) && nodeRefOfKey(key) === undefined).length;
        return blocked === 0 ? undefined : cannotExpandText(blocked);
      },
    });
  }, [registry, store]);
  return null;
}
