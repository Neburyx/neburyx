/** What the upgrade test reads before and after an upgrade: one investigation, its draft and its named views, as the API answers them. */
export type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export interface SavedWork {
  readonly investigation: Read<Readonly<Record<string, unknown>>>;
  readonly draft: Read<Readonly<Record<string, unknown>>>;
  readonly views: Read<readonly Readonly<Record<string, unknown>>[]>;
}

/** The parts of an investigation record that an upgrade must keep as they were; fields a newer build adds are not compared. */
const INVESTIGATION_FIELDS = ['id', 'title', 'caseRef', 'status', 'sourceId', 'createdAt'] as const;

/** Whether everything `before` holds is in `after` with the same value; a field only `after` holds (a newer build added it) does not count. */
export function keeps(before: unknown, after: unknown): boolean {
  if (Array.isArray(before)) return Array.isArray(after) && before.length === after.length && before.every((item, index) => keeps(item, after[index]));
  if (typeof before === 'object' && before !== null) {
    if (typeof after !== 'object' || after === null || Array.isArray(after)) return false;
    const held = after as Record<string, unknown>;
    return Object.entries(before).every(([key, value]) => keeps(value, held[key]));
  }
  return Object.is(before, after);
}

function pick(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(INVESTIGATION_FIELDS.filter((field) => field in record).map((field) => [field, record[field]]));
}

/** The differences between the work saved before an upgrade and what the API answers after it, each naming what changed; none means the work is kept. */
export function compareSavedWork(before: SavedWork, after: SavedWork): readonly string[] {
  const differences: string[] = [];
  if (!before.investigation.ok || !before.draft.ok || !before.views.ok) return ['the work to compare was not read before the upgrade'];
  if (!after.investigation.ok) differences.push(`investigation: read failed after the upgrade (${after.investigation.error})`);
  else if (!keeps(pick(before.investigation.value), pick(after.investigation.value))) differences.push('investigation: the record changed');
  if (!after.draft.ok) differences.push(`draft: read failed after the upgrade (${after.draft.error})`);
  else {
    for (const field of ['version', 'layout', 'queryContext', 'notes', 'basedOnViewId']) {
      if (field in before.draft.value && !keeps(before.draft.value[field], after.draft.value[field])) differences.push(`draft document ${field}: changed`);
    }
  }
  if (!after.views.ok) differences.push(`named view: read failed after the upgrade (${after.views.error})`);
  else if (!keeps(before.views.value, after.views.value)) differences.push(`named view: the saved views changed (${before.views.value.length} before, ${after.views.value.length} after)`);
  return differences;
}

/** An image reference like `host/name:tag` as the name and the tag the compose files take apart; a reference without a tag is refused. */
export function splitReference(reference: string): { readonly image: string; readonly tag: string } {
  const colon = reference.lastIndexOf(':');
  if (colon <= 0 || colon === reference.length - 1 || reference.slice(colon).includes('/')) throw new Error(`NEBURYX_UPGRADE_FROM must be an image reference with a tag, like registry/name:tag (got "${reference}")`);
  return { image: reference.slice(0, colon), tag: reference.slice(colon + 1) };
}

/** The registry digest of an image: the `name@sha256:…` entry of `docker image inspect` that belongs to the reference's repository. */
export function digestOf(repoDigests: readonly string[], reference: string): string | undefined {
  const repository = splitReference(reference).image;
  const found = repoDigests.find((entry) => entry.startsWith(`${repository}@sha256:`));
  return found === undefined ? undefined : found.slice(found.indexOf('@') + 1);
}

/** The differences between the layout a named view was saved with (nodes, edges, camera) and the layout restoring it answers after an upgrade. */
export function compareRestoredView(savedLayout: unknown, restored: Read<unknown>): readonly string[] {
  if (!restored.ok) return [`named view: restore failed after the upgrade (${restored.error})`];
  return keeps(savedLayout, restored.value) ? [] : ['named view: the restored layout differs from the layout saved'];
}
