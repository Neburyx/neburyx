import type { EdgeRef, ElementRef, Investigation, InvestigationSourceState } from '@neburyx/contracts';
import { z } from 'zod';
import { StateError } from './errors.js';
import { sourcesOfEdgeRef, type QueryKey } from './keys.js';
import { createStore, readable, type ReadableStore } from './store.js';

/** Where the investigation stands on saving; `at` is the time of the last save, an ISO-8601 UTC string. */
export type SaveState = { readonly kind: 'saved'; readonly at: string } | { readonly kind: 'unsaved' };

export type InvestigationStatus = Investigation['status'];

export interface InvestigationRecord {
  readonly title: string;
  readonly caseRef: string | null;
  readonly status: InvestigationStatus;
  /** True for a closed or archived investigation: its draft is not written and its Save is dimmed. */
  readonly readOnly: boolean;
  /** The version the next status change or rename is guarded by. */
  readonly version: number;
  readonly save: SaveState;
  /** Whether the source is as it was when the investigation was made; a record with none is read as available. A source that was re-pointed or removed makes the investigation read-only, and nothing is read from it. */
  readonly sourceState?: InvestigationSourceState;
  /** False when the person may not delete the investigation (it is not theirs); a record with none is read as allowed. */
  readonly canDelete?: boolean;
}

export const isReadOnlyStatus = (status: InvestigationStatus): boolean => status !== 'open';

/** True for a source that was re-pointed at another database or is no longer configured. */
export const isSourceChanged = (sourceState: InvestigationSourceState | undefined): boolean => sourceState !== undefined && sourceState !== 'available';

/** What makes an investigation refuse changes: it is closed or archived, or its source changed. */
export const readOnlyOf = (status: InvestigationStatus, sourceState?: InvestigationSourceState): boolean => isReadOnlyStatus(status) || isSourceChanged(sourceState);

/** Whether an export of the investigation is dimmed: an export reads the source, so a changed source blocks it, while a closed or archived investigation still exports. */
export const exportBlockedOf = (record: Pick<InvestigationRecord, 'sourceState'> | null): boolean => record !== null && isSourceChanged(record.sourceState);

export interface InvestigationState {
  /** The investigation the server knows, when this state holds one; the development fixture has none. */
  readonly id: string | null;
  readonly sourceId: string | null;
  readonly record: InvestigationRecord | null;
  readonly resultKeys: readonly QueryKey[];
  readonly nodeRefs: readonly ElementRef[];
  readonly edgeRefs: readonly EdgeRef[];
}

export interface LoadedInvestigation {
  readonly id: string;
  readonly sourceId: string;
  readonly record: InvestigationRecord;
  readonly resultKeys: readonly QueryKey[];
  readonly nodeRefs: readonly ElementRef[];
  readonly edgeRefs: readonly EdgeRef[];
}

export interface InvestigationStore {
  readonly view: ReadableStore<InvestigationState>;
  bind(sourceId: string): void;
  /** Replaces the whole state in one update with an investigation that is already read: its record and what it holds. Refused when anything named belongs to another source. */
  load(state: LoadedInvestigation): void;
  restore(state: InvestigationState): void;
  describe(record: InvestigationRecord | null): void;
  setLoaded(resultKeys: readonly QueryKey[], nodeRefs: readonly ElementRef[], edgeRefs: readonly EdgeRef[]): void;
}

const SAVED_AT = z.string().datetime({ offset: true });

const UNBOUND: InvestigationState = { id: null, sourceId: null, record: null, resultKeys: [], nodeRefs: [], edgeRefs: [] };

export function createInvestigationStore(): InvestigationStore {
  const store = createStore<InvestigationState>(UNBOUND);
  return {
    view: readable(store),
    bind(sourceId) {
      if (store.getState().sourceId === sourceId) return;
      store.setState({ ...UNBOUND, sourceId });
    },
    restore(state) {
      store.setState(state);
    },
    load(state) {
      const named = [...state.resultKeys.map((key) => key.sourceId), ...state.nodeRefs.map((ref) => ref.sourceId), ...state.edgeRefs.flatMap(sourcesOfEdgeRef)];
      if (named.some((name) => name !== state.sourceId)) throw new StateError('SOURCE_MISMATCH');
      if (state.record.save.kind === 'saved' && !SAVED_AT.safeParse(state.record.save.at).success) throw new StateError('INVALID_TIME');
      store.setState({ ...state });
    },
    describe(record) {
      const current = store.getState();
      if (current.sourceId === null) throw new StateError('NO_SOURCE_BOUND');
      if (record?.save.kind !== 'saved') {
        store.setState({ ...current, record });
        return;
      }
      const { at } = record.save;
      if (!SAVED_AT.safeParse(at).success) throw new StateError('INVALID_TIME');
      store.setState({ ...current, record: { ...record, save: { kind: 'saved', at: new Date(at).toISOString() } } });
    },
    setLoaded(resultKeys, nodeRefs, edgeRefs) {
      const { sourceId, record } = store.getState();
      if (sourceId === null) throw new StateError('NO_SOURCE_BOUND');
      const named = [...resultKeys.map((key) => key.sourceId), ...nodeRefs.map((ref) => ref.sourceId), ...edgeRefs.flatMap(sourcesOfEdgeRef)];
      if (named.some((name) => name !== sourceId)) throw new StateError('SOURCE_MISMATCH');
      store.setState({ id: store.getState().id, sourceId, record, resultKeys, nodeRefs, edgeRefs });
    },
  };
}
