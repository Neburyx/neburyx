import type { ComponentType } from 'react';
import type { EdgeRef } from '@neburyx/contracts';
import { createOrderedRegistry, useOrdered, type Ordered, type OrderedRegistry } from '../inspector/ordered-registry.js';

export interface EvidenceKindProps {
  readonly edge: EdgeRef;
  /** Whether the personal-data fields are masked; the host knows, since the panel is also drawn on a page with no workspace. */
  readonly mask: boolean;
  /** Opens the panel on another relationship from inside it, by choice; absent in a host that cannot (the Search page). Focus goes back, on close, to what opened the panel first. */
  readonly open?: (ref: EdgeRef) => void;
}

/** One kind of relationship evidence: what recognizes its references, the line that names its ends, and the content of the panel's Evidence and Properties sub-tabs for it. */
export interface EvidenceKind extends Ordered {
  readonly matches: (ref: EdgeRef) => boolean;
  readonly Endpoints: ComponentType<EvidenceKindProps>;
  readonly Evidence: ComponentType<EvidenceKindProps>;
  readonly Properties: ComponentType<EvidenceKindProps>;
}

export type EvidenceKindRegistry = OrderedRegistry<EvidenceKind>;

export const createEvidenceKindRegistry = (): EvidenceKindRegistry => createOrderedRegistry<EvidenceKind>();
export const useEvidenceKinds = (registry: EvidenceKindRegistry): readonly EvidenceKind[] => useOrdered(registry);

/** The first kind, in order, that recognizes the reference; none when no feature builds the evidence of that form. */
export const kindOf = (kinds: readonly EvidenceKind[], ref: EdgeRef): EvidenceKind | undefined => kinds.find((kind) => kind.matches(ref));
