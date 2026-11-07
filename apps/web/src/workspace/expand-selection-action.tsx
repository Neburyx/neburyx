import { useEffect, useRef } from 'react';
import { isEdgeKey, nodeRefOfKey } from '../state/keys.js';
import { cannotExpandText } from './expand-copy.js';
import { neighborTypesOf, useExpandStoreWhenProvided } from './expand-context.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useSelectionActionRegistryWhenProvided } from './selection-actions.js';

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
      label: 'Expand',
      icon: <span className="icon icon-expand" aria-hidden="true" />,
      run: (selection) => {
        const nodes = selection.flatMap((key) => {
          const ref = nodeRefOfKey(key);
          return ref === undefined ? [] : [ref];
        });
        const current = latest.current;
        void (async () => {
          for (const ref of nodes) {
            const types = neighborTypesOf(current.profile, ref.entityType);
            if (types.length > 0) await current.store?.expand(ref, types);
          }
        })();
        const blocked = selection.filter((key) => !isEdgeKey(key) && nodeRefOfKey(key) === undefined).length;
        return blocked === 0 ? undefined : cannotExpandText(blocked);
      },
    });
  }, [registry, store]);
  return null;
}
