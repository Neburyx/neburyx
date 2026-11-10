import { useEffect, useRef, useState, type ComponentType } from 'react';
import type { EdgeRef } from '@neburyx/contracts';
import { FALLBACK_PAGE_SIZE } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { SHOW_MORE } from '../inspector/copy.js';
import type { InspectorTabProps } from '../inspector/inspector-tabs.js';
import { useClientState, useSessionMask, useVisibleGraph } from '../state/context.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { partitionEdges } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { usePreviewStoreWhenProvided } from '../workspace/preview-context.js';
import { NO_EVIDENCE_RELATIONSHIPS_DRAWN } from './copy.js';
import type { Evidence } from './evidence.js';

const formRank = (ref: EdgeRef): number => ('derived' in ref ? 2 : 'aggregate' in ref ? 1 : 0);

/** The inspector's Evidence tab: the stored relationships of the entity that are drawn, each a way to open its evidence. Client data only. */
export function evidenceTabFor(evidence: Evidence): ComponentType<InspectorTabProps> {
  return function EvidenceTab({ entity }: InspectorTabProps) {
    const state = useClientState();
    const visible = useVisibleGraph();
    const mask = useSessionMask();
    const profile = useProfileWhenProvided();
    const previews = usePreviewStoreWhenProvided();
    const target = useStoreSelector(evidence.target, (current) => current);
    const [pages, setPages] = useState(1);
    const firstNew = useRef<number | undefined>(undefined);
    const buttons = useRef<Array<HTMLButtonElement | null>>([]);
    useEffect(() => {
      const index = firstNew.current;
      if (index === undefined) return;
      firstNew.current = undefined;
      buttons.current[index]?.focus();
    }, [pages]);
    const preview = previews?.forNode(entity, mask).getState();
    const pageSize = preview?.phase === 'ready' ? preview.data.pageSize : FALLBACK_PAGE_SIZE;
    const key = elementKey(entity);
    const byKey = new Map(visible.nodes.map((node) => [elementKey(node.ref), node]));
    const rows = partitionEdges(visible).drawable.flatMap((edge) => {
      if (!evidence.offers(edge.ref) || (elementKey(edge.from) !== key && elementKey(edge.to) !== key)) return [];
      const other = byKey.get(elementKey(edge.from) === key ? elementKey(edge.to) : elementKey(edge.from));
      return other === undefined ? [] : [{ key: edgeKey(edge.ref), ref: edge.ref, type: edge.type, other }];
    }).sort((left, right) => formRank(left.ref) - formRank(right.ref));
    const typeName = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
    const shown = pages * pageSize;
    const current = target === undefined ? undefined : edgeKey(target);
    return (
      <div className="inspector-relationships">
        {rows.length === 0 ? <p>{NO_EVIDENCE_RELATIONSHIPS_DRAWN}</p> : null}
        <ul className="relationship-rows">
          {rows.slice(0, shown).map((row, index) => (
            <li key={row.key}>
              <button
                ref={(element) => void (buttons.current[index] = element)}
                type="button"
                className="relationship-row"
                aria-current={row.key === current ? 'true' : undefined}
                aria-label={`${row.type}, ${row.other.display.title} · ${typeName(row.other.ref.entityType)}`}
                onClick={(event) => {
                  state.presentation.select([row.key]);
                  evidence.open(row.ref, event.currentTarget);
                }}
              >
                <span>{row.type}</span>
                <span>{`${row.other.display.title} · ${typeName(row.other.ref.entityType)}`}</span>
              </button>
            </li>
          ))}
        </ul>
        {rows.length > shown ? (
          <button
            type="button"
            className="neighbor-types-link"
            onClick={() => {
              firstNew.current = shown;
              setPages(pages + 1);
            }}
          >
            {SHOW_MORE}
          </button>
        ) : null}
      </div>
    );
  };
}
