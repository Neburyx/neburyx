import { useEffect, useRef, useState } from 'react';
import type { InvestigationListItem } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';

const keyOf = (item: InvestigationListItem): string => `${item.sourceId}\u0000${item.startingEntity?.entityType ?? ''}\u0000${item.startingEntity?.stableId ?? ''}`;

/** The label of a starting entity as the source gives it now, or `undefined` while it is not read, was not found or could not be read. */
export type Labels = ReadonlyMap<string, string>;

export const labelOf = (labels: Labels, item: InvestigationListItem): string | undefined => labels.get(keyOf(item));

/**
 * Reads the labels of the starting entities of the rows shown, one call for each source, after the rows are drawn. Only rows not asked for before are read, a row of a source that is removed or
 * re-pointed is not, and an answer that comes after the filters changed is dropped, its rows being asked for again if they are still shown. Nothing is written back and a failure leaves the row as it is.
 */
export function useRowLabels(client: ApiClient, items: readonly InvestigationListItem[] | undefined, listKey: string): Labels {
  const [labels, setLabels] = useState<Labels>(new Map());
  const [dropped, setDropped] = useState(0);
  const asked = useRef(new Set<string>());
  const abort = useRef(new AbortController());
  const current = useRef(listKey);
  current.current = listKey;

  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    asked.current.clear();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (items === undefined) return;
    const bySource = new Map<string, InvestigationListItem[]>();
    for (const item of items) {
      const start = item.startingEntity;
      if (start === null || item.sourceState !== 'available') continue;
      const key = keyOf(item);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      bySource.set(item.sourceId, [...(bySource.get(item.sourceId) ?? []), item]);
    }
    for (const [sourceId, rows] of bySource) {
      const entities = rows.flatMap((item) => (item.startingEntity === null ? [] : [{ sourceId, entityType: item.startingEntity.entityType, stableId: item.startingEntity.stableId }]));
      void client.readRefs({ sourceId, mask: true, entities, edges: [], aggregates: [], derived: [] }, abort.current.signal).then((result) => {
        if (abort.current.signal.aborted) return;
        if (current.current !== listKey) {
          for (const item of rows) asked.current.delete(keyOf(item));
          setDropped((count) => count + 1);
          return;
        }
        if (!result.ok) return;
        setLabels((held) => {
          const next = new Map(held);
          for (const node of result.value.nodes) next.set(`${node.ref.sourceId}\u0000${node.ref.entityType}\u0000${node.ref.stableId}`, node.display.title);
          return next;
        });
      });
    }
  }, [client, items, listKey, dropped]);

  return labels;
}
